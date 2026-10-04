# 人臉驗證 - 30 天清理 Crontab

## 設定方式

在伺服器上執行 `crontab -e`，加入：

```
0 4 * * * /home/kenneth/.openclaw/workspace/clinic-workforce-mvp/scripts/clean-face-frames.sh
```

## 功能

- 每日 04:00 清理 face-service 中超過 30 天的 frame 檔案
- 清理 PunchRecord 中超過 30 天的 faceFramePath（置為 NULL）
- 記錄執行日誌到 `/tmp/face-cleanup.log`

## 注意

- 只清理 FAIL 的 frame（PASS 的 frame 本來就不會落地）
- 清理後 faceFramePath 設為 NULL，覆核頁不再顯示該紀錄
- 確認本人（confirm）的 frame 會被立即刪除，不受 30 天限制影響

## QR token 清理
`0 4 * * * <repo-root>/scripts/cleanup-qr-tokens.sh`
· 只刪過期 >1 日而且冇人用過嘅 token
· ⚠️ 有人用過嘅永遠保留（QRTokenUsage cascade）
· log: /tmp/qr-cleanup.log

## 磁碟用量警報（disk-alert）
> ⚠️ 呢行 cron 係喺**生產 host** 手動裝（repo 只存文檔，唔會自動部署）。

喺生產伺服器 `crontab -e` 加入：

```
0 8 * * * PATH=/home/clinicapp/bin:/usr/bin:/bin sh -c 'df -h / | awk "NR==2 && \$5+0>85 {print \"⚠️ 磁碟 \" \$5}"' >> /tmp/disk-alert.log
```

· 每日 08:00 檢查 root filesystem，用量 >85% 先寫入 log
· log: /tmp/disk-alert.log（可再加 mail/通知 pipe）
· 背景：2026-08-28 磁碟接近爆咗 —— docker log 未輪轉 + image 未 prune；
  配套修正已入 repo：`docker-compose.yml` 4 services 加 json-file 輪轉
  （max-size 50m × 3），`deploy.sh` build 前 `docker image prune -f`

## Lab 單據保留 purge（cwm-labdoc P1，§4.4）
> ⚠️ 呢行 cron 係喺**生產 host** 手動裝（repo 只存文檔，唔會自動部署）。

喺生產伺服器 `crontab -e` 加入：

```
30 3 * * * PATH=/home/clinicapp/bin:/usr/bin:/bin curl -fsS -X POST -H "x-cron-key: $APRICOT_CRON_KEY" http://127.0.0.1:<port>/api/internal/labdoc-purge >> /tmp/labdoc-purge.log
```

· 每晚 03:30 跑一次：`purgeAt = uploadedAt + 7 年` 到期嘅 LabFile 逐個刪碟上全部 key（原檔＋顯示圖＋縮圖，AES-256-GCM 加密落地）→ `purgedAt = now`
· 單據**所有頁**檔都 purged 先清 PII 姓名欄（`extractedJson`／行 `patientNameRaw`／P3 `patientRaw`）；**金額、單號、病人編號、配對紀錄保留**
· 孤兒檔 sweep（碟有、DB 冇、>24h）併入同一 cron（§4.1；gen1 決定 4）
· 冪等：逐個檔條件 commit，中途死咗下次接住做；audit `LAB_DOC_IMAGE_PURGE`（只數量，零姓名）
· P2 新增：`*/5 * * * * curl -fsS -X POST -H "x-cron-key: $APRICOT_CRON_KEY" http://127.0.0.1:<port>/api/internal/labdoc-sweep`（讀單 heartbeat sweep）

## Lab 單據 volume 備份（§4.5）

· `backup.sh`（02:00，現行）已內含 labdoc 步：`rclone copy $LAB_DOC_VOLUME_PATH offsite:clinic-backups/lab-docs/`
  - `LAB_DOC_VOLUME_PATH` = host 上 `lab_docs` volume 嘅實際路徑（compose named volume，名跟 project 前綴，通常 `/var/lib/docker/volumes/clinic_lab_docs/data` — 實際以 `docker volume ls` 為準），喺 crontab／`.env` 設一次
  - **copy 唔用 sync**（防誤刪傳播）；每月 1 號額外 `rclone sync --max-delete 500`，令已到期 purge 嘅檔喺 offsite 都同步刪（跟 7 年保留）
  - 檔已加密落地，唔使再 age；🔴 `LAB_DOC_ENC_KEY` 要同 `APRICOT_ENC_KEY` 一樣**離線另存一份**——冇 key 備份檔冇用
· 容量估算：每日約 30 張 × 0.6 MB ≈ 18 MB/日 ≈ 6.5 GB/年 ≈ 45 GB/7 年 → 上面嘅 disk-alert（08:00）照用
· Restore drill：`scripts/restore-drill.sh` 已內含 labdoc 段——隨機抽 5 個未 purge 嘅 LabFile，由備份源拉返、解密、比 sha256（`LAB_DOC_BACKUP_SOURCE` 指本地目錄可離 offsite drill）
