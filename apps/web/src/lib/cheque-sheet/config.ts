// ============================================================
// ★ cwm-chequetpl-20261004：出糧總表自訂模版 —— 欄目錄＋設定（純函數，前後端共用）
//
// 老闆拍板：
//   ① 只改出糧總表 Excel；計糧／明細／PDF 全部唔郁
//   ② 模版只限老闆（設定同使用）；其他人匯出 = LEGACY_CONFIG（同改之前一模一樣）
//   ③ 新模版預設：按【出糧診所】分組、每組小計、每組一張 Sheet
// ============================================================

export type ColKind = 'text' | 'money' | 'num' | 'cheque'

export interface SheetCol {
  key: string
  /** 設定頁顯示嘅名 */
  label: string
  /** 預設表頭（Excel 第一行） */
  header: string
  kind: ColKind
}

export const SHEET_COLS: SheetCol[] = [
  { key: 'nickname',            label: '暱稱',                header: '暱稱',           kind: 'text' },
  { key: 'fullName',            label: '全名',                header: 'Full Name',      kind: 'text' },
  { key: 'homeClinic',          label: '所屬診所（計糧單）',  header: '所屬診所',       kind: 'text' },
  { key: 'payerClinic',         label: '出糧診所',            header: '出糧診所',       kind: 'text' },
  { key: 'payType',             label: '薪酬類型',            header: '薪酬類型',       kind: 'text' },
  { key: 'basicSalary',         label: '底薪（月薪／時薪）',  header: 'B.Basic Salary', kind: 'money' },
  { key: 'workedHours',         label: '工時',                header: '工時',           kind: 'num' },
  { key: 'otHours',             label: '加班時數',            header: '加班時數',       kind: 'num' },
  { key: 'leaveDays',           label: '請假日數',            header: '請假日數',       kind: 'num' },
  { key: 'absentDays',          label: '缺勤日數',            header: '缺勤日數',       kind: 'num' },
  { key: 'basePay',             label: '基本薪資',            header: '基本薪資',       kind: 'money' },
  { key: 'otPay',               label: '加班費',              header: '加班費',         kind: 'money' },
  { key: 'splitPay',            label: '拆帳',                header: '拆帳',           kind: 'money' },
  { key: 'deduction',           label: '扣款',                header: '扣款',           kind: 'money' },
  { key: 'sickDeduction',       label: '病假扣減',            header: '病假扣減',       kind: 'money' },
  { key: 'attendanceBonus',     label: '勤工獎',              header: '勤工獎',         kind: 'money' },
  { key: 'totalAllowances',     label: '津貼',                header: '津貼',           kind: 'money' },
  { key: 'maternityPay',        label: '產假／侍產假',        header: '產假/侍產假',    kind: 'money' },
  { key: 'adwAdjustment',       label: 'ADW 調整',            header: 'ADW 調整',       kind: 'money' },
  { key: 'storeBonus',          label: '店舖獎金',            header: '店舖獎金',       kind: 'money' },
  { key: 'grossPay',            label: 'Gross（Salary）',     header: 'Salary',         kind: 'money' },
  { key: 'mpf',                 label: 'MPF（僱員）',         header: 'MPF',            kind: 'money' },
  { key: 'mpfEmployer',         label: 'MPF（僱主）',         header: 'MPF（僱主）',    kind: 'money' },
  { key: 'tbDeduction',         label: '時間帳戶欠款扣減',    header: '時間帳戶扣減',   kind: 'money' },
  { key: 'tbCashout',           label: '時間帳戶折現',        header: '時間帳戶折現',   kind: 'money' },
  { key: 'rsGrossAdd',          label: '離職結算加項',        header: '離職結算加項',   kind: 'money' },
  { key: 'excessRestDeduction', label: '超額休息日扣減',      header: '超額休息日扣減', kind: 'money' },
  { key: 'netPay',              label: '實發（Net Pay）',     header: 'Net Pay',        kind: 'money' },
  { key: 'miscAmount',          label: '雜項報銷（FARE）',    header: 'FARE',           kind: 'money' },
  { key: 'totalPayable',        label: '應付總額（Total）',   header: 'Total',          kind: 'money' },
  { key: 'chequeNo',            label: '支票號碼',            header: 'Cheque No.',     kind: 'cheque' },
  { key: 'note',                label: '備註',                header: '備註',           kind: 'text' },
  { key: 'blank',               label: '空白欄（簽收用）',    header: '簽收',           kind: 'text' },
]

export const SHEET_COL_MAP = new Map(SHEET_COLS.map(c => [c.key, c]))

export type GroupBy = 'CLINIC' | 'COMPANY' | 'NONE'
export type RowSort = 'NICK' | 'FULL' | 'CUSTOM'

export interface SheetConfig {
  columns: { key: string; header: string }[]
  groupBy: GroupBy
  /** 每組加小計（唔分組時無效） */
  subtotals: boolean
  /** 每組另開一張工作表＋最尾一張「全部」（唔分組時無效） */
  sheetPerGroup: boolean
  sort: RowSort
  monthRow: boolean
  draftRow: boolean
  totalRow: boolean
  /** ★ cwm-chequeexcl-20261004：呢個模版唔匯出嘅員工（老闆手動揀；例如 MPF 表唔出入職未夠 60 日嘅人）。
   *  每個模版各自一份；新員工預設照出（唔喺清單入面） */
  excludedEmployeeIds: string[]
}

const col = (key: string) => ({ key, header: SHEET_COL_MAP.get(key)!.header })

/** 改之前嘅出糧總表 —— 非老闆／冇揀模版一律用呢個，輸出同舊版逐格一樣 */
export const LEGACY_CONFIG: SheetConfig = {
  columns: ['nickname', 'fullName', 'basicSalary', 'netPay', 'mpf', 'grossPay', 'miscAmount', 'totalPayable', 'chequeNo', 'note'].map(col),
  groupBy: 'COMPANY',
  subtotals: false,
  sheetPerGroup: false,
  sort: 'NICK',
  monthRow: true,
  draftRow: true,
  totalRow: true,
  excludedEmployeeIds: [],
}

/** 新模版預設（老闆拍板：按出糧診所、小計、每組一張 Sheet） */
export const NEW_TEMPLATE_DEFAULT: SheetConfig = {
  ...LEGACY_CONFIG,
  groupBy: 'CLINIC',
  subtotals: true,
  sheetPerGroup: true,
  draftRow: false, // ★ 老闆：草稿警告行唔要（模版一律唔出）
}

const MAX_HEADER = 40

/** 驗證／清理（API 寫入同讀取都用）：未知 key 剷走、重複剷走、表頭限長；冇欄 = 用 LEGACY 欄 */
export function normalizeSheetConfig(raw: unknown): SheetConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const seen = new Set<string>()
  const columns: SheetConfig['columns'] = []
  for (const c of Array.isArray(r.columns) ? r.columns : []) {
    const key = typeof c?.key === 'string' ? c.key : ''
    const def = SHEET_COL_MAP.get(key)
    if (!def || seen.has(key)) continue
    seen.add(key)
    const h = typeof c.header === 'string' ? c.header.trim().slice(0, MAX_HEADER) : ''
    columns.push({ key, header: h || def.header })
  }
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const d = NEW_TEMPLATE_DEFAULT
  return {
    columns: columns.length ? columns : LEGACY_CONFIG.columns.map(c => ({ ...c })),
    groupBy: pick(r.groupBy, ['CLINIC', 'COMPANY', 'NONE'] as const, d.groupBy),
    subtotals: bool(r.subtotals, d.subtotals),
    sheetPerGroup: bool(r.sheetPerGroup, d.sheetPerGroup),
    sort: pick(r.sort, ['NICK', 'FULL', 'CUSTOM'] as const, d.sort),
    monthRow: bool(r.monthRow, d.monthRow),
    draftRow: false, // ★ cwm-chequetpl-20261004 fix：老闆話草稿警告唔要 —— 模版一律唔出（舊格式 LEGACY 照出）
    totalRow: bool(r.totalRow, d.totalRow),
    excludedEmployeeIds: Array.isArray(r.excludedEmployeeIds)
      ? [...new Set(r.excludedEmployeeIds.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, 5000)
      : [],
  }
}

/** 模版卡片副題：「10 欄 · 按出糧診所」 */
export function describeConfig(c: SheetConfig): string {
  const g = c.groupBy === 'CLINIC' ? '按出糧診所' : c.groupBy === 'COMPANY' ? '按出糧公司' : '唔分組'
  return `${c.columns.length} 欄 · ${g}${c.excludedEmployeeIds.length ? ` · 唔出 ${c.excludedEmployeeIds.length} 人` : ''}`
}

/** 模版名：1–30 字 */
export function cleanTemplateName(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && s.length <= 30 ? s : null
}
