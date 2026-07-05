# 階段 6 — 計糧（3-4 週）

**Kairo Task**: `mr7meczx9lzzx` | **分支**: `phase6/payroll`

## 目標

把編更+考勤+假期數據，經參數化規則引擎，算出每人應付薪資。

## 功能範圍

### 1. 參數化計薪引擎
- 月薪：固定 + 缺勤/請假調整
- 時薪：Σ(實際工時 × 時薪) + 加班
- 日薪：Σ(出勤日 × 日薪)
- 拆帳（醫生）：診金 × 比例

### 2. 工時來源
- 以補正後考勤為準（原始+合法補登）
- 跨店合併

### 3. 輸出
- 每人月度明細（工時/加班/請假/應付薪資）
- Excel/PDF 糧單匯出
- 考勤異常報表

### 4. 資料庫
```prisma
model PayrollRun {
  id           String   @id @default(cuid())
  clinicId     String
  periodMonth  DateTime
  status       String   // DRAFT, FINALIZED, EXPORTED
  generatedAt  DateTime
  items        PayrollItem[]
}

model PayrollItem {
  id           String   @id @default(cuid())
  runId        String
  run          PayrollRun @relation(fields: [runId], references: [id])
  employeeId   String
  workedHours  Float
  otHours      Float
  leaveDays    Float
  basePay      Float
  otPay        Float
  splitPay     Float?
  totalPayable Float
  detailJson   Json?
  createdAt    DateTime @default(now())
}
```

## 驗收標準
- [ ] 真實數據跑一遍，total_payable 與會計手算逐人對得上
- [ ] 醫生拆帳/護士時薪+加班/前台月薪各自算對
- [ ] 跨店員工工時正確合併
- [ ] 糧單 PDF + 異常報表生成
- [ ] `npm run build` 通過
