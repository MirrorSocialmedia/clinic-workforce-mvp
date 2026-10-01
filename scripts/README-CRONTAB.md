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
0 3 * * * /home/clinicapp/clinic/scripts/clinical-index.sh nightly
```

- ★ 2026-10-01 更正：舊版寫 host `curl 127.0.0.1:3000` —— **生產 host 冇 map app port，打唔到**。
  改用 `scripts/clinical-index.sh`（同 `sync-availability.sh` 一樣 `docker exec` 入 container 打；
  key 由 container env 讀，唔使喺 host 擺 secret）。log：`/tmp/clinical-index-nightly.log`。
- 守門：key 未設 = `503`、唔啱 = `403`（fail closed）。

## 2. 回填（backfill — 一次性 365 日 / 4 晚）

**建議 cron 行**（03:30 起，避開夜跑）：

```cron
30 3 * * * /home/clinicapp/clinic/scripts/clinical-index.sh backfill
```

- 每晚跑 ≤90 日（cursor 自動續）；護欄 maxCalls=30,000 + maxHours=4。
- **收工（回傳 `status:"DONE"`）→ 即刻刪呢行 cron**（§0）。
- **重開新一輪**（特殊需要先）：`?restart=1`（cron key 守門之内先有效）：

```bash
docker exec clinic-prod-app node -e "fetch('http://localhost:3000/api/internal/clinical-index-backfill?restart=1',{method:'POST',headers:{'x-cron-key':process.env.APRICOT_CRON_KEY}}).then(async r=>console.log(r.status, await r.text()))"
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
# 喺 container 入面打（host 冇 map port）；EXTERNAL_KEY 用你手上嗰條 external key
docker exec -e EXTERNAL_KEY="$EXTERNAL_KEY" clinic-prod-app node -e "fetch('http://localhost:3000/api/external/v1/clinical-index/status',{headers:{'x-api-key':process.env.EXTERNAL_KEY}}).then(r=>r.text()).then(console.log)"
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

## 4b. 青衣（第二個 Apricot 帳號 TY）— cwm-apricotty-20261001

青衣係另一個 Apricot 帳號（另一套登入 cookie）。店級 sync（時間表／可約時段／預約索引／收款）
**唔使加 cron** — 現有 `sync-availability.sh` 已經逐店跑，青衣店會自動用 TY token。
只有「按日子掃全帳號」嘅臨床索引要另加（**等 wa-inbox 上線先開**）：

```cron
# 青衣臨床索引夜跑（錯開原帳號 03:00）
15 4 * * * /home/clinicapp/clinic/scripts/clinical-index.sh nightly TY
# 青衣 12 個月回填（一次性；log 見到 "status":"DONE" 即刻刪呢行）
45 4 * * * /home/clinicapp/clinic/scripts/clinical-index.sh backfill TY
```

- 兩個帳號共用同一把 job 鎖（NIGHTLY=776003 / BACKFILL=776002）同 Apricot 全局鎖（776001）— 時間要錯開，撞到 = `409`。
- log：`/tmp/clinical-index-nightly-ty.log`、`/tmp/clinical-index-backfill-ty.log`
- 進度：`/api/external/v1/clinical-index/status` 嘅 `accounts[]`（頂層欄位仍然係原帳號）。

**啟用步驟（一次性）：**
1. 寫入青衣 token —— **喺 host 跑，經 stdin 將 script 傳入 container**
   （生產 image 係 Next standalone，container 入面冇 `scripts/`；`APRICOT_ENC_KEY`／`DATABASE_URL` 用 container env）：
   ```bash
   docker exec clinic-prod-app ls node_modules/@prisma/client >/dev/null && echo ok   # 有 ok 先繼續
    docker exec -i clinic-prod-app node --input-type=module - \
     --access '…' --refresh '…' --iat '…' --account TY \
     < /home/clinicapp/clinic/scripts/apricot-set-token.mjs
   # 前面加空格 = 唔入 shell history（HISTCONTROL=ignorespace 時）
   docker exec clinic-prod-db psql -U clinic -d clinic_prod -c 'SELECT provider, "lastOkAt", "lastError" FROM "ExternalCredential";'
   # 應該見到 APRICOT + APRICOT:TY 兩行
   ```
   **唔使重啟 app** —— token 每次 call 都由 DB 讀（冇 memory cache）。
2. 店舖管理 → 青衣：填 Apricot 診所 ID、帳號 `TY`、月結起計月份（例如 `2026-11`）
   ⚠️ 一定要喺第 1 步之後 —— 未有 token 就填 ID，每次 sync 青衣都會記 `APRICOT_NOT_CONFIGURED`。
3. 確認：下一次 `sync-availability.sh`（最多 10 分鐘）之後睇 `/tmp/availability-sync.log`，青衣嗰行冇 `error`
4. 收款同步（青衣店）同其他店一樣跑；月結起計月份之前嘅月份會被 gate 擋住（之前人手處理）
5. 「未綁帳號」頁：將青衣出現嘅醫生 practitioner 綁返現有醫生（同一個醫生可以有兩個帳號）
6. （wa-inbox 上線後）加上面兩行 cron

## 4c. 預約狀態追更（sync-availability-history）— 2026-10-01 補

`sync-availability.sh` 只同步【今日起】嘅預約；一張單過咗當日之後再改狀態
（已完成 4／取消 −7／爽約 −3／改期 102 — 例如翌日先補 mark 到診），本系統唔會知。
`sync-availability-history.sh` 每晚掃【7 日前 → 昨日】補返呢啲狀態（只寫預約索引，唔郁時間表／可約時段）。

```cron
# 預約狀態追更（-7 日 → 昨日）
30 3 * * * /home/clinicapp/clinic/scripts/sync-availability-history.sh
```

- ⚠️ 用 **03:30** 唔好用 03:00：`sync-availability.sh` 夜間每個鐘 `:00` 跑，兩個撞正 = 共用 Apricot 鎖，後到嗰個會 skip。
- cron 跟 host 時區：先 `date` 確認係 HKT（現有 `*/10 8-20` 都係按 HKT 寫）。
- log：`/tmp/availability-sync-history.log`
- 2026-10-01 對照：生產 crontab **未有**呢行（見 §5）。

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
| sync-availability-history | **無**（2026-10-01 發現） | ⚠️ 過咗當日嘅預約狀態唔會更新 — 建議加（§4c，03:30） |

**啟用 clinical-index cron 時嘅注意（新）**：
- 建議嘅 nightly 03:00 / backfill 03:30 時段**同 sync-availability 每小時行重疊** — FX-30 嘅 APRICOT 鎖 + `PAUSED_BUSY` 重試設計正正處理呢個爭用（cursor 唔前進、第二晚續），可接受；但啟用後首幾晚留意 `/var/log/clinical-index-*.log` 有無連續 `PAUSED_BUSY`。
- key 傳法跟足既有模式：走 script（`sync-availability.sh`／`clinical-index.sh` — docker exec 讀 container env）— **唔好硬編碼入 crontab**，亦唔好用 host curl（冇 map port，§1）。
