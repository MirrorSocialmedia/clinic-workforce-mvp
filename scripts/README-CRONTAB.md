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

## 6. Lab 單據（cwm-labdoc P1，P4 補 sweep/disk-alert）— 保留 purge、讀單 sweep、volume 備份

> ⚠️ 呢啲 cron 係喺**生產 host** 手動裝（repo 只存文檔）。生產 host **冇 map app port**（§1）——
> 唔好用 host `curl 127.0.0.1:<port>`；要 `docker exec` 入 `clinic-prod-app` 打，key 由 container env 讀。

**保留 purge（§4.4，每晚 03:30）**：

```cron
# Lab 單據 7 年到期刪檔＋孤兒檔 sweep（spec §4.4 定 03:30；P4 起對齊 spec）
30 3 * * * docker exec clinic-prod-app node -e "fetch('http://localhost:3000/api/internal/labdoc-purge',{method:'POST',headers:{'x-cron-key':process.env.APRICOT_CRON_KEY}}).then(async r=>console.log(new Date().toISOString(), r.status, await r.text()))" >> /tmp/labdoc-purge.log 2>&1
```

> ℹ️ P1 曾寫 03:45（避 03:30 嘅 sync-availability-history）；spec §4.4／§11 一直係 03:30，P4 改返 03:30 對齊。現行生產 03:30 無已啟用 cron（sync-availability-history 屬建議未裝；clinical-index-backfill 一次性收工即刪）——日後若喺 03:30 啟用 sync-availability-history，兩 cron 可並行（purge 冪等、APRICOT 鎖域獨立），或將 availability-history 挪 03:20。

**讀單 heartbeat sweep（§5.1，每 5 分鐘）**：

```cron
# Lab 讀單 heartbeat：EXTRACTING 卡死重試 / 孤兒檔清理（冪等；P2 新增）
*/5 * * * * docker exec clinic-prod-app node -e "fetch('http://localhost:3000/api/internal/labdoc-sweep',{method:'POST',headers:{'x-cron-key':process.env.APRICOT_CRON_KEY}}).then(async r=>console.log(new Date().toISOString(), r.status, await r.text()))" >> /tmp/labdoc-sweep.log 2>&1
```

- `purgeAt = uploadedAt + 7 年` 到期嘅 LabFile 逐個刪碟上全部 key（原檔＋顯示圖＋縮圖，AES-256-GCM 加密落地）→ `purgedAt = now`
- 單據**所有頁**檔都 purged 先清 PII 姓名欄（`extractedJson`／行 `patientNameRaw`／P3 `patientRaw`）；**金額、單號、病人編號、配對紀錄保留**
- 孤兒檔 sweep（碟有、DB 冇、>24h）併入同一 cron（§4.1）
- 冪等：逐個檔條件 commit，中途死咗下次接住做；audit `LAB_DOC_IMAGE_PURGE`（只數量，零姓名）

**disk-alert（08:00，P4 補）**：

```cron
# disk-alert：docker 所喺碟 >85% → 入 log（lab_docs 7 年 ≈ 45GB 基線；詳細容量看 GET /api/lab-docs/stats）
0 8 * * * df -P /var/lib/docker | awk 'NR==2{u=$5+0; if (u>85) print "[disk-alert] " strftime("%F %T") " docker disk " $5 " (>85%) — lab_docs 7年≈45GB，睇 /api/lab-docs/stats 容量"; else print "[disk-ok] " strftime("%F %T") " docker disk " $5}' >> /tmp/disk-alert.log 2>&1
```

- 容量口徑（spec §5）：每日約 30 張 × 0.6 MB ≈ 18 MB/日 ≈ 6.5 GB/年 ≈ 45 GB/7 年
- P4 起 `GET /api/lab-docs/stats`（lab_statement）回未 purge 檔案總容量＋各狀態數量——設定頁頂部容量統計卡同用；disk-alert 觸發後可開設定頁對容量分佈

**Volume 備份（§4.5）**：

- `backup.sh`（02:00，現行）已內含 labdoc 步：`rclone copy $LAB_DOC_VOLUME_PATH offsite:clinic-backups/lab-docs/`
  - `LAB_DOC_VOLUME_PATH` = host 上 `lab_docs` volume 嘅實際路徑（compose named volume，名跟 project 前綴，通常 `/var/lib/docker/volumes/clinic_lab_docs/_data` — 實際以 `docker volume inspect` 為準），喺 crontab／`.env` 設一次
  - **copy 唔用 sync**（防誤刪傳播）；每月 1 號額外 `rclone sync --max-delete 500`，令已到期 purge 嘅檔喺 offsite 都同步刪（跟 7 年保留）
  - 檔已加密落地，唔使再 age；🔴 `LAB_DOC_ENC_KEY` 要同 `APRICOT_ENC_KEY` 一樣**離線另存一份**——冇 key 備份檔冇用
- 容量估算：每日約 30 張 × 0.6 MB ≈ 18 MB/日 ≈ 6.5 GB/年 ≈ 45 GB/7 年 → 睇「disk-alert（08:00）」（P4 補）
- Restore drill：`scripts/restore-drill.sh` 已內含 labdoc 段——隨機抽 5 個未 purge 嘅 LabFile，由備份源拉返、解密、比 sha256（`LAB_DOC_BACKUP_SOURCE` 指本地目錄可離 offsite drill）
