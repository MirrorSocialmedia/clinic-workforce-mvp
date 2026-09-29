# README-CRONTAB — workforce 生產機 crontab 指南（clinical-index 回填／夜跑）

> cwi-qa FX-30（QA-30）— 2026-09-28
>
> 本文只寫「已知結構」。**生產機 crontab 實際輸出：待貼**（老細 `crontab -l` 後補入文末對照表）。
> 在對照表補齊之前，唔好憑本文假設生產機而家有冇呢兩行 cron。

## 0. 鐵則（FX-30 之後）

| 動作 | 方法 | 注意 |
|---|---|---|
| **開**（回填） | crontab 加一行 curl（見 §2）或手動 curl | 程式**冇開關**，亦**唔會因為 deploy 自動開始** — 只會喺有人 POST `/api/internal/clinical-index-backfill` 時跑 |
| **開**（夜跑） | crontab 加一行 curl（見 §1） | 每晚 03:00 |
| **停** | **刪 cron 行** | ❌ 唔好靠刪 `APRICOT_CRON_KEY` — 5 條 internal route 共用（clinical-index-nightly / clinical-index-backfill / sync-availability / sync-availability-history / apricot/sync/cron），刪咗連夜跑 + availability sync 一齊停 |
| **防雙跑** | 自動（FX-30） | 兩條 endpoint 各有一把 job 級 advisory lock（BACKFILL=776002、NIGHTLY=776003）— 並發（cron + 手動 curl）第二個 → `409 ALREADY_RUNNING` |
| **回填收工** | DONE 即刻**刪 cron 行** | FX-30 之後 `DONE` 唔會自動開新一輪（要 `?restart=1`）— 舊口徑係每 5 晚重跑全年（每晚最多 3 萬次 Apricot call + 300 次 LLM） |

## 1. 夜跑（nightly）

**建議 cron 行**（03:00 起；一晚通常 < 1 小時）：

```cron
0 3 * * * curl -sS -X POST -H "x-cron-key: $APRICOT_CRON_KEY" http://127.0.0.1:3000/api/internal/clinical-index-nightly >> /var/log/clinical-index-nightly.log 2>&1
```

- `$APRICOT_CRON_KEY` 唔好寫死喺 crontab — 用 `~/.profile`／dotenv source 或者獨立 secret 檔（crontab 冇 shell env）。
- 守門：key 未設 = `503`、唔啱 = `403`（fail closed）。

## 2. 回填（backfill — 一次性 365 日 / 4 晚）

**建議 cron 行**（03:30 起，避開夜跑）：

```cron
30 3 * * * curl -sS -X POST -H "x-cron-key: $APRICOT_CRON_KEY" http://127.0.0.1:3000/api/internal/clinical-index-backfill >> /var/log/clinical-index-backfill.log 2>&1
```

- 每晚跑 ≤90 日（cursor 自動續）；護欄 maxCalls=30,000 + maxHours=4。
- **收工（回傳 `status:"DONE"`）→ 即刻刪呢行 cron**（§0）。
- **重開新一輪**（特殊需要先）：`?restart=1`（cron key 守門之内先有效）：

```bash
curl -sS -X POST -H "x-cron-key: $APRICOT_CRON_KEY" "http://127.0.0.1:3000/api/internal/clinical-index-backfill?restart=1"
```

- 已有 `DONE` job 而未 `?restart=1` → 回 `200 { "status": "ALREADY_DONE", ... }`，唔會開新輪、唔會打 Apricot。

## 3. 進度同狀態

**回填進度（DB 直查）**：

```sql
SELECT status, "cursorDate", "rangeFrom", "rangeTo", patients, "apiCalls", errors, "lastError", "startedAt", "finishedAt"
FROM "ClinicalIndexJob"
WHERE kind = 'BACKFILL'
ORDER BY "startedAt" DESC;
```

**API 口徑**（external key，scope `patients`）：

```bash
curl -sS -H "x-api-key: $EXTERNAL_KEY" http://127.0.0.1:3000/api/external/v1/clinical-index/status
```

回傳 `backfill` 欄：`status / cursorDate / daysTotal / daysDone / progressPct / patients / apiCalls / errors / lastError / startedAt / finishedAt`。

**status 口徑（FX-30）**：

| 值 | 意思 |
|---|---|
| `RUNNING` + 新 | 正常進行中 |
| `FAILED` + `lastError = ABANDONED (stale RUNNING > 6h)` | 殘留（deploy 殺 request 未走完 finally）— 下晚夜跑會自動補掃嗰日；status API 亦將 RUNNING > 6h 直接回報當 FAILED |
| `ALREADY_DONE`（回傳，唔係 job status） | 回填已收工，未 `?restart=1` |
| `PAUSED_BUSY`（回傳） | APRICOT 鎖 20 次重試攞唔到（同 sync／落單搶鎖）— cursor 唔前進，第二晚續 |
| `PAUSED_RATE_LIMITED` / `PAUSED_AUTH`（回傳） | 限速／認證 — cursor 唔前進，第二晚續 |

## 4. 時段注意（🔴 部署窗口）

- 夜跑 03:00 起；回填 03:30 起**最多 4 小時**（maxHours 護欄）。
- **03:00–07:00 唔好跑 `deploy.sh`**（`up -d app` 殺 request → job 中斷）。
  - 回填：cursor 已落 DB，第二晚自動續 — 可接受。
  - 夜跑：FX-30 會標 ABANDONED + 下晚補掃 — 可接受，但會多一晚 delay。
  - 最穩：部署選 07:00 之後。
- **唔好同時手動 curl + cron 打同一 endpoint**（FX-30 之後第二個 = 409 安全失敗，但唔好依賴呢個）。

## 5. 生產機 crontab 實彈輸出（對照表）

> ✅ **已回填**（老細 2026-09-28 18:2x 貼生產機 `crontab -l` 實彈）。

```cron
# 醫生時間表 Apricot 同步 —— 辦公時間 10 分鐘、其餘每小時
*/10 8-20 * * * /home/clinicapp/clinic/scripts/sync-availability.sh
0 21-23,0-7 * * * /home/clinicapp/clinic/scripts/sync-availability.sh
0 4 * * * /home/clinicapp/clinic/scripts/cleanup-qr-tokens.sh >> /tmp/qr-cleanup.log 2>&1
```

**審計結論（2026-09-28）**：

| 對照項 | 生產機現況 | 判定 |
|---|---|---|
| clinical-index-nightly 行 | **無** | ✅ 符合 spec（「唔會因為 deploy 自動開始」— 尚未啟用，屬預期） |
| clinical-index-backfill 行 | **無** | ✅ 符合 spec（尚未啟用；啟用 = 一次性 4 晚，收工即刪，見 §2） |
| sync-availability（既有） | 8–20 點每 10 分鐘 + 其餘時段每小時 | ℹ️ 既有行，經 shell script 傳 key（唔係硬編碼）— 符合 §1 口徑 |
| cleanup-qr-tokens（既有） | 每日 04:00 | ℹ️ 同 clinical-index 無關 |

**啟用 clinical-index cron 時嘅注意（新）**：
- 建議嘅 nightly 03:00 / backfill 03:30 時段**同 sync-availability 每小時行重疊** — FX-30 嘅 APRICOT 鎖 + `PAUSED_BUSY` 重試設計正正處理呢個爭用（cursor 唔前進、第二晚續），可接受；但啟用後首幾晚留意 `/var/log/clinical-index-*.log` 有無連續 `PAUSED_BUSY`。
- key 傳法跟足既有模式：走 script（如 `sync-availability.sh`）或者 `~/.profile` source — **唔好硬編碼入 crontab**（§1）。
