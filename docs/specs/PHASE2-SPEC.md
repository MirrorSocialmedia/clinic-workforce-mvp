# 階段 2 — 入職與員工檔案（1 週）

**Kairo Task**: `mr7meczx9lzzx` | **分支**: `phase2/employee-profiles`

## 目標

讓每個員工帶著「他的計薪規則」進入系統，後面編更/計糧才有依據。

## 功能範圍

### 1. 員工管理

- 新增員工：基本資料、所屬分店、角色、到職日
- 編輯員工資訊
- 離職處理：標記離職日，保留歷史記錄
- 批量匯入（Excel CSV）

### 2. 薪酬規則管理

- 綁定薪酬規則（引用階段 0 的規則）
- 薪酬類型：月薪 / 日薪 / 時薪 / 拆帳
- 對應數值：月薪額 / 日薪額 / 時薪額 / 拆帳比例
- 加班規則：倍率、閾值
- **歷史版本**：`effective_from` + `effective_to`，加薪時保留舊規則

### 3. 跨店人員池

- 員工可屬于多家診所（`EmployeeClinic` 多對多）
- 主診所 vs 副診所
- 調動記錄

### 4. 員工檔案 UI

- 員工列表頁（篩查：診所、角色、狀態）
- 員工詳細頁（基本資料 + 薪酬規則歷史 + 跨店記錄）
- 新增/編輯員工表單
- 薪酬規則管理表單

## API Routes

```
GET    /api/employees             # 員工列表
POST   /api/employees             # 新增員工 (OWNER/MANAGER)
GET    /api/employees/:id         # 員工詳情
PUT    /api/employees/:id         # 編輯員工 (OWNER/MANAGER)
POST   /api/employees/:id/pay-rules  # 新增薪酬規則 (OWNER)
POST   /api/employees/import      # 批量匯入 (OWNER)
GET    /api/employees/:id/pay-history  # 薪酬規則歷史
```

## 驗收標準

- [ ] 能新增一名醫生（拆帳）、一名護士（時薪+加班）、一名前台（月薪），各自規則正確綁定
- [ ] 給某員工加薪（新增一條 `effective_from` 較晚的規則），計上月薪資仍用舊規則
- [ ] 離職員工不出現在新排班選單，但歷史記錄仍在
- [ ] 跨店員工可在不同診所被排班
- [ ] 批量匯入 CSV 成功

## 技術細節

- Prisma Schema 已在階段 1 完成，直接使用
- 薪酬規則存於 `PayRule` 表，`configJson` 欄位存可配置參數
- 離職處理：`Employee.status = RESIGNED` + `leaveDate`，**不刪除記錄**
- CSV 匯入：使用 `csv-parser` 或原生解析

## 注意事項

- 所有規則可配置，不寫死
- 離職員工保留歷史，不刪除
- 薪酬規則變動保留歷史版本
