# 階段 4 — 考勤（防竄改核心，2-3 週）

**Kairo Task**: `mr7meczx9lzzx` | **分支**: `phase4/attendance`

## 目標

做出「原始打卡誰都改不了、所有修正全留痕、院長一眼看到誰動過什麼」的考勤系統。

## 功能範圍

### 1. 打卡系統（動態 QR 碼）

- 診所端：顯示動態 QR 碼（30 秒刷新）
- 員工端：手機掃碼打卡（PWA 鏡頭）
- Token 機制：店鋪 ID + 時間戳 + 隨機 token，30 秒失效
- 防偽：翻拍舊碼無效
- 可選開關：固定碼模式（防偽較弱但簡便）

### 2. Append-Only 原始記錄

- `PunchRecord` 表：寫入後 **永不 UPDATE/DELETE**
- 記錄：員工、時間、診所、上下班、token 驗證結果
- 資料庫層 + API 層雙重保護

### 3. 修正用疊加，不覆蓋

- 忘打卡/機器故障 → 員工發起「補打卡申請」
- 主管審批 → 寫入 `PunchCorrection`（引用原始記錄）
- 原始事實永遠查得到
- 修改歷史畫面：院長看完整鏈

### 4. 每日雜湊

- 每日收盤：當日所有打卡記錄算 hash
- 存於 `DailyHash` 表
- 改動後可重算比對

### 5. 考勤 UI

- 打卡頁（員工端，PWA）
- 考勤記錄頁（管理端，篩查 + 修改鏈）
- 補打卡申請面板
- 每日雜湊顯示

## API Routes

```
POST   /api/punch                # 打卡（掃碼驗證）
GET    /api/punches              # 考勤列表（篩查）
GET    /api/punches/:id          # 單筆詳情 + 修改鏈
POST   /api/punch-corrections    # 補打卡申請
PUT    /api/punch-corrections/:id # 審批補打卡 (OWNER/MANAGER)
GET    /api/qr-tokens            # QR 碼 token（診所端）
POST   /api/daily-hash           # 每日雜湊（自動/手動）
GET    /api/daily-hash/:date     # 雜湊查詢
```

## 驗收標準

- [ ] 員工掃有效 QR 碼打卡，記錄即時出現
- [ ] 翻拍舊碼 → 系統拒絕（token 失效）
- [ ] 固定碼模式正常工作
- [ ] 無法直接修改/刪除 PunchRecord（核心驗收）
- [ ] 補打卡走完申請→審批→顯示完整修改鏈
- [ ] 每日雜湊生成，可重算比對
- [ ] `npm run build` 通過

## 技術細節

- QR 碼生成：`qrcode` npm package
- Token 驗證：JWT/加密 token，30 秒過期
- Hash：SHA-256，按診所+日期分組
- PunchRecord：API 層不提供 UPDATE/DELETE

## 注意事項

- PunchRecord 是核心賣點，必須做穩
- 審計日誌自動記錄（階段 1 middleware）
- QR token 需要伺服器時間同步
