/**
 * cwm-payoutxlsx-20260908 A 章 — Excel 月報 sheet 產生器（exceljs）
 *
 * 單張匯出（B 章）同全店月報（C 章）共用同一個產生器 — 兩個入口唔准各寫一次
 * （第二真相來源坑）。所有欄位由 data derive，本檔**唔寫死任何方法/工場/單價**。
 *
 * 五條硬規矩（MD A 章，2026-09-08 老細拍板）：
 *  ① 合計格一律 `{ formula: 'SUM(...)' }` 唔寫死數；最終金額（應付總額／診所總收入）
 *     用 `{ formula, result }` 雙寫（部分手機預覽器無 cached value 會顯示空白）。
 *  ② 欄由 data derive：方法欄照入傳 `methods[]` 順序（上游排好 METHOD_ORDER、
 *     未知排最後）；工場行按金額大→細；材料單價逐筆快照。本檔零硬編碼。
 *  ③ 費率行由入傳 `feePercent`（上游 `PaymentMethodRule` resolve），
 *     收入淨額 = `=合計*(1-費率)` 公式。
 *  ④ 顏色：藍字=系統帶入 / 黑字=公式 / 綠字=跨 sheet 連結 / 黃底=最終金額。
 *  ⑤ B 區 Lab 同 C 區 Implant 出 `patientName`（老細 2026-09-08 拍板可列）。
 *
 * ★ 口徑對齊 engine（lib/payout/engine.ts）：
 *   gross = Σ 全 method net（CREDIT/FREE_SP 都計，engine:389）
 *   profit = gross − lab − implant − invisalign   ← Invisalign 行走 `labRows`
 *   （`itemType='INVISALIGN'`，C 類別 LAB/IMPLANT/INVISALIGN 同一形狀；DoctorSheetData
 *   冇獨立 invisalign 欄，B 區合計 = Lab+Invisalign，F 區一行清完，逐格還原 engine。）
 *   salary = profit × percentUsed（percentUsed 係小數 0.5 = 50%）
 *   total  = salary + spSubsidy + refAmount + adjustAmount
 *   SP/REF 金額 = base × rate（rate 小數；上游將 splitPercent/refPercent 除 100 後傳入，
 *   base 已折入 headcount/qty）。
 */
import ExcelJS from 'exceljs'

export const MONEY_FMT = '$#,##0.00;($#,##0.00);"-"'
export const PCT_FMT = '0.0%'

/** ★ 全份報表統一字體 */
const FONT = 'Arial'

// ── 顏色約定（規則④）─────────────────────────────────────────────
export const COLOR_BLUE = 'FF0000FF' // 系統資料帶入
export const COLOR_GREEN = 'FF008000' // 跨 sheet 連結
export const COLOR_BLACK = 'FF000000' // 公式
export const COLOR_GRAY = 'FF808080' // 作廢行
const FILL_YELLOW = 'FFFFFF00' // 最終金額（應付總額／診所總收入）
export const FILL_SECTION = 'FF1F4E79' // 區塊標題（深藍底白字）
const COLOR_WHITE = 'FFFFFFFF'

/** 跨 sheet 連結用嘅 anchor label（cover 掃描醫生頁／雜項頁用） */
export const LABEL_PAYABLE = '應付總額'
export const LABEL_MISC_NET = '收入淨額'

// ── Data 介面 ─────────────────────────────────────────────────────

export interface DoctorSheetData {
  providerName: string
  clinicName: string
  periodMonth: string // YYYY-MM
  status: string // DRAFT | LOCKED
  /** 方法欄，上游照 METHOD_ORDER 排好（未知排最後），產生器照順序出欄 */
  methods: { key: string; label: string; feePercent: number; countAsIncome: boolean }[]
  /** 逐日（上游傳全月逐日；冇收入 method 傳 0/缺省 → 留白） */
  days: { date: string; byMethod: Record<string, number>; spCount: number }[]
  /** B 區：LAB + INVISALIGN 兩類 CostCase（itemType 出喺「項目」欄） */
  labRows: {
    vendor: string
    orderedAt: string
    patientCode: string
    patientName: string
    itemType: string
    amount: number
  }[]
  /** C 區：IMPLANT 材料，unitPrice = 逐筆 CostCaseMaterial.unitPriceUsed 快照 */
  implantRows: {
    patientCode: string
    patientName: string
    orderedAt: string
    material: string
    qty: number
    unitPrice: number
  }[]
  spRows: { billCode: string; date: string; patientName: string; desc: string; base: number; rate: number }[]
  refRows: { billCode: string; date: string; patientName: string; desc: string; base: number; rate: number }[]
  adjRows: { refCode: string; date: string; reason: string; note: string; amount: number }[]
  /** 拆帳比例，小數（0.5 = 50%） */
  percentUsed: number
}

/**
 * Clinic 雜項頁 data — MD D1/D4 推導最小集（D1 schema 欄位 + D4「明細→合計→減手續費→淨額」）。
 * 冇 Lab/Implant/拆帳、冇 Salary 行（老細 2026-09-08 拍板：雜項全歸公司唔拆）。
 * feePercent = 上游 resolveMethodRule 嘅單一匯總費率（規則③：費率係資料）。
 * 作廢行（isVoid）灰字紅線列喺明細表底部，唔計入合計。
 */
export interface MiscSheetData {
  clinicName: string
  periodMonth: string // YYYY-MM
  feePercent: number // 小數（0.02 = 2%）
  rows: {
    incomeAt: string // YYYY-MM-DD
    category: string // PRODUCT | DEPOSIT | OTHER
    itemName: string
    methodLabel: string // methodNorm 嘅顯示 label（上游 map 好）
    note?: string
    amount: number
    isVoid?: boolean
  }[]
}

/**
 * 封面總表 data（只喺全店月報出）— MD C 章推導：
 * 「逐醫生應付總額行 + 合計行 + 雜項行 + 診所總收入」。
 * sheetName = 醫生頁實際 sheet 名（用 nextSheetName 產生同一個，cover 會跨連結，綠字）。
 * totalAmount = engine 口徑 totalAmount（result 雙寫用；公式係权威）。
 */
export interface CoverSheetData {
  clinicName: string
  periodMonth: string
  doctors: { providerName: string; sheetName: string; status: string; totalAmount: number }[]
  /** 雜項頁實際 sheet 名（有則跨連結淨額，綠字；無則靜態數） */
  miscSheetName?: string
  miscNet: number // 雜項淨額（合計×(1-費率)），result 雙寫 fallback
}

// ── 小工具 ────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100
/** 欄號→字母（exceljs 4.4 types 冇暴露 utils.encode_col，自寫） */
const colName = (c: number): string => {
  let s = ''
  let n = c
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Excel sheet 名硬限制：≤31 字元、禁 `: \ / ? * [ ]`；同名加 `(2)` 後綴（MD C 章） */
export function nextSheetName(wb: ExcelJS.Workbook, base: string): string {
  let clean = base.replace(/[\\/?*[\]:]/g, '').trim() || 'Sheet'
  if (clean.length > 31) clean = clean.slice(0, 31)
  let name = clean
  let n = 2
  while (wb.getWorksheet(name)) {
    const suffix = `(${n})`
    name = clean.slice(0, 31 - suffix.length) + suffix
    n++
  }
  return name
}

const thinSide: ExcelJS.Border = { style: 'thin', color: { argb: 'FFBFBFBF' } }
const thinBorder: Partial<ExcelJS.Borders> = { top: thinSide, left: thinSide, bottom: thinSide, right: thinSide }

interface FontOpts {
  bold?: boolean
  italic?: boolean
  color?: string
  strike?: boolean
  size?: number
}
const mkFont = (o: FontOpts = {}): Partial<ExcelJS.Font> => ({
  name: FONT,
  size: o.size ?? 10,
  bold: o.bold,
  italic: o.italic,
  strike: o.strike,
  color: { argb: o.color ?? COLOR_BLACK },
})

/** 藍字 = 系統帶入（規則④） */
function setData(cell: ExcelJS.Cell, v: string | number, o: { fmt?: string; gray?: boolean } = {}): void {
  cell.value = v
  cell.font = mkFont(o.gray ? { color: COLOR_GRAY, strike: true } : { color: COLOR_BLUE })
  cell.border = thinBorder
  if (o.fmt) cell.numFmt = o.fmt
}

/** 黑字 = 公式（規則④）；result 可選（最終金額必帶，規則①） */
function setFormula(
  cell: ExcelJS.Cell,
  formula: string,
  o: { fmt?: string; result?: number; bold?: boolean } = {},
): void {
  cell.value = o.result !== undefined ? { formula, result: o.result } : { formula }
  cell.font = mkFont({ bold: o.bold })
  cell.border = thinBorder
  if (o.fmt) cell.numFmt = o.fmt
}

/** 綠字 = 跨 sheet 連結（規則④） */
function setLink(
  cell: ExcelJS.Cell,
  formula: string,
  o: { fmt?: string; result?: number; bold?: boolean } = {},
): void {
  cell.value = o.result !== undefined ? { formula, result: o.result } : { formula }
  cell.font = mkFont({ color: COLOR_GREEN, bold: o.bold })
  cell.border = thinBorder
  if (o.fmt) cell.numFmt = o.fmt
}

/** 靜態 label cell（黑字） */
function setLabel(cell: ExcelJS.Cell, v: string, o: { bold?: boolean; gray?: boolean; italic?: boolean } = {}): void {
  cell.value = v
  cell.font = mkFont({
    bold: o.bold,
    italic: o.italic,
    color: o.gray ? COLOR_GRAY : COLOR_BLACK,
  })
  cell.border = thinBorder
}

/** 區塊標題行：深藍底白字粗體，合併整張表闊 */
function sectionTitle(ws: ExcelJS.Worksheet, row: number, text: string, lastCol: number): void {
  ws.mergeCells(row, 1, row, lastCol)
  const c = ws.getCell(row, 1)
  c.value = text
  c.font = mkFont({ bold: true, color: COLOR_WHITE, size: 11 })
  for (let i = 1; i <= lastCol; i++) {
    ws.getCell(row, i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_SECTION } }
  }
}

/** 欄 header 行（粗體黑字） */
function headerRow(ws: ExcelJS.Worksheet, row: number, headers: string[]): void {
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1)
    c.value = h
    c.font = mkFont({ bold: true })
    c.border = thinBorder
  })
}

/** 掃描 A 欄搵 label → 行號（cover 跨連結搵 anchor 用）；搵唔到 = null */
function findLabelRow(ws: ExcelJS.Worksheet, label: string): number | null {
  for (let r = 1; r <= ws.rowCount; r++) {
    const v = ws.getCell(r, 1).value
    if (v === label) return r
  }
  return null
}

/** 設欄闊（共享 1..maxCol；各區都由 A 欄起，照現行 export 慣例） */
function setWidths(ws: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })
}

// ── 醫生頁 ────────────────────────────────────────────────────────

/**
 * 醫生頁：A 逐日 / B Lab / C Implant / D SP+REF / E 調整 / F 結算（MD A 章）。
 * 返回 worksheet（MD 簽名 void；返 ws 係 superset，caller 可忽略 — 要 sheet 名時有用）。
 */
export function buildDoctorSheet(wb: ExcelJS.Workbook, d: DoctorSheetData): ExcelJS.Worksheet {
  const name = nextSheetName(wb, d.providerName)
  const ws = wb.addWorksheet(name)

  const M = d.methods.length
  const methodCol = (i: number): number => 2 + i // B..
  const totalCol = 2 + M // TOTAL（只計 income method）
  const spCountCol = 2 + M + 1 // SP 筆數
  const lastCol = Math.max(2 + M + 1, 7) // 最闊區決定表寬（C/D 區 7 欄）

  // 欄闊
  const widths: number[] = []
  for (let i = 1; i <= lastCol; i++) {
    if (i === 1) widths.push(14)
    else if (i >= 2 && i <= 1 + M) widths.push(12)
    else if (i === totalCol) widths.push(12)
    else if (i === spCountCol) widths.push(9)
    else widths.push(11)
  }
  setWidths(ws, widths)

  let row = 1

  // 標題
  ws.mergeCells(row, 1, row, lastCol)
  ws.getCell(row, 1).value = `${d.providerName} · ${d.clinicName} · ${d.periodMonth} 月度收入報表`
  ws.getCell(row, 1).font = mkFont({ bold: true, size: 14 })
  row++
  ws.getCell(row, 1).value = `狀態：${d.status}`
  ws.getCell(row, 1).font = mkFont({ italic: true, color: COLOR_GRAY })
  row += 2

  // ── A 區：逐日收款 ─────────────────────────────────────────────
  const aSectionRow = row
  sectionTitle(ws, row, 'A  逐日收款', lastCol)
  row++
  const aHeaderRow = row
  headerRow(ws, row, ['日期', ...d.methods.map(m => m.label), 'TOTAL', 'SP 筆數'])
  row++
  const aFirst = row
  for (const day of d.days) {
    setData(ws.getCell(row, 1), day.date)
    let anyIncome = false
    d.methods.forEach((m, i) => {
      const v = day.byMethod[m.key] ?? 0
      const cell = ws.getCell(row, methodCol(i))
      if (v !== 0) {
        setData(cell, round2(v), { fmt: MONEY_FMT })
        if (m.countAsIncome) anyIncome = true
      } else {
        cell.value = ''
        cell.border = thinBorder
      }
    })
    const tCell = ws.getCell(row, totalCol)
    if (anyIncome) {
      // TOTAL 只計 income method（同現行 route NON_INCOME 口徑；flag 由 data 帶入）
      const parts = d.methods
        .map((m, i) => (m.countAsIncome ? `${colName(methodCol(i))}${row}` : null))
        .filter(Boolean)
        .join('+')
      setFormula(tCell, parts, { fmt: MONEY_FMT })
    } else {
      tCell.value = ''
      tCell.border = thinBorder
    }
    const spCell = ws.getCell(row, spCountCol)
    if (day.spCount > 0) setData(spCell, day.spCount)
    else {
      spCell.value = ''
      spCell.border = thinBorder
    }
    row++
  }
  const aLast = row - 1
  const aTotalRow = row
  setLabel(ws.getCell(row, 1), 'Total', { bold: true })
  d.methods.forEach((m, i) => {
    const c = ws.getCell(row, methodCol(i))
    if (d.days.length > 0) setFormula(c, `SUM(${colName(methodCol(i))}${aFirst}:${colName(methodCol(i))}${aLast})`, { fmt: MONEY_FMT, bold: true })
    else {
      setData(c, 0, { fmt: MONEY_FMT, gray: true })
    }
  })
  const atCell = ws.getCell(row, totalCol)
  if (d.days.length > 0) setFormula(atCell, `SUM(${colName(totalCol)}${aFirst}:${colName(totalCol)}${aLast})`, { fmt: MONEY_FMT, bold: true })
  else setData(atCell, 0, { fmt: MONEY_FMT, gray: true })
  ws.getCell(row, spCountCol).border = thinBorder
  row += 2

  // ── B 區：Lab（含 Invisalign）─────────────────────────────────
  // ★ 規則②：工場行按金額大→細（data derive，唔寫死工場名）
  const vendorTotals = new Map<string, number>()
  for (const r of d.labRows) vendorTotals.set(r.vendor || '（未命名）', (vendorTotals.get(r.vendor || '（未命名）') ?? 0) + r.amount)
  const vendors = [...vendorTotals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])

  sectionTitle(ws, row, 'B  Lab 成本（含 Invisalign）', lastCol)
  row++
  headerRow(ws, row, ['工場', '落單日', '病人編號', '病人姓名', '項目', '金額'])
  row++
  const bFirst = row
  const bSubtotalCells: number[] = [] // F 欄 subtotal 行號
  if (d.labRows.length === 0) {
    setLabel(ws.getCell(row, 1), '（無記錄）', { gray: true, italic: true })
    ws.getCell(row, 6).border = thinBorder
    row++
  }
  for (const v of vendors) {
    const rows = d.labRows.filter(r => (r.vendor || '（未命名）') === v)
    const vFirst = row
    for (const r of rows) {
      setData(ws.getCell(row, 1), r.vendor || '（未命名）')
      setData(ws.getCell(row, 2), r.orderedAt)
      setData(ws.getCell(row, 3), r.patientCode)
      setData(ws.getCell(row, 4), r.patientName) // 規則⑤：病人姓名可列
      setData(ws.getCell(row, 5), r.itemType)
      setData(ws.getCell(row, 6), round2(r.amount), { fmt: MONEY_FMT })
      row++
    }
    setLabel(ws.getCell(row, 1), `${v} 小計`, { bold: true })
    for (let i = 2; i <= 5; i++) ws.getCell(row, i).border = thinBorder
    setFormula(ws.getCell(row, 6), `SUM(F${vFirst}:F${row - 1})`, { fmt: MONEY_FMT, bold: true })
    bSubtotalCells.push(row)
    row++
  }
  const bTotalRow = row
  if (d.labRows.length > 0) {
    setLabel(ws.getCell(row, 1), 'B 總計（Lab+Invisalign）', { bold: true })
    for (let i = 2; i <= 5; i++) ws.getCell(row, i).border = thinBorder
    setFormula(ws.getCell(row, 6), bSubtotalCells.map(r => `F${r}`).join('+'), { fmt: MONEY_FMT, bold: true })
  } else {
    setLabel(ws.getCell(row, 1), 'B 總計（Lab+Invisalign）', { bold: true })
    for (let i = 2; i <= 5; i++) ws.getCell(row, i).border = thinBorder
    setData(ws.getCell(row, 6), 0, { fmt: MONEY_FMT, gray: true })
  }
  row += 2

  // ── C 區：Implant（規則②：單價逐筆快照；規則⑤：病人姓名）────
  sectionTitle(ws, row, 'C  Implant 材料', lastCol)
  row++
  headerRow(ws, row, ['病人編號', '病人姓名', '落單日', '材料', '數量', '單價', '金額'])
  row++
  const cFirst = row
  const cSubtotalCells: number[] = []
  if (d.implantRows.length === 0) {
    setLabel(ws.getCell(row, 1), '（無記錄）', { gray: true, italic: true })
    for (let i = 2; i <= 7; i++) ws.getCell(row, i).border = thinBorder
    row++
  }
  // 按病人分組（照現行 export 慣例；同病人相連行 + 小計）
  let groupKey = ''
  let groupFirst = row
  const flushGroup = (key: string): void => {
    if (key === '' || d.implantRows.length === 0) return
    setLabel(ws.getCell(row, 1), `${key} 小計`, { bold: true })
    for (let i = 2; i <= 6; i++) ws.getCell(row, i).border = thinBorder
    setFormula(ws.getCell(row, 7), `SUM(G${groupFirst}:G${row - 1})`, { fmt: MONEY_FMT, bold: true })
    cSubtotalCells.push(row)
    row++
    groupFirst = row
  }
  for (const r of d.implantRows) {
    const key = r.patientCode || '（未编号）'
    if (key !== groupKey) {
      flushGroup(groupKey)
      groupKey = key
    }
    setData(ws.getCell(row, 1), r.patientCode)
    setData(ws.getCell(row, 2), r.patientName)
    setData(ws.getCell(row, 3), r.orderedAt)
    setData(ws.getCell(row, 4), r.material)
    setData(ws.getCell(row, 5), r.qty)
    setData(ws.getCell(row, 6), round2(r.unitPrice), { fmt: MONEY_FMT }) // 快照價（規則②）
    setFormula(ws.getCell(row, 7), `E${row}*F${row}`, { fmt: MONEY_FMT }) // 數量×單價
    row++
  }
  flushGroup(groupKey)
  const cTotalRow = row
  setLabel(ws.getCell(row, 1), 'C 總計（Implant）', { bold: true })
  for (let i = 2; i <= 6; i++) ws.getCell(row, i).border = thinBorder
  if (d.implantRows.length > 0) setFormula(ws.getCell(row, 7), cSubtotalCells.map(r => `G${r}`).join('+'), { fmt: MONEY_FMT, bold: true })
  else setData(ws.getCell(row, 7), 0, { fmt: MONEY_FMT, gray: true })
  row += 2

  // ── D 區：SP + REF ─────────────────────────────────────────────
  sectionTitle(ws, row, 'D  SP + 轉介', lastCol)
  row++
  const writeSubTable = (
    title: string,
    rows: { billCode: string; date: string; patientName: string; desc: string; base: number; rate: number }[],
  ): number => {
    setLabel(ws.getCell(row, 1), title, { bold: true })
    for (let i = 2; i <= 7; i++) ws.getCell(row, i).border = thinBorder
    row++
    headerRow(ws, row, ['編號', '日期', '病人姓名', '項目', '底數', '比率', '金額'])
    row++
    const first = row
    for (const r of rows) {
      setData(ws.getCell(row, 1), r.billCode)
      setData(ws.getCell(row, 2), r.date)
      setData(ws.getCell(row, 3), r.patientName)
      setData(ws.getCell(row, 4), r.desc)
      setData(ws.getCell(row, 5), round2(r.base), { fmt: MONEY_FMT })
      setData(ws.getCell(row, 6), r.rate, { fmt: PCT_FMT })
      setFormula(ws.getCell(row, 7), `E${row}*F${row}`, { fmt: MONEY_FMT }) // 底數×比率
      row++
    }
    setLabel(ws.getCell(row, 1), `${title} 小計`, { bold: true })
    for (let i = 2; i <= 6; i++) ws.getCell(row, i).border = thinBorder
    if (rows.length > 0) setFormula(ws.getCell(row, 7), `SUM(G${first}:G${row - 1})`, { fmt: MONEY_FMT, bold: true })
    else setData(ws.getCell(row, 7), 0, { fmt: MONEY_FMT, gray: true })
    const subRow = row
    row++
    return subRow
  }
  const spSubRow = writeSubTable('SP（2人補貼）', d.spRows)
  const refSubRow = writeSubTable('REF（轉介收入）', d.refRows)
  row++

  // ── E 區：調整 ─────────────────────────────────────────────────
  sectionTitle(ws, row, 'E  調整', lastCol)
  row++
  headerRow(ws, row, ['Ref 編號', '日期', '原因', '備註', '金額'])
  row++
  const eFirst = row
  for (const r of d.adjRows) {
    setData(ws.getCell(row, 1), r.refCode)
    setData(ws.getCell(row, 2), r.date)
    setData(ws.getCell(row, 3), r.reason)
    setData(ws.getCell(row, 4), r.note)
    setData(ws.getCell(row, 5), round2(r.amount), { fmt: MONEY_FMT })
    row++
  }
  const eTotalRow = row
  setLabel(ws.getCell(row, 1), 'E 總計', { bold: true })
  for (let i = 2; i <= 4; i++) ws.getCell(row, i).border = thinBorder
  if (d.adjRows.length > 0) setFormula(ws.getCell(row, 5), `SUM(E${eFirst}:E${row - 1})`, { fmt: MONEY_FMT, bold: true })
  else setData(ws.getCell(row, 5), 0, { fmt: MONEY_FMT, gray: true })
  row += 2

  // ── F 區：結算（engine 口徑：salary+sp+ref+adj = totalAmount）──
  sectionTitle(ws, row, 'F  結算', lastCol)
  row++
  headerRow(ws, row, ['項目', ...d.methods.map(m => m.label), '合計'])
  row++

  // F1 收款總額（照 A 區 Total 行，公式引用）
  setLabel(ws.getCell(row, 1), '收款總額')
  d.methods.forEach((m, i) => {
    setFormula(ws.getCell(row, methodCol(i)), `${colName(methodCol(i))}${aTotalRow}`, { fmt: MONEY_FMT })
  })
  setFormula(ws.getCell(row, totalCol), `SUM(${colName(methodCol(0))}${row}:${colName(methodCol(M - 1))}${row})`, { fmt: MONEY_FMT })
  const fCollectRow = row
  row++
  // F2 手續費率（規則③：入傳 feePercent，藍字）
  setLabel(ws.getCell(row, 1), '手續費率')
  d.methods.forEach((m, i) => setData(ws.getCell(row, methodCol(i)), m.feePercent, { fmt: PCT_FMT }))
  ws.getCell(row, totalCol).border = thinBorder
  const fFeeRow = row
  row++
  // F3 收入淨額 = 合計×(1-費率)（規則③；TOTAL = engine gross 口徑）
  setLabel(ws.getCell(row, 1), '收入淨額', { bold: true })
  d.methods.forEach((m, i) => {
    const c = colName(methodCol(i))
    setFormula(ws.getCell(row, methodCol(i)), `${c}${fCollectRow}*(1-${c}${fFeeRow})`, { fmt: MONEY_FMT })
  })
  setFormula(ws.getCell(row, totalCol), `SUM(${colName(methodCol(0))}${row}:${colName(methodCol(M - 1))}${row})`, { fmt: MONEY_FMT, bold: true })
  const fNetRow = row
  row++

  // 單一值行 helper（label A 欄，值 B 欄，B..合計 合併）
  const singleRow = (label: string, write: (cell: ExcelJS.Cell) => void, bold = false): number => {
    setLabel(ws.getCell(row, 1), label, { bold })
    ws.mergeCells(row, 2, row, totalCol)
    write(ws.getCell(row, 2))
    for (let i = 3; i <= totalCol; i++) ws.getCell(row, i).border = thinBorder
    const r = row
    row++
    return r
  }

  // F4/F5 成本（負數行，B/C 區合計引用）
  const fLabRow = singleRow('Lab/Invisalign 成本', c => setFormula(c, `=-F${bTotalRow}`, { fmt: MONEY_FMT }))
  const fImplantRow = singleRow('Implant 成本', c => setFormula(c, `=-G${cTotalRow}`, { fmt: MONEY_FMT }))
  // F6 利潤
  const fProfitRow = singleRow(
    '利潤',
    c => setFormula(c, `${colName(totalCol)}${fNetRow}+B${fLabRow}+B${fImplantRow}`, { fmt: MONEY_FMT }),
    true,
  )
  // F7 拆帳 %（藍字 data）
  const fPctRow = singleRow('拆帳比例', c => setData(c, d.percentUsed, { fmt: PCT_FMT }))
  // F8 醫生份額 = 利潤×拆帳%
  const fSalaryRow = singleRow('醫生份額', c => setFormula(c, `B${fProfitRow}*B${fPctRow}`, { fmt: MONEY_FMT }))
  // F9-F11 = D/E 區引用
  const fSpRow = singleRow('SP 補貼', c => setFormula(c, `G${spSubRow}`, { fmt: MONEY_FMT }))
  const fRefRow = singleRow('轉介收入', c => setFormula(c, `G${refSubRow}`, { fmt: MONEY_FMT }))
  const fAdjRow = singleRow('上期調整', c => setFormula(c, `E${eTotalRow}`, { fmt: MONEY_FMT }))
  // F12 應付總額（規則①：{ formula, result } 雙寫；規則④：黃底）
  const fPayableRow = row
  setLabel(ws.getCell(row, 1), LABEL_PAYABLE, { bold: true })
  ws.mergeCells(row, 2, row, totalCol)
  const payCell = ws.getCell(row, 2)
  const payableFormula = `B${fSalaryRow}+B${fSpRow}+B${fRefRow}+B${fAdjRow}`
  // result 由同一份 data 推導（engine 口徑 round2 逐步）：
  const methodRaw = d.methods.map(m => round2(d.days.reduce((s, day) => s + (day.byMethod[m.key] ?? 0), 0)))
  const gross = round2(d.methods.reduce((s, m, i) => s + round2(methodRaw[i] * (1 - m.feePercent)), 0))
  const labTotal = round2(d.labRows.reduce((s, r) => s + r.amount, 0))
  const implantTotal = round2(d.implantRows.reduce((s, r) => s + round2(r.qty * r.unitPrice), 0))
  const profit = round2(gross - labTotal - implantTotal)
  const salary = round2(profit * d.percentUsed)
  const spTotal = round2(d.spRows.reduce((s, r) => s + round2(r.base * r.rate), 0))
  const refTotal = round2(d.refRows.reduce((s, r) => s + round2(r.base * r.rate), 0))
  const adjTotal = round2(d.adjRows.reduce((s, r) => s + r.amount, 0))
  const payableResult = round2(salary + spTotal + refTotal + adjTotal)
  payCell.value = { formula: payableFormula, result: payableResult }
  payCell.font = mkFont({ bold: true, size: 12 })
  payCell.numFmt = MONEY_FMT
  for (let i = 2; i <= totalCol; i++) {
    const c = ws.getCell(row, i)
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_YELLOW } }
    c.border = thinBorder
  }
  row++

  return ws
}

// ── Clinic 雜項頁 ─────────────────────────────────────────────────

/**
 * Clinic 雜項頁：明細 → 合計 → 減手續費 → 淨額（MD D4）。
 * 冇 Lab/Implant/拆帳、冇 Salary 行。作廢行灰字紅線唔計入合計。
 */
export function buildMiscSheet(wb: ExcelJS.Workbook, m: MiscSheetData): ExcelJS.Worksheet {
  const name = nextSheetName(wb, 'Clinic 雜項')
  const ws = wb.addWorksheet(name)
  const lastCol = 6
  setWidths(ws, [12, 10, 20, 12, 24, 12])

  let row = 1
  ws.mergeCells(row, 1, row, lastCol)
  ws.getCell(row, 1).value = `${m.clinicName} · ${m.periodMonth} · Clinic 雜項收入`
  ws.getCell(row, 1).font = mkFont({ bold: true, size: 14 })
  row += 2

  sectionTitle(ws, row, '雜項收入明細（唔經 Apricot）', lastCol)
  row++
  headerRow(ws, row, ['日期', '類別', '項目', '付款方式', '備註', '金額'])
  row++
  const active = m.rows.filter(r => !r.isVoid).sort((a, b) => a.incomeAt.localeCompare(b.incomeAt))
  const voids = m.rows.filter(r => r.isVoid).sort((a, b) => a.incomeAt.localeCompare(b.incomeAt))
  const first = row
  for (const r of [...active, ...voids]) {
    setData(ws.getCell(row, 1), r.incomeAt, { gray: r.isVoid })
    setData(ws.getCell(row, 2), r.category, { gray: r.isVoid })
    setData(ws.getCell(row, 3), r.itemName, { gray: r.isVoid })
    setData(ws.getCell(row, 4), r.methodLabel, { gray: r.isVoid })
    setData(ws.getCell(row, 5), r.note ?? '', { gray: r.isVoid })
    setData(ws.getCell(row, 6), round2(r.amount), { fmt: MONEY_FMT, gray: r.isVoid })
    row++
  }
  const lastActive = first + active.length - 1
  const totalRow = row
  setLabel(ws.getCell(row, 1), '合計', { bold: true })
  for (let i = 2; i <= 5; i++) ws.getCell(row, i).border = thinBorder
  // 合計只 SUM 非作廢區（void 行排喺底部，唔入範圍）
  if (active.length > 0) setFormula(ws.getCell(row, 6), `SUM(F${first}:F${lastActive})`, { fmt: MONEY_FMT, bold: true })
  else setData(ws.getCell(row, 6), 0, { fmt: MONEY_FMT, gray: true })
  row++
  // 手續費率（規則③：入傳，藍字）
  setLabel(ws.getCell(row, 1), '手續費率')
  for (let i = 2; i <= 5; i++) ws.getCell(row, i).border = thinBorder
  setData(ws.getCell(row, 6), m.feePercent, { fmt: PCT_FMT })
  const feeRow = row
  row++
  // 收入淨額 = 合計×(1-費率)（規則③；{ formula, result } 雙寫求穩）
  setLabel(ws.getCell(row, 1), LABEL_MISC_NET, { bold: true })
  for (let i = 2; i <= 5; i++) ws.getCell(row, i).border = thinBorder
  const totalVal = round2(active.reduce((s, r) => s + r.amount, 0))
  const netVal = round2(totalVal * (1 - m.feePercent))
  const netCell = ws.getCell(row, 6)
  netCell.value = { formula: `F${totalRow}*(1-F${feeRow})`, result: netVal }
  netCell.font = mkFont({ bold: true })
  netCell.numFmt = MONEY_FMT
  netCell.border = thinBorder
  row++

  return ws
}

// ── 封面總表 ──────────────────────────────────────────────────────

/**
 * 封面總表（只喺全店月報出）：逐醫生應付總額行 + 合計行 + 雜項行 + 診所總收入（MD C 章）。
 * 醫生應付總額 = 跨 sheet 公式連結（綠字，規則④）；搵唔到 anchor 先 fallback 靜態藍數。
 * 診所總收入 = 黃底 + { formula, result }（規則①④）。
 */
export function buildCoverSheet(wb: ExcelJS.Workbook, c: CoverSheetData): ExcelJS.Worksheet {
  const name = nextSheetName(wb, '封面')
  const ws = wb.addWorksheet(name)
  const lastCol = 3
  setWidths(ws, [24, 10, 16])

  let row = 1
  ws.mergeCells(row, 1, row, lastCol)
  ws.getCell(row, 1).value = `${c.clinicName} · ${c.periodMonth} · 月度收入報表（總表）`
  ws.getCell(row, 1).font = mkFont({ bold: true, size: 14 })
  row += 2
  headerRow(ws, row, ['醫生', '狀態', '應付總額'])
  row++
  const firstDoc = row
  for (const doc of c.doctors) {
    setData(ws.getCell(row, 1), doc.providerName)
    setData(ws.getCell(row, 2), doc.status)
    const cell = ws.getCell(row, 3)
    // 跨 sheet 連結：醫生頁 F 區 B 欄（F zone 值喺 B 欄，merged）
    const docWs = wb.getWorksheet(doc.sheetName)
    const payRow = docWs ? findLabelRow(docWs, LABEL_PAYABLE) : null
    if (docWs && payRow) {
      const quoted = doc.sheetName.replace(/'/g, "''")
      setLink(cell, `'${quoted}'!B${payRow}`, { fmt: MONEY_FMT, result: doc.totalAmount })
    } else {
      setData(cell, round2(doc.totalAmount), { fmt: MONEY_FMT })
    }
    row++
  }
  const lastDoc = row - 1
  const totalRow = row
  setLabel(ws.getCell(row, 1), '合計', { bold: true })
  ws.getCell(row, 2).border = thinBorder
  if (c.doctors.length > 0) setFormula(ws.getCell(row, 3), `SUM(C${firstDoc}:C${lastDoc})`, { fmt: MONEY_FMT, bold: true })
  else setData(ws.getCell(row, 3), 0, { fmt: MONEY_FMT, gray: true })
  row++
  const miscRow = row
  setLabel(ws.getCell(row, 1), 'Clinic 雜項（淨額）')
  ws.getCell(row, 2).border = thinBorder
  const miscCell = ws.getCell(row, 3)
  const miscWs = c.miscSheetName ? wb.getWorksheet(c.miscSheetName) : null
  const miscRowNo = miscWs ? findLabelRow(miscWs, LABEL_MISC_NET) : null
  if (miscWs && miscRowNo) {
    const quoted = miscWs.name.replace(/'/g, "''")
    setLink(miscCell, `'${quoted}'!F${miscRowNo}`, { fmt: MONEY_FMT, result: c.miscNet })
  } else {
    setData(miscCell, round2(c.miscNet), { fmt: MONEY_FMT })
  }
  row++
  // 診所總收入 = 合計 + 雜項淨額（規則①雙寫 + 規則④黃底）
  setLabel(ws.getCell(row, 1), '診所總收入', { bold: true })
  ws.getCell(row, 2).border = thinBorder
  const sumVal = round2(c.doctors.reduce((s, d) => s + d.totalAmount, 0))
  const grandCell = ws.getCell(row, 3)
  grandCell.value = { formula: `C${totalRow}+C${miscRow}`, result: round2(sumVal + c.miscNet) }
  grandCell.font = mkFont({ bold: true, size: 12 })
  grandCell.numFmt = MONEY_FMT
  grandCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_YELLOW } }
  grandCell.border = thinBorder
  row++

  return ws
}
