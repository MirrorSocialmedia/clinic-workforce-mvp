// ============================================================
// ★ cwm-chequetpl-20261004：出糧總表 Excel 生成（由 cheque-sheet route 抽出）
//
// 兩步：
//   ① sheetRowFrom(item, ctx)：一個 PayrollItem → 全部欄嘅值（欄來源同舊 route 逐個一樣）
//   ② buildChequeWorkbook(rows, config, meta)：按模版揀欄、排欄、分組、小計、分 Sheet
// LEGACY_CONFIG 出嚟嘅 Excel 同舊 route 逐格一樣（cheque-sheet-build.test.ts 對照）。
//
// 欄來源（舊 route 註釋照搬）：
//   Net Pay = detail.netPay；MPF = detail.mpf；Salary = detail.grossPay；
//   FARE = item.miscAmount；Total = item.totalPayable（已含雜項）；Cheque No = item.chequeNo
//   ★ 恆等式：Salary − MPF − 時間帳戶欠款 = Net Pay；Net Pay + FARE = Total
//     時間帳戶欠款 = detail.resignSettlement?.tbDeduction（NESTED — 禁讀 top-level，L3 guard）
// ⚠️ check-detail-keys.sh 有掃呢個檔：讀 detail 一定要用變數名 detail
// ============================================================
import * as XLSX from 'xlsx'
import { SHEET_COL_MAP, type SheetConfig } from './config'

export type CellVal = string | number | null

export interface SheetRow {
  groupKey: string
  groupTitle: string
  /** 組排序用（公司名 → 診所名） */
  groupSort: [string, string]
  nickname: string
  fullName: string
  /** 自訂次序（出糧診所頁拖出嚟）；null = 排最尾 */
  sortOrder: number | null
  values: Record<string, CellVal>
}

export interface PlaceRef { clinicId: string | null; clinicName: string; companyId: string | null; companyName: string }

const n2 = (v: unknown) => Number((Number(v) || 0).toFixed(2))

/** 一個計糧 item → 全部欄嘅值 */
export function sheetRowFrom(item: any, ctx: {
  home: PlaceRef
  payer: PlaceRef
  groupBy: SheetConfig['groupBy']
  sortOrder: number | null
}): SheetRow {
  let detailBroken = false
  let detail: any = {}
  try {
    detail = item.detailJson ? JSON.parse(item.detailJson) : {}
  } catch {
    detailBroken = true
    console.error('[cheque-sheet] detailJson 解析失敗', { payrollItemId: item.id })
  }
  const salary = Number(detail.grossPay) || 0
  const mpf = Number(detail.mpf) || 0
  const net = Number(detail.netPay) || 0
  const fare = Number(item.miscAmount) || 0
  const total = Number(item.totalPayable) || 0
  const tbDed = Number(detail.resignSettlement?.tbDeduction) || 0

  // Basic Salary：月薪 = configJson.monthly_salary；時薪 = "100 /HR"
  let basic: CellVal = null
  try {
    const cfg = item.employee?.payRules?.[0]?.configJson ? JSON.parse(item.employee.payRules[0].configJson) : null
    if (cfg?.base_type === 'hourly' && typeof cfg.hourly_rate === 'number') basic = `${cfg.hourly_rate} /HR`
    else if (typeof cfg?.monthly_salary === 'number') basic = cfg.monthly_salary
  } catch { /* configJson 損壞 → Basic 留空 */ }

  const notes: string[] = []
  if (detailBroken) notes.push('⚠ 明細資料損壞，金額未必齊 — 請人手核對')
  if (tbDed > 0) notes.push(`含離職扣減 $${tbDed.toFixed(2)}`)
  if (Math.abs(salary - mpf - tbDed - net) > 0.005) notes.push('⚠ Net Pay 截零（負數）')
  if (Math.abs(net + fare - total) > 0.005) notes.push('⚠ Net+FARE≠Total')
  const placeTitle = (p: PlaceRef) => `${p.companyName} · ${p.clinicName}`
  const moved = (ctx.home.clinicId ?? '') !== (ctx.payer.clinicId ?? '')
  if (moved) notes.push(`所屬：${placeTitle(ctx.home)}`)

  const payType = item.employee?.payRules?.[0]?.payType
  const values: Record<string, CellVal> = {
    nickname: item.employee?.user?.name ?? '',
    fullName: item.employee?.user?.fullName ?? item.employee?.user?.name ?? '',
    homeClinic: placeTitle(ctx.home),
    payerClinic: placeTitle(ctx.payer),
    payType: payType === 'MONTHLY' ? '月薪' : payType === 'HOURLY' ? '時薪' : (payType ?? ''),
    basicSalary: basic,
    workedHours: n2(item.workedHours),
    otHours: n2(item.otHours),
    leaveDays: n2(item.leaveDays),
    absentDays: n2(item.absentDays),
    basePay: n2(item.basePay),
    otPay: n2(item.otPay),
    splitPay: n2(item.splitPay),
    deduction: n2(item.deduction),
    sickDeduction: n2(detail.sickDeduction),
    attendanceBonus: n2(detail.attendanceBonus),
    // 同 run export：引擎 final 數字喺 salary.allowances；top-level allowances 係 array 唔好讀
    totalAllowances: n2(detail.salary?.allowances ?? detail.totalAllowances),
    maternityPay: n2((Number(item.maternityPay) || 0) + (Number(item.paternityPay) || 0)),
    adwAdjustment: n2(detail.adwAdjustment),
    storeBonus: n2(item.storeBonus),
    grossPay: salary,
    mpf,
    mpfEmployer: n2(detail.mpfEmployer),
    tbDeduction: n2(detail.resignSettlement?.tbDeduction),
    tbCashout: n2(detail.resignSettlement?.tbCashout),
    rsGrossAdd: n2(detail.resignSettlement?.grossAdd),
    excessRestDeduction: n2(detail.resignSettlement?.excessRestDeduction),
    netPay: net,
    miscAmount: fare,
    totalPayable: total,
    chequeNo: item.chequeNo ?? '',
    note: notes.join('；') || null,
    blank: null,
  }

  const g = ctx.groupBy === 'CLINIC'
    ? { key: `${ctx.payer.companyId ?? '__all__'}|${ctx.payer.clinicId ?? ''}`, title: placeTitle(ctx.payer), sort: [ctx.payer.companyName, ctx.payer.clinicName] as [string, string] }
    : ctx.groupBy === 'COMPANY'
      ? { key: ctx.payer.companyId ?? '__all__', title: ctx.payer.companyName, sort: [ctx.payer.companyName, ''] as [string, string] }
      : { key: '__none__', title: '', sort: ['', ''] as [string, string] }
  return {
    groupKey: g.key, groupTitle: g.title, groupSort: g.sort,
    nickname: String(values.nickname ?? ''), fullName: String(values.fullName ?? ''),
    sortOrder: ctx.sortOrder, values,
  }
}

export function sortSheetRows(rows: SheetRow[], config: SheetConfig): SheetRow[] {
  const within = (a: SheetRow, b: SheetRow) => {
    if (config.sort === 'CUSTOM') {
      const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER, bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER
      if (ao !== bo) return ao - bo
    }
    if (config.sort === 'FULL') return a.fullName.localeCompare(b.fullName, 'en') || a.nickname.localeCompare(b.nickname, 'en')
    return a.nickname.localeCompare(b.nickname, 'en')
  }
  return [...rows].sort((a, b) =>
    a.groupSort[0].localeCompare(b.groupSort[0], 'zh-HK') ||
    a.groupSort[1].localeCompare(b.groupSort[1], 'zh-HK') ||
    a.groupKey.localeCompare(b.groupKey) ||
    within(a, b))
}

/** Excel 工作表名：≤31 字、唔准 []:*?/\、唔准重複 */
export function safeSheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31)
  let s = base, i = 2
  while (used.has(s)) { const suf = ` (${i++})`; s = base.slice(0, 31 - suf.length) + suf }
  used.add(s)
  return s
}

/** 一張工作表（rows 已排好序） */
function buildSheet(rows: SheetRow[], config: SheetConfig, meta: { monthAbbr: string; anyDraft: boolean }, grouped: boolean): XLSX.WorkSheet {
  const cols = config.columns
  const W = cols.length
  const kinds = cols.map(c => SHEET_COL_MAP.get(c.key)!.kind)
  const sumCols = cols.map((_, i) => i).filter(i => kinds[i] === 'money' || kinds[i] === 'num')
  const moneyCols = cols.map((_, i) => i).filter(i => kinds[i] === 'money')
  const chequeCols = cols.map((_, i) => i).filter(i => kinds[i] === 'cheque')
  const empty = (): CellVal[] => cols.map(() => null)
  const useSubtotals = grouped && config.subtotals

  const aoa: CellVal[][] = []
  if (config.monthRow) {
    const r = empty()
    const bi = cols.findIndex(c => c.key === 'basicSalary')
    const at = bi >= 0 ? bi : (moneyCols[0] ?? 0)
    r[at] = meta.monthAbbr
    aoa.push(r)
  }
  aoa.push(cols.map(c => c.header))
  if (config.draftRow && meta.anyDraft) {
    const r = empty(); r[0] = '⚠️ 包含未確認計糧單（DRAFT）—— 數字未必最終'; aoa.push(r)
  }
  const firstDataR = aoa.length

  // 公式 cell：subtotals → SUBTOTAL(9,…)（合計會自動忽略小計，唔會重複計）；否則 SUM（同舊版）
  type F = { r: number; c: number; f: string; v: number }
  const formulas: F[] = []
  const fn = useSubtotals ? (rng: string) => `SUBTOTAL(9,${rng})` : (rng: string) => `SUM(${rng})`
  const rangeOf = (c: number, r1: number, r2: number) => `${XLSX.utils.encode_col(c)}${r1 + 1}:${XLSX.utils.encode_col(c)}${r2 + 1}`
  const sumOf = (rs: SheetRow[], key: string) => rs.reduce((s, r) => s + (typeof r.values[key] === 'number' ? (r.values[key] as number) : 0), 0)

  let gStart = -1
  let gRows: SheetRow[] = []
  const closeGroup = () => {
    if (!useSubtotals || gStart < 0) return
    const r = empty(); r[0] = '小計'; aoa.push(r)
    const ri = aoa.length - 1
    for (const c of sumCols) formulas.push({ r: ri, c, f: fn(rangeOf(c, gStart, ri - 1)), v: Math.round(sumOf(gRows, cols[c].key) * 100) / 100 })
  }
  let lastKey: string | null = null
  for (const row of rows) {
    if (grouped && row.groupKey !== lastKey) {
      closeGroup()
      lastKey = row.groupKey
      const r = empty(); r[0] = `── ${row.groupTitle} `; aoa.push(r)
      gStart = aoa.length; gRows = []
    }
    gRows.push(row)
    aoa.push(cols.map(c => row.values[c.key] ?? null))
  }
  closeGroup()
  const lastDataR = aoa.length - 1

  if (config.totalRow) {
    const r = empty(); r[0] = '合計'; aoa.push(r)
    const ri = aoa.length - 1
    for (const c of sumCols) formulas.push({ r: ri, c, f: fn(rangeOf(c, firstDataR, ri - 1)), v: Math.round(sumOf(rows, cols[c].key) * 100) / 100 })
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  for (const f of formulas) {
    ws[XLSX.utils.encode_cell({ r: f.r, c: f.c })] = { t: 'n', f: f.f, v: f.v, ...(moneyCols.includes(f.c) ? { z: '#,##0.00' } : {}) }
  }
  for (let ri = firstDataR; ri <= lastDataR; ri++) {
    for (const c of moneyCols) {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c })]
      if (cell && cell.t === 'n') cell.z = '#,##0.00'
    }
    // Cheque No. 強制文字 cell（防 Excel 食前導零）
    for (const c of chequeCols) {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c })]
      if (cell && cell.v !== null && cell.v !== undefined) cell.t = 's'
    }
  }
  return ws
}

export function buildChequeWorkbook(rowsIn: SheetRow[], config: SheetConfig, meta: { monthAbbr: string; anyDraft: boolean }): XLSX.WorkBook {
  const rows = sortSheetRows(rowsIn, config)
  const grouped = config.groupBy !== 'NONE'
  const wb = XLSX.utils.book_new()
  const used = new Set<string>()
  if (grouped && config.sheetPerGroup) {
    const keys = [...new Set(rows.map(r => r.groupKey))]
    for (const k of keys) {
      const gr = rows.filter(r => r.groupKey === k)
      XLSX.utils.book_append_sheet(wb, buildSheet(gr, config, meta, true), safeSheetName(gr[0].groupTitle, used))
    }
    XLSX.utils.book_append_sheet(wb, buildSheet(rows, config, meta, true), safeSheetName('全部（合計）', used))
  } else {
    XLSX.utils.book_append_sheet(wb, buildSheet(rows, config, meta, grouped), safeSheetName('出糧總表', used))
  }
  return wb
}
