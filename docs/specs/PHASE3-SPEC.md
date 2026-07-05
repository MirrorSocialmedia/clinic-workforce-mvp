# 階段 3 — 編更/排班（3-4 週）

**Kairo Task**: `mr7meczx9lzzx` | **分支**: `phase3/scheduling`

## 目標

解決院長每週手動排班的痛，支援跨店調度、頂更/轉更、規則校驗。

## 功能範圍

### 1. 排班管理

- 週/月視圖班表
- 拖放排班：員工 × 分店 × 日期 × 時段
- 更次模板：預設常用班（早更/全日/夜更），可批量套用
- 手動新增/刪除/編輯班次

### 2. 規則校驗（即時檢查）

- 同一員工同時段撞更 → 擋下（紅色警告）
- 某分店某時段未滿足硬規則（如"至少 1 護士"）→ 黃色警示
- 跨夜更、連續上班超時 → 警示
- 規則參數來自階段 0 的 `shift-rules.json`，可配置

### 3. 頂更/轉更/報更

- 員工發起"換更申請" → 對象同意 → 主管審批 → 生效
- 每步寫入 audit_log
- 申請狀態追蹤：pending → approved → completed / rejected

### 4. 跨店調度

- 同一員工可被排到不同分店
- 記錄當日在哪店

### 5. 排班 UI

- 班表主頁（週/月切換）
- 拖放排班組件
- 規則校驗提示
- 更次模板選擇
- 頂更/轉更申請面板

## API Routes

```
GET    /api/shifts                # 班次列表（日期/診所/員工篩查）
POST   /api/shifts                # 新增班次 (OWNER/MANAGER)
PUT    /api/shifts/:id            # 編輯班次 (OWNER/MANAGER)
DELETE /api/shifts/:id            # 刪除班次 (OWNER/MANAGER)
POST   /api/shifts/validate       # 規則校驗（拖放後即時檢查）
GET    /api/shifts/templates      # 更次模板列表
POST   /api/shifts/templates      # 新增模板 (OWNER)
POST   /api/shift-changes         # 發起頂更/轉更申請
PUT    /api/shift-changes/:id     # 審批申請 (OWNER/MANAGER)
GET    /api/shifts/my-schedule    # 當前員工班表
```

## 驗收標準

- [ ] 院長排出下個月一間分店的完整班表
- [ ] 撞更自動擋下並提示
- [ ] 缺護警示出現
- [ ] 轉更走完同意→審批，班表更新，audit_log 完整記錄
- [ ] 規則參數可配置（不寫死）
- [ ] `npm run build` 通過

## 技術細節

- 班表 UI 可使用自訂拖放組件（無第三方依賴）
- 規則校驗引擎：讀 `shift-rules.json` 配置，即時檢查
- Shift 表已在 Prisma schema 中定義

## 注意事項

- MVP 先做手動排班 + 規則校驗 + 頂轉更
- 自動建議替補 → v2，先不做
- 拖放 UX 保持簡單
