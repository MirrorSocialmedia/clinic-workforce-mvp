// ============================================================
// ★ cwm-payrollcols-20260918 B3：匯出欄位設定（Excel）
//
// 拍板②：匯出欄位同畫面「顯示欄位」（Company.payrollViewJson）分兩份，唔共用。
// 儲存：Company.payrollExportCols（JSON array string；null = 用 DEFAULT）。
// ⚠️ 設定只影響【欄】，唔影響【行】（行過濾 = getConfidentialScope，祕密員工照樣濾）。
// PDF 版面固定八欄，唔跟呢個設定（B3-5）。
// ============================================================

// ⚠️ 唔用 `as const` — union type 會令非 required 成員冇 `required` 屬性，consumer 處 `o.required` 過唔到 tsc。
//    語義一樣（固定清單），data 逐字同施工單一致。
export interface ExportCol {
  key: string
  label: string
  required?: boolean
}

export const EXPORT_COLS: ExportCol[] = [
  { key: 'employee',        label: '員工',              required: true },
  { key: 'clinic',          label: '診所' },
  { key: 'payType',         label: '薪酬類型' },
  { key: 'workedHours',     label: '工時' },
  { key: 'otHours',         label: '加班時數' },
  { key: 'leaveDays',       label: '請假日數' },
  { key: 'basePay',         label: '基本薪資' },
  { key: 'splitPay',        label: '拆帳' },
  { key: 'attendanceBonus', label: '勤工獎' },
  { key: 'storeBonus',      label: '店舖獎金' },        // ★ 新
  { key: 'deduction',       label: '扣款' },
  { key: 'grossPay',        label: 'Gross' },
  { key: 'mpf',             label: 'MPF（僱員）' },      // ★ 新
  { key: 'mpfEmployer',     label: 'MPF（僱主）' },      // ★ 新
  { key: 'rsGrossAdd',      label: '離職結算加項' },
  { key: 'excessRestDeduction', label: '超額休息日扣減' },
  { key: 'tbDeduction',     label: '時間帳戶欠款扣減' },
  { key: 'tbCashout',       label: '時間帳戶折現' },
  { key: 'miscAmount',      label: '雜項' },
  { key: 'totalPayable',    label: '應付總額',          required: true },
]

/** 冇設定時嘅預設（同而家 Excel 出嘅欄一致 ＋ MPF 兩欄 ＋ 店舖） */
export const EXPORT_COLS_DEFAULT: string[] = [
  'employee','clinic','payType','workedHours','otHours','leaveDays',
  'basePay','splitPay','attendanceBonus','storeBonus','deduction',
  'grossPay','mpf','mpfEmployer','miscAmount','totalPayable',
]
