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
  // ★ cwm-exportcols-regress-20260919：以下兩欄係 PII，預設唔剔（見 EXPORT_COLS_DEFAULT）
  { key: 'fullName',        label: '全名' },
  { key: 'phone',           label: '聯絡電話' },
  { key: 'clinic',          label: '診所' },
  { key: 'payType',         label: '薪酬類型' },
  { key: 'workedHours',     label: '工時' },
  { key: 'otHours',         label: '加班時數' },
  { key: 'leaveDays',       label: '請假日數' },
  { key: 'absentDays',      label: '缺勤日數' },          // ★ 補返
  { key: 'basePay',         label: '基本薪資' },
  { key: 'otPay',           label: '加班費' },            // ★ 補返（錢）
  { key: 'splitPay',        label: '拆帳' },
  { key: 'deduction',       label: '扣款' },
  { key: 'sickDeduction',   label: '病假扣減' },          // ★ 補返（錢）
  { key: 'attendanceBonus', label: '勤工獎' },
  { key: 'totalAllowances', label: '津貼' },              // ★ 補返（錢）
  { key: 'maternityPay',    label: '產假/侍產假' },       // ★ 補返（錢）
  { key: 'adwAdjustment',   label: 'ADW 調整' },          // ★ 補返（錢）
  { key: 'mpf',             label: 'MPF（僱員）' },
  { key: 'mpfEmployer',     label: 'MPF（僱主）' },
  { key: 'miscAmount',      label: '雜項' },
  { key: 'storeBonus',      label: '店舖獎金' },
  { key: 'grossPay',        label: 'Gross' },
  { key: 'rsGrossAdd',      label: '離職結算加項' },
  { key: 'excessRestDeduction', label: '超額休息日扣減' },
  { key: 'tbDeduction',     label: '時間帳戶欠款扣減' },
  { key: 'tbCashout',       label: '時間帳戶折現' },
  { key: 'totalPayable',    label: '應付總額',          required: true },
]

/**
 * ★ cwm-exportcols-regress-20260919：預設 = 舊版 Excel 實際 27 欄 ＋ MPF（僱主）。
 *   ⚠️ 上一版個註釋寫「同而家 Excel 出嘅欄一致」但實際少咗八欄（五個金額欄），
 *      而且 EXPORT_COLS 根本冇嗰啲 key，連剔都剔唔返 —— 係回歸。
 *   ⚠️ fullName / phone 係 PII，【預設唔剔】—— 要就自己喺「⚙️ 匯出欄位」開。
 */
export const EXPORT_COLS_DEFAULT: string[] = [
  'employee', 'clinic', 'payType',
  'workedHours', 'otHours', 'leaveDays', 'absentDays',
  'basePay', 'otPay', 'splitPay', 'deduction', 'sickDeduction',
  'attendanceBonus', 'totalAllowances', 'maternityPay', 'adwAdjustment',
  'mpf', 'mpfEmployer', 'miscAmount', 'storeBonus',
  'grossPay', 'rsGrossAdd', 'excessRestDeduction', 'tbDeduction', 'tbCashout',
  'totalPayable',
]
