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
