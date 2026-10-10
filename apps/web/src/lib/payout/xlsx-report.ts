/**
 * cwm-payoutxlsx-20260908 A 章 — Excel 月報 sheet 產生器（exceljs）
 *
 * 單張匯出（B 章）同全店月報（C 章）共用同一個產生器 — 兩個入口唔准各寫一次
 * （第二真相來源坑）。所有欄位由 data derive，本檔**唔寫死任何方法/工場/單價**。
 *
 * 五條硬規矩（MD A 章，2026-09-08 老細拍板）：
 *  ① 合計格一律 `{ formula: 'SUM(...)' }` 唔寫死數；★ cwm-reconxlsx-fix-20260910 A：
 *     所有公式格一律 `{ formula, result }` 雙寫（result 必填）— ExcelJS 純 { formula }
 *     無 cached value，Google Sheets／OneDrive 預覽／手機一律顯示空白（實錘：F 結算成排空）。
 *     ★★★ 一律用 SUM(a,b,c)，【禁止】用 a+b+c —— 空格寫 null 之後 + 仍然脆弱，
 *     而 SUM 對文字／空格一律忽略。2026-09-11 因為 + 撞空字串爆 #VALUE! 修過一次。
 *  ② 欄由 data derive：方法欄照入傳 `methods[]` 順序（上游排好 METHOD_ORDER、
 *     未知排最後）；工場行按金額大→細；材料單價逐筆快照。本檔零硬編碼。
 *  ③ 費率行由入傳 `feePercent`（上游 `PaymentMethodRule` resolve），
 *     收入淨額 = `=合計*(1-費率)` 公式。
 *  ④ 顏色：藍字=系統帶入 / 黑字=公式 / 綠字=跨 sheet 連結 / 黃底=最終金額。
 *  ⑤ B 區 Lab 同 C 區 Implant 出 `patientName`（老細 2026-09-08 拍板可列）。
 *
 * ★ 口徑對齊 engine（lib/payout/engine.ts L391-401）：
 *   gross = Σ 醫生收入欄 net（countAsIncome || FREE_SP；CREDIT 等 countAsIncome=false 唔計）
 *   profit = gross − lab − implant − invisalign   ← Invisalign 行走 `labRows`
 *   （`itemType='INVISALIGN'`，C 類別 LAB/IMPLANT/INVISALIGN 同一形狀；DoctorSheetData
 *   冇獨立 invisalign 欄，B 區合計 = Lab+Invisalign，F 區一行清完，逐格還原 engine。）
 *   salary = profit × percentUsed（percentUsed 係小數 0.5 = 50%）
 *   total  = salary + spSubsidy + refAmount + adjustAmount
 *   SP/REF 金額 = base × rate（rate 小數；上游將 splitPercent/refPercent 除 100 後傳入，
 *   base 已折入 headcount/qty）。（★ cwm-payout P-3 將改為 DB amount — 見後續 commit）
 *   ★ cwm-payout P-1（2026-09-29）：F 區（收款總額／收入淨額）只計 countForDoctor 欄；
 *   唔計醫生收入嘅欄灰字照顯示，另加「不計醫生收入（X）」對數行（唔入任何合計）。
 */
import ExcelJS from 'exceljs'
import type { DailyReport } from './daily-report'
import { CLINIC_ROW_KEY } from './daily-report'

export const MONEY_FMT = '$#,##0.00;($#,##0.00);"-"'
// ★ cwm-feefmt-20261006：兩個小數位 —— 一個小數位會將 0.235% 顯示成「0.2%」、1.75% 顯示成「1.8%」，誤導
export const PCT_FMT = '0.00%'

/** ★ 全份報表統一字體 */
const FONT = 'Arial'

// ── 顏色約定（規則④）─────────────────────────────────────────────
export const COLOR_BLUE = 'FF0000FF' // 系統資料帶入
export const COLOR_GREEN = 'FF008000' // 跨 sheet 連結
export const COLOR_BLACK = 'FF000000' // 公式
export const COLOR_GRAY = 'FF808080' // 作廢行
const FILL_YELLOW = 'FFFFFF00' // 最終金額（應付總額／診所總收入）
// ★ cwm-draftreport-20261006：草稿（未鎖定）醫生 —— 淺黃底，同「最終金額」嘅亮黃分得開
export const FILL_DRAFT = 'FFFFEB9C'
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
  /** ★ cwm-draftreport-20261006：未鎖定 → 狀態行黃底粗體＋分頁標籤黃色 */
  draft?: boolean
  /** sheet 名基底（C 步全店月報傳 shortName||name；單張匯出唔傳 → 照舊用 providerName） */
  sheetNameBase?: string
  /** 方法欄（key = colKey「方法|storeIncome|doctorIncome」，上游照 METHOD_ORDER 排好），產生器照順序出欄 */
  methods: { key: string; label: string; feePercent: number; countAsIncome: boolean; countForDoctor: boolean; feeNote?: string }[]
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
  spRows: { billCode: string; date: string; patientName: string; desc: string; base: number; rate: number; amount: number; adjusted?: boolean }[]
  refRows: { billCode: string; date: string; patientName: string; desc: string; base: number; rate: number; amount: number; adjusted?: boolean }[]
  adjRows: { refCode: string; date: string; reason: string; note: string; amount: number }[]
  /** 拆帳比例，小數（0.5 = 50%） */
  percentUsed: number
}

/**
 * Clinic 雜項頁 data — MD D1/D4 推導最小集（D1 schema 欄位 + D4「明細→合計→減手續費→淨額」）。
 * 冇 Lab/Implant/拆帳、冇 Salary 行（老細 2026-09-08 拍板：雜項全歸公司唔拆）。
 * feePercent／fee = 逐行由上游 resolveMethodRule 解出（規則③：費率係資料；★ cwm-feefmt-20261006 唔再用單一匯總費率）。
 * 作廢行（isVoid）灰字紅線列喺明細表底部，唔計入合計。
 */
export interface MiscSheetData {
  clinicName: string
  periodMonth: string // YYYY-MM
  rows: {
    incomeAt: string // YYYY-MM-DD
    category: string // PRODUCT | DEPOSIT | OTHER
    itemName: string
    methodLabel: string // methodNorm 嘅顯示 label（上游 map 好）
    note?: string
    amount: number
    isVoid?: boolean
    /// ★ cwm-clinicmisc-wire-20260913：'APRICOT'（診所帳號收款）／'MANUAL'（人手錄入）
    source?: 'APRICOT' | 'MANUAL'
    /// ★ cwm-feefmt-20261006：逐行付款方式費率（小數，0.02 = 2%）同手續費（$）；
    ///   舊版用「全部收款加權平均費率」一行 —— Octopus 2% + FPS 0% 會顯示成「0.2%」，誤導。
    feePercent: number
    fee: number
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
  doctors: {
    providerName: string
    sheetName: string
    status: string
    /** ★ cwm-draftreport-20261006：未鎖定（即時計）→ 封面該行黃底，入「草稿合計」 */
    draft?: boolean
    /// 應付醫生（拆帳後，已扣 Lab／植體成本）
    totalAmount: number
    /// ★ 店舖營收（countAsIncome method 合計，唔含 Free SP / Credit）— 同醫生頁 A 區 TOTAL 行同一口徑
    revenue: number
    /// ★ Free SP（唔計店舖營收，【已計入】醫生收入 → 已包含喺 totalAmount）
    freeSp: number
    /// ★ Credit（店舖營收、醫生收入兩樣都唔計）
    credit: number
    /// ★ 醫生頁 method 欄數（封面計算 A 區 TOTAL 欄 = 2+methodCount 用嚟跨連結；封面自己唔知 M）
    methodCount: number
  }[]
  /** 雜項頁實際 sheet 名（有則跨連結淨額，綠字；無則靜態數） */
  miscSheetName?: string
  miscNet: number // 雜項淨額（合計×(1-費率)），result 雙寫 fallback
  /** ★ cwm-draftreport-20261006：有收入但計唔到月結（gate 唔過／帳號未綁等）嘅醫生 —— 封面列名＋原因，唔好靜靜漏咗 */
  failures?: { providerName: string; reason: string }[]
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

/**
 * ★ cwm-coverrevenue-20260914 A2：income method 合計（A 區 TOTAL 欄口徑）。
 * 導出嚟俾封面同醫生頁用同一個 function（坑②：唔准兩處各寫一次，將來改一邊就出兩個數）；
 * 醫生頁內部 closure 照舊 call 佢（行為零變）。countAsIncome=false（FREE_SP/CREDIT）唔計。
 */
export function incomeTotalOf(
  methods: { key: string; countAsIncome: boolean }[],
  byMethod: Record<string, number>,
): number {
  return methods.reduce((s, m) => s + (m.countAsIncome ? round2(byMethod[m.key] ?? 0) : 0), 0)
}

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

/** 黑字 = 公式（規則④）
 *  ★ cwm-reconxlsx-fix-20260910 A：result 由選填改【必填】——
 *    ExcelJS 純 { formula } 冇 cached value，Google Sheets／OneDrive 預覽／手機
 *    一律顯示空白（實證：F 結算成排空，淨係雙寫嗰格「應付總額」有數）。
 *    ★ 呢個唔係「求穩」，係「唔寫就見唔到」。
 *    result 一律 round2()，同公式算出嚟嘅數一致（否則 Excel 重算個數會跳）。
 */
function setFormula(
  cell: ExcelJS.Cell,
  formula: string,
  o: { result: number; fmt?: string; bold?: boolean; gray?: boolean },
): void {
  cell.value = { formula, result: o.result }
  cell.font = mkFont({ bold: o.bold, color: o.gray ? COLOR_GRAY : COLOR_BLACK })
  cell.border = thinBorder
  if (o.fmt) cell.numFmt = o.fmt
}

/** ★ cwm-dailyv2-20261007 ⑤：小計行靜態數字（黑粗／灰粗）—— 無公式來源（逐格淨額唔喺表上），
 *  黑字規則④例外：呢度無 formula 可寫，用 lib 計好嘅 totals 直接寫。 */
function setStatic(cell: ExcelJS.Cell, v: number, o: { fmt?: string; gray?: boolean; bold?: boolean } = {}): void {
  cell.value = v
  cell.font = mkFont({ color: o.gray ? COLOR_GRAY : COLOR_BLACK, bold: o.bold })
  cell.border = thinBorder
  if (o.fmt) cell.numFmt = o.fmt
}

/** 綠字 = 跨 sheet 連結（規則④）
 *  ★ cwm-reconxlsx-fix-20260910 A（CEO 補充）：同 setFormula，result【必填】+ 雙寫——
 *    封面逐醫生行就係 setLink，唔改一樣會空白。
 */
function setLink(
  cell: ExcelJS.Cell,
  formula: string,
  o: { result: number; fmt?: string; bold?: boolean },
): void {
  cell.value = { formula, result: o.result }
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

/** 欄 header 行（粗體黑字）；wrap=true → 長標籤換行＋加高行（★ cwm-reconxlsx-fix-20260910 C：
 *  FREE SP 標籤變長「不計店舖營收，計醫生收入」，width 12 欄一行擺唔低 → 換行，唔切字） */
function headerRow(ws: ExcelJS.Worksheet, row: number, headers: string[], wrap = false): void {
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1)
    c.value = h
    c.font = mkFont({ bold: true })
    c.border = thinBorder
    if (wrap) c.alignment = { wrapText: true }
  })
  if (wrap) ws.getRow(row).height = 50
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
 * 返回 `{ ws, payable }`（payable = F 區「應付總額」cached result —
 * ★ cwm-payout P-4：匯出前同 run.totalAmount 對數防線用）。
 */
export function buildDoctorSheet(wb: ExcelJS.Workbook, d: DoctorSheetData): { ws: ExcelJS.Worksheet; payable: number } {
  const name = nextSheetName(wb, d.sheetNameBase ?? d.providerName)
  const ws = wb.addWorksheet(name)

  const M = d.methods.length
  const methodCol = (i: number): number => 2 + i // B..
  const totalCol = 2 + M // TOTAL（只計 income method）
  const spCountCol = 2 + M + 1 // SP 筆數
  const lastCol = Math.max(2 + M + 1, 7) // 最闊區決定表寬（C/D 區 7 欄）

  // ★ cwm-reconxlsx-fix-20260910 A：公式格 result 必填——以下值由同一份 data 推導
  //   （engine 口徑 round2 逐步，同原 F12 前嘅推導式一字不差，只係搬前供 A/F 區雙寫用）：
  const methodRaw = d.methods.map(m => round2(d.days.reduce((s, day) => s + (day.byMethod[m.key] ?? 0), 0)))
  // ★ cwm-payout P-1：F 區只計【醫生收入】欄（countForDoctor，同 engine L391-401 同口徑）；
  //   唔計嘅欄（CREDIT 等）灰字照顯示，只入「不計醫生收入」對數行，唔入任何合計。
  const doctorIdx = d.methods.map((m, i) => (m.countForDoctor ? i : -1)).filter(i => i >= 0)
  const collectTotal = round2(doctorIdx.reduce((s, i) => s + methodRaw[i], 0)) // 醫生收入「收款總額」
  const excludedTotal = round2(d.methods.reduce((s, m, i) => s + (m.countForDoctor ? 0 : methodRaw[i]), 0))
  const gross = round2(doctorIdx.reduce((s, i) => s + round2(methodRaw[i] * (1 - d.methods[i].feePercent)), 0))
  const labTotal = round2(d.labRows.reduce((s, r) => s + r.amount, 0))
  const implantTotal = round2(d.implantRows.reduce((s, r) => s + round2(r.qty * r.unitPrice), 0))
  const profit = round2(gross - labTotal - implantTotal)
  const salary = round2(profit * d.percentUsed)
  const spTotal = round2(d.spRows.reduce((s, r) => s + round2(r.amount), 0)) // ★ cwm-payout P-3：用 DB amount（人手改過都對）
  const refTotal = round2(d.refRows.reduce((s, r) => s + round2(r.amount), 0)) // ★ cwm-payout P-3：同上
  const adjTotal = round2(d.adjRows.reduce((s, r) => s + r.amount, 0))
  const payableResult = round2(salary + spTotal + refTotal + adjTotal)
  // A 區 TOTAL 欄只計 income method（同現行 route NON_INCOME 口徑；flag 由 data 帶入）
  // ★ cwm-coverrevenue-20260914 A2：邏輯搬去 incomeTotalOf（導出俾封面共用）— 行為零變
  const incomeTotal = (byMethod: Record<string, number>): number => incomeTotalOf(d.methods, byMethod)

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
  if (d.draft) {
    // ★ cwm-draftreport-20261006：草稿要一眼睇到 —— 只改呢行樣式，唔加行（下面各區行號不變）
    ws.mergeCells(row, 1, row, lastCol)
    ws.getCell(row, 1).value = `⚠ 狀態：${d.status}`
    ws.getCell(row, 1).font = mkFont({ bold: true })
    ws.getCell(row, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_DRAFT } }
    ws.properties.tabColor = { argb: FILL_DRAFT }
  }
  row += 2

  // ── A 區：逐日收款 ─────────────────────────────────────────────
  const aSectionRow = row
  sectionTitle(ws, row, 'A  逐日收款', lastCol)
  row++
  const aHeaderRow = row
  headerRow(ws, row, ['日期', ...d.methods.map(m => m.label), 'TOTAL', 'SP 筆數'], true)
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
        // ★ cwm-costui-xlsxfix-20260911 B1：寫 '' 會變【文字格】，
        //   令任何用 + 串嘅公式爆 #VALUE!（WPS 重算即見）。null = 真空格。
        cell.value = null
        cell.border = thinBorder
      }
    })
    const tCell = ws.getCell(row, totalCol)
    if (anyIncome) {
      // TOTAL 只計 income method（同現行 route NON_INCOME 口徑；flag 由 data 帶入）
      const parts = d.methods
        .map((m, i) => (m.countAsIncome ? `${colName(methodCol(i))}${row}` : null))
        .filter(Boolean)
        .join(',')
      // ★ B2：一定要 SUM(a,b,c) 唔可以 a+b+c —— SUM 忽略文字，+ 撞文字就 #VALUE!
      setFormula(tCell, `SUM(${parts})`, { fmt: MONEY_FMT, result: round2(incomeTotal(day.byMethod)) })
    } else {
      // ★ B1：null = 真空格（同 method 格，避免文字格爆 + 公式）
      tCell.value = null
      tCell.border = thinBorder
    }
    const spCell = ws.getCell(row, spCountCol)
    if (day.spCount > 0) setData(spCell, day.spCount)
    else {
      // ★ B1：null = 真空格（同 method 格，避免文字格爆 + 公式）
      spCell.value = null
      spCell.border = thinBorder
    }
    row++
  }
  const aLast = row - 1
  const aTotalRow = row
  setLabel(ws.getCell(row, 1), 'Total', { bold: true })
  d.methods.forEach((m, i) => {
    const c = ws.getCell(row, methodCol(i))
    if (d.days.length > 0) setFormula(c, `SUM(${colName(methodCol(i))}${aFirst}:${colName(methodCol(i))}${aLast})`, { fmt: MONEY_FMT, bold: true, result: methodRaw[i] })
    else {
      setData(c, 0, { fmt: MONEY_FMT, gray: true })
    }
  })
  const atCell = ws.getCell(row, totalCol)
  if (d.days.length > 0) setFormula(atCell, `SUM(${colName(totalCol)}${aFirst}:${colName(totalCol)}${aLast})`, { fmt: MONEY_FMT, bold: true, result: round2(d.days.reduce((s, day) => s + incomeTotal(day.byMethod), 0)) })
  else setData(atCell, 0, { fmt: MONEY_FMT, gray: true })
  ws.getCell(row, spCountCol).border = thinBorder
  row += 2

  // ── B 區：Lab（含 Invisalign）─────────────────────────────────
  // ★ 規則②：工場行按金額大→細（data derive，唔寫死工場名）
  const vendorTotals = new Map<string, number>()
  for (const r of d.labRows) vendorTotals.set(r.vendor || '（未命名）', (vendorTotals.get(r.vendor || '（未命名）') ?? 0) + r.amount)
  const vendors = [...vendorTotals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])

  sectionTitle(ws, row, 'B  Lab 成本', lastCol)
  row++
  headerRow(ws, row, ['工場', '落單日', '病人編號', '病人姓名', '項目', '金額'])
  row++
  const bFirst = row
  const bSubtotalCells: number[] = [] // F 欄 subtotal 行號
  const bSubtotalVals: number[] = [] // 各 subtotal cached result（B 總計 result 用）
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
    const bSubVal = round2(rows.reduce((s, r) => s + round2(r.amount), 0))
    setFormula(ws.getCell(row, 6), `SUM(F${vFirst}:F${row - 1})`, { fmt: MONEY_FMT, bold: true, result: bSubVal })
    bSubtotalCells.push(row)
    bSubtotalVals.push(bSubVal)
    row++
  }
  const bTotalRow = row
  if (d.labRows.length > 0) {
    setLabel(ws.getCell(row, 1), 'B 總計（Lab）', { bold: true })
    for (let i = 2; i <= 5; i++) ws.getCell(row, i).border = thinBorder
    setFormula(ws.getCell(row, 6), `SUM(${bSubtotalCells.map(r => `F${r}`).join(',')})`, { fmt: MONEY_FMT, bold: true, result: round2(bSubtotalVals.reduce((s, x) => s + x, 0)) })
  } else {
    setLabel(ws.getCell(row, 1), 'B 總計（Lab）', { bold: true })
    for (let i = 2; i <= 5; i++) ws.getCell(row, i).border = thinBorder
    setData(ws.getCell(row, 6), 0, { fmt: MONEY_FMT, gray: true })
  }
  row += 2

  // ── C 區：Implant（規則②：單價逐筆快照；規則⑤：病人姓名）────
  sectionTitle(ws, row, 'C  植牙材料', lastCol)
  row++
  headerRow(ws, row, ['病人編號', '病人姓名', '落單日', '材料', '數量', '單價', '金額'])
  row++
  const cFirst = row
  const cSubtotalCells: number[] = []
  const cSubtotalVals: number[] = [] // 各 group subtotal cached result（C 總計 result 用）
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
    const gRows = d.implantRows.filter(r => (r.patientCode || '（未编号）') === key)
    const cSubVal = round2(gRows.reduce((s, r) => s + round2(r.qty * r.unitPrice), 0))
    setLabel(ws.getCell(row, 1), `${key} 小計`, { bold: true })
    for (let i = 2; i <= 6; i++) ws.getCell(row, i).border = thinBorder
    setFormula(ws.getCell(row, 7), `SUM(G${groupFirst}:G${row - 1})`, { fmt: MONEY_FMT, bold: true, result: cSubVal })
    cSubtotalCells.push(row)
    cSubtotalVals.push(cSubVal)
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
    setFormula(ws.getCell(row, 7), `E${row}*F${row}`, { fmt: MONEY_FMT, result: round2(r.qty * r.unitPrice) }) // 數量×單價
    row++
  }
  flushGroup(groupKey)
  const cTotalRow = row
  setLabel(ws.getCell(row, 1), 'C 總計（植牙）', { bold: true })
  for (let i = 2; i <= 6; i++) ws.getCell(row, i).border = thinBorder
  if (d.implantRows.length > 0) setFormula(ws.getCell(row, 7), `SUM(${cSubtotalCells.map(r => `G${r}`).join(',')})`, { fmt: MONEY_FMT, bold: true, result: round2(cSubtotalVals.reduce((s, x) => s + x, 0)) })
  else setData(ws.getCell(row, 7), 0, { fmt: MONEY_FMT, gray: true })
  row += 2

  // ── D 區：SP + REF ─────────────────────────────────────────────
  sectionTitle(ws, row, 'D  SP + 轉介', lastCol)
  row++
  const writeSubTable = (
    title: string,
    rows: { billCode: string; date: string; patientName: string; desc: string; base: number; rate: number; amount: number; adjusted?: boolean }[],
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
      // ★ cwm-payout P-3：base×rate 只作展示（底數/比率欄照列俾人睇點計）；
      //   金額欄用 DB amount（人手改過都出對數）；改過嘅行尾加「（已人手調整）」
      setData(ws.getCell(row, 4), r.adjusted ? `${r.desc}（已人手調整）` : r.desc)
      setData(ws.getCell(row, 5), round2(r.base), { fmt: MONEY_FMT })
      setData(ws.getCell(row, 6), r.rate, { fmt: PCT_FMT })
      setData(ws.getCell(row, 7), round2(r.amount), { fmt: MONEY_FMT }) // ★ P-3：DB amount，唔再 E×F 公式
      row++
    }
    setLabel(ws.getCell(row, 1), `${title} 小計`, { bold: true })
    for (let i = 2; i <= 6; i++) ws.getCell(row, i).border = thinBorder
    if (rows.length > 0) setFormula(ws.getCell(row, 7), `SUM(G${first}:G${row - 1})`, { fmt: MONEY_FMT, bold: true, result: round2(rows.reduce((s, r) => s + round2(r.amount), 0)) })
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
  if (d.adjRows.length > 0) setFormula(ws.getCell(row, 5), `SUM(E${eFirst}:E${row - 1})`, { fmt: MONEY_FMT, bold: true, result: round2(d.adjRows.reduce((s, r) => s + round2(r.amount), 0)) })
  else setData(ws.getCell(row, 5), 0, { fmt: MONEY_FMT, gray: true })
  row += 2

  // ── F 區：結算（engine 口徑：salary+sp+ref+adj = totalAmount）──
  sectionTitle(ws, row, 'F  結算', lastCol)
  row++
  headerRow(ws, row, ['項目', ...d.methods.map(m => m.label), '合計'], true)
  row++

  // F1 收款總額（照 A 區 Total 行，公式引用）
  // ★ cwm-payout P-1：TOTAL 只 SUM 醫生收入欄（countForDoctor）；唔計嘅欄灰字照顯示
  setLabel(ws.getCell(row, 1), '收款總額')
  d.methods.forEach((m, i) => {
    setFormula(ws.getCell(row, methodCol(i)), `${colName(methodCol(i))}${aTotalRow}`, { fmt: MONEY_FMT, result: methodRaw[i], gray: !m.countForDoctor })
  })
  const doctorCells = (r: number): string => doctorIdx.map(i => `${colName(methodCol(i))}${r}`).join(',')
  if (doctorIdx.length > 0) {
    setFormula(ws.getCell(row, totalCol), `SUM(${doctorCells(row)})`, { fmt: MONEY_FMT, result: collectTotal })
  } else {
    // 冇醫生收入欄 → 寫 0（唔好出空 SUM() 公式）
    setData(ws.getCell(row, totalCol), 0, { fmt: MONEY_FMT, gray: true })
  }
  const fCollectRow = row
  row++
  // ★ cwm-payout P-1：不計醫生收入對數行（灰字）—「收款總額 + 呢行 = 對數口徑（全方法）」
  //   一眼對到系統畫面；只作對數，唔入任何合計。
  const excludedIdx = d.methods.map((m, i) => (m.countForDoctor ? -1 : i)).filter(i => i >= 0)
  if (excludedIdx.length > 0) {
    const excludedNames = excludedIdx.map(i => d.methods[i].key.split('|')[0]).join('/')
    setLabel(ws.getCell(row, 1), `不計醫生收入（${excludedNames}）`, { gray: true, italic: true })
    ws.mergeCells(row, 2, row, totalCol)
    setData(ws.getCell(row, 2), round2(excludedTotal), { fmt: MONEY_FMT, gray: true })
    for (let i = 3; i <= totalCol; i++) ws.getCell(row, i).border = thinBorder
    row++
  }
  // F2 手續費率（規則③：入傳 feePercent，藍字）
  setLabel(ws.getCell(row, 1), '手續費率')
  d.methods.forEach((m, i) => {
    const c = ws.getCell(row, methodCol(i))
    setData(c, m.feePercent, { fmt: PCT_FMT })
    if (m.feeNote) c.note = m.feeNote // ★ cwm-feefmt-20261006：月中轉過費率 → 註明加權平均
  })
  ws.getCell(row, totalCol).border = thinBorder
  const fFeeRow = row
  row++
  // F3 收入淨額 = 合計×(1-費率)（規則③；TOTAL = engine gross 口徑）
  // ★ cwm-payout P-1：TOTAL 只 SUM 醫生收入欄；唔計嘅欄格仔照顯示淨額（灰字）
  setLabel(ws.getCell(row, 1), '收入淨額', { bold: true })
  d.methods.forEach((m, i) => {
    const c = colName(methodCol(i))
    setFormula(ws.getCell(row, methodCol(i)), `${c}${fCollectRow}*(1-${c}${fFeeRow})`, { fmt: MONEY_FMT, result: round2(methodRaw[i] * (1 - m.feePercent)), gray: !m.countForDoctor })
  })
  if (doctorIdx.length > 0) {
    setFormula(ws.getCell(row, totalCol), `SUM(${doctorCells(row)})`, { fmt: MONEY_FMT, bold: true, result: gross })
  } else {
    setData(ws.getCell(row, totalCol), 0, { fmt: MONEY_FMT, gray: true })
  }
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
  const fLabRow = singleRow('Lab 成本', c => setFormula(c, `-${'F'}${bTotalRow}`, { fmt: MONEY_FMT, result: -labTotal }))
  const fImplantRow = singleRow('植牙成本', c => setFormula(c, `-${'G'}${cTotalRow}`, { fmt: MONEY_FMT, result: -implantTotal }))
  // ↑ F4/F5 成本（負數行，B/C 區合計引用）；公式一律唔帶前綴 =（OOXML <f> 規格）— 2026-09-10 S1 修：原 `=-F...` 寫法係現有 bug，部分 reader（Google Sheets/手機預覽）解析失敗會空白
  const fProfitRow = singleRow(
    '利潤',
    // ★ cwm-coverrevenue-20260914：a+b+c → SUM(a,b,c)（全檔禁裸 +；numeric cells 同值）
    c => setFormula(c, `SUM(${colName(totalCol)}${fNetRow},B${fLabRow},B${fImplantRow})`, { fmt: MONEY_FMT, result: profit }),
    true,
  )
  // F7 拆帳 %（藍字 data）
  const fPctRow = singleRow('拆帳比例', c => setData(c, d.percentUsed, { fmt: PCT_FMT }))
  // F8 醫生份額 = 利潤×拆帳%
  const fSalaryRow = singleRow('醫生份額', c => setFormula(c, `B${fProfitRow}*B${fPctRow}`, { fmt: MONEY_FMT, result: salary }))
  // F9-F11 = D/E 區引用
  const fSpRow = singleRow('SP 補貼', c => setFormula(c, `G${spSubRow}`, { fmt: MONEY_FMT, result: spTotal }))
  const fRefRow = singleRow('轉介收入', c => setFormula(c, `G${refSubRow}`, { fmt: MONEY_FMT, result: refTotal }))
  const fAdjRow = singleRow('上期調整', c => setFormula(c, `E${eTotalRow}`, { fmt: MONEY_FMT, result: adjTotal }))
  // F12 應付總額（規則①：{ formula, result } 雙寫；規則④：黃底）
  const fPayableRow = row
  setLabel(ws.getCell(row, 1), LABEL_PAYABLE, { bold: true })
  ws.mergeCells(row, 2, row, totalCol)
  const payCell = ws.getCell(row, 2)
  // ★ cwm-coverrevenue-20260914：a+b+c+d → SUM(a,b,c,d)（全檔禁裸 +；numeric cells 同值）
  const payableFormula = `SUM(B${fSalaryRow},B${fSpRow},B${fRefRow},B${fAdjRow})`
  // result 由同一份 data 推導（engine 口徑 round2 逐步）— 推導式已搬去函數頭（A 步：result 必填）
  payCell.value = { formula: payableFormula, result: payableResult }
  payCell.font = mkFont({ bold: true, size: 12 })
  payCell.numFmt = MONEY_FMT
  for (let i = 2; i <= totalCol; i++) {
    const c = ws.getCell(row, i)
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_YELLOW } }
    c.border = thinBorder
  }
  row++

  // ★ cwm-payout P-4：payable = F 區「應付總額」cached result（匯出前對數防線用）
  return { ws, payable: payableResult }
}

// ── Clinic 雜項頁 ─────────────────────────────────────────────────

/**
 * Clinic 雜項頁：明細 → 合計 → 減手續費 → 淨額（MD D4）。
 * 冇 Lab/Implant/拆帳、冇 Salary 行。作廢行灰字紅線唔計入合計。
 */
export function buildMiscSheet(wb: ExcelJS.Workbook, m: MiscSheetData): ExcelJS.Worksheet {
  const name = nextSheetName(wb, 'Clinic 雜項')
  const ws = wb.addWorksheet(name)
  // ★ cwm-clinicmisc-wire-20260913：加「來源」；★ cwm-feefmt-20261006：加「費率」「手續費」逐行
  //   金額留 F 欄（封面跨 sheet 連結「收入淨額」嘅 F 欄唔變）
  const lastCol = 9
  setWidths(ws, [12, 10, 20, 12, 24, 12, 9, 10, 10])

  let row = 1
  ws.mergeCells(row, 1, row, lastCol)
  ws.getCell(row, 1).value = `${m.clinicName} · ${m.periodMonth} · Clinic 雜項收入`
  ws.getCell(row, 1).font = mkFont({ bold: true, size: 14 })
  row += 2

  sectionTitle(ws, row, '雜項收入明細', lastCol)
  row++
  headerRow(ws, row, ['日期', '類別', '項目', '付款方式', '備註', '金額', '費率', '手續費', '來源'])
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
    setData(ws.getCell(row, 7), r.feePercent, { fmt: PCT_FMT, gray: r.isVoid })
    setData(ws.getCell(row, 8), round2(r.fee), { fmt: MONEY_FMT, gray: r.isVoid })
    setData(ws.getCell(row, 9), r.source === 'MANUAL' ? '人手' : 'Apricot', { gray: r.isVoid })
    row++
  }
  const lastActive = first + active.length - 1
  // 合計（金額 F、手續費 H）—— 只 SUM 非作廢區（void 行排喺底部，唔入範圍）
  const totalRow = row
  setLabel(ws.getCell(row, 1), '合計', { bold: true })
  for (let i = 2; i <= lastCol; i++) ws.getCell(row, i).border = thinBorder
  const totalVal = round2(active.reduce((s, r) => s + r.amount, 0))
  const feeVal = round2(active.reduce((s, r) => s + round2(r.fee), 0))
  if (active.length > 0) {
    setFormula(ws.getCell(row, 6), `SUM(F${first}:F${lastActive})`, { fmt: MONEY_FMT, bold: true, result: totalVal })
    setFormula(ws.getCell(row, 8), `SUM(H${first}:H${lastActive})`, { fmt: MONEY_FMT, bold: true, result: feeVal })
  } else {
    setData(ws.getCell(row, 6), 0, { fmt: MONEY_FMT, gray: true })
    setData(ws.getCell(row, 8), 0, { fmt: MONEY_FMT, gray: true })
  }
  row++
  // 手續費合計（逐筆按付款方式費率計，唔再用一個加權平均「費率」）
  setLabel(ws.getCell(row, 1), '減：手續費合計')
  for (let i = 2; i <= lastCol; i++) ws.getCell(row, i).border = thinBorder
  setLink(ws.getCell(row, 6), `H${totalRow}`, { fmt: MONEY_FMT, result: feeVal })
  const feeRow = row
  row++
  // 收入淨額 = 合計 − 手續費合計
  setLabel(ws.getCell(row, 1), LABEL_MISC_NET, { bold: true })
  for (let i = 2; i <= lastCol; i++) ws.getCell(row, i).border = thinBorder
  setFormula(ws.getCell(row, 6), `F${totalRow}-F${feeRow}`, { fmt: MONEY_FMT, bold: true, result: round2(totalVal - feeVal) })
  row++

  return ws
}

// ── 封面總表 ──────────────────────────────────────────────────────

/**
 * 封面總表（只喺全店月報出）— ★ cwm-coverrevenue-20260914 方案甲：
 * 逐醫生「店舖營收／應付醫生」兩欄 ＋ 合計 ＋ 三層結算
 * （店舖總收入 = 營收合計＋雜項淨額；診所淨收入 = 店舖總收入−應付醫生合計，黃底）
 * ＋ Free SP／Credit 備註區 ＋ 底部免責句。
 * 店舖營收 = 跨 sheet 連結醫生頁 A 區 Total 行（綠字）；搵唔到 anchor → setData fallback（唔報錯）。
 * 應付醫生 = 跨 sheet 連結醫生頁 F 區 B 欄（綠字）；搵唔到 anchor → setData fallback。
 * 舊「診所總收入 = 應付合計＋雜項」概念錯（應付 ≠ 店舖營收）→ 廢棄。
 */
export function buildCoverSheet(wb: ExcelJS.Workbook, c: CoverSheetData): ExcelJS.Worksheet {
  const name = nextSheetName(wb, '封面')
  const ws = wb.addWorksheet(name)
  // ★ cwm-coverrevenue-20260914 A5：3 欄→4 欄（逐醫生 店舖營收／應付醫生 兩欄）
  const lastCol = 4
  setWidths(ws, [24, 10, 16, 16])

  let row = 1
  ws.mergeCells(row, 1, row, lastCol)
  ws.getCell(row, 1).value = `${c.clinicName} · ${c.periodMonth} · 月度收入報表（總表）`
  ws.getCell(row, 1).font = mkFont({ bold: true, size: 14 })
  row += 2
  headerRow(ws, row, ['醫生', '狀態', '店舖營收', '應付醫生'])
  row++
  const firstDoc = row
  for (const doc of c.doctors) {
    setData(ws.getCell(row, 1), doc.providerName)
    setData(ws.getCell(row, 2), doc.status)
    const docWs = wb.getWorksheet(doc.sheetName)
    // 店舖營收：跨 sheet 連結醫生頁 A 區 Total 行（TOTAL 欄 = 2+M，M = methodCount）
    const revCell = ws.getCell(row, 3)
    const docTotalRowNo = docWs ? findLabelRow(docWs, 'Total') : null
    if (docWs && docTotalRowNo) {
      const quoted = doc.sheetName.replace(/'/g, "''")
      setLink(revCell, `'${quoted}'!${colName(2 + doc.methodCount)}${docTotalRowNo}`, { fmt: MONEY_FMT, result: doc.revenue })
    } else {
      // ★ MD A5：搵唔到 row → setData fallback，唔報錯
      setData(revCell, round2(doc.revenue), { fmt: MONEY_FMT })
    }
    // 應付醫生：跨 sheet 連結醫生頁 F 區 B 欄（F zone 值喺 B 欄，merged）— 照現行，搬咗去第 4 欄
    const payCell = ws.getCell(row, 4)
    const payRowNo = docWs ? findLabelRow(docWs, LABEL_PAYABLE) : null
    if (docWs && payRowNo) {
      const quoted = doc.sheetName.replace(/'/g, "''")
      setLink(payCell, `'${quoted}'!B${payRowNo}`, { fmt: MONEY_FMT, result: doc.totalAmount })
    } else {
      setData(payCell, round2(doc.totalAmount), { fmt: MONEY_FMT })
    }
    if (doc.draft) {
      for (let i = 1; i <= lastCol; i++) {
        ws.getCell(row, i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_DRAFT } }
      }
    }
    row++
  }
  const lastDoc = row - 1
  const totalRow = row
  setLabel(ws.getCell(row, 1), '合計', { bold: true })
  ws.getCell(row, 2).border = thinBorder
  const revSum = round2(c.doctors.reduce((s, d) => s + d.revenue, 0))
  const paySum = round2(c.doctors.reduce((s, d) => s + d.totalAmount, 0))
  if (c.doctors.length > 0) {
    setFormula(ws.getCell(row, 3), `SUM(C${firstDoc}:C${lastDoc})`, { fmt: MONEY_FMT, bold: true, result: revSum })
    setFormula(ws.getCell(row, 4), `SUM(D${firstDoc}:D${lastDoc})`, { fmt: MONEY_FMT, bold: true, result: paySum })
  } else {
    setData(ws.getCell(row, 3), 0, { fmt: MONEY_FMT, gray: true })
    setData(ws.getCell(row, 4), 0, { fmt: MONEY_FMT, gray: true })
  }
  row++

  // ★ cwm-draftreport-20261006：合計拆「已鎖定／草稿」兩行（公式逐格 SUM 返上面醫生行，唔靠狀態文字）
  const hasDraft = c.doctors.some(d => d.draft)
  const splitRow = (label: string, pick: (d: CoverSheetData['doctors'][number]) => boolean, fill?: string): void => {
    setLabel(ws.getCell(row, 1), label)
    ws.getCell(row, 2).border = thinBorder
    const idx = c.doctors.map((d, i) => (pick(d) ? firstDoc + i : -1)).filter(i => i >= 0)
    const rev = round2(c.doctors.filter(pick).reduce((s, d) => s + d.revenue, 0))
    const pay = round2(c.doctors.filter(pick).reduce((s, d) => s + d.totalAmount, 0))
    if (idx.length > 0) {
      setFormula(ws.getCell(row, 3), `SUM(${idx.map(i => `C${i}`).join(',')})`, { fmt: MONEY_FMT, result: rev })
      setFormula(ws.getCell(row, 4), `SUM(${idx.map(i => `D${i}`).join(',')})`, { fmt: MONEY_FMT, result: pay })
    } else {
      setData(ws.getCell(row, 3), 0, { fmt: MONEY_FMT, gray: true })
      setData(ws.getCell(row, 4), 0, { fmt: MONEY_FMT, gray: true })
    }
    if (fill) for (let i = 1; i <= lastCol; i++) ws.getCell(row, i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
    row++
  }
  if (c.doctors.length > 0) {
    splitRow('  其中：已鎖定', d => !d.draft)
    splitRow('  其中：草稿（未鎖定）', d => !!d.draft, hasDraft ? FILL_DRAFT : undefined)
  }

  // ── 結算區（五行）：★ A6 全部用【公式】＋ result 雙寫（規則①）；一律 SUM，禁裸 + ──
  // 行 1：醫生店舖營收合計
  setLabel(ws.getCell(row, 1), '醫生店舖營收合計')
  ws.getCell(row, 2).border = thinBorder
  setFormula(ws.getCell(row, 3), `C${totalRow}`, { fmt: MONEY_FMT, result: revSum })
  const r1 = row
  row++
  // 行 2：＋ Clinic 雜項（淨額）— 沿用現有跨 sheet 連結
  setLabel(ws.getCell(row, 1), '＋  Clinic 雜項（淨額）')
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
  const r2 = row
  row++
  // 行 3：＝ 店舖總收入 = 營收合計＋雜項淨額
  setLabel(ws.getCell(row, 1), '＝  店舖總收入', { bold: true })
  ws.getCell(row, 2).border = thinBorder
  setFormula(ws.getCell(row, 3), `SUM(C${r1},C${r2})`, { fmt: MONEY_FMT, bold: true, result: round2(revSum + c.miscNet) })
  const r3 = row
  row++
  // 行 4：− 應付醫生合計
  setLabel(ws.getCell(row, 1), '−   應付醫生合計')
  ws.getCell(row, 2).border = thinBorder
  setFormula(ws.getCell(row, 3), `D${totalRow}`, { fmt: MONEY_FMT, result: paySum })
  const r4 = row
  row++
  // 行 5：＝ 診所淨收入 = 店舖總收入−應付醫生合計
  // ★ A6：FILL_YELLOW 由舊「診所總收入」搬嚟呢度（舊嗰個數冇意義，唔應該高亮）
  setLabel(ws.getCell(row, 1), '＝  診所淨收入', { bold: true })
  ws.getCell(row, 2).border = thinBorder
  const netCell = ws.getCell(row, 3)
  setFormula(netCell, `C${r3}-C${r4}`, { fmt: MONEY_FMT, bold: true, result: round2(revSum + c.miscNet - paySum) })
  netCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_YELLOW } }
  row++
  if (hasDraft) {
    const n = c.doctors.filter(d => d.draft).length
    const noteCell = ws.getCell(row, 1)
    noteCell.value = `※ 黃底 = 草稿（未鎖定）${n} 位：按今日資料即時計，鎖定前數字可能會變；以上合計已包含草稿。`
    noteCell.font = mkFont({ bold: true, color: 'FF9C5700' })
    row++
  }
  row++

  // ── ★ cwm-draftreport-20261006：有收入但計唔到月結嘅醫生 —— 列名＋原因（唔准靜靜漏人）──
  if (c.failures && c.failures.length > 0) {
    setLabel(ws.getCell(row, 1), `未能計算（有收入但出唔到月結）${c.failures.length} 位`, { bold: true })
    for (let i = 2; i <= lastCol; i++) ws.getCell(row, i).border = thinBorder
    row++
    for (const f of c.failures) {
      setLabel(ws.getCell(row, 1), `  ${f.providerName}`)
      ws.mergeCells(row, 2, row, lastCol)
      const rc = ws.getCell(row, 2)
      rc.value = f.reason
      rc.font = mkFont({ color: 'FFC00000' })
      rc.alignment = { wrapText: true, vertical: 'top' }
      row++
    }
    row++
  }

  // ── 備註區（A7）：Free SP / Credit 分開列，全 0 都照出 ──
  // ★ MD A1：兩者性質唔同，加埋一齊列會令人嘗試加落營收 = double count；每行各要一句解釋
  setLabel(ws.getCell(row, 1), '備註 · 唔計入店舖營收', { bold: true })
  for (let i = 2; i <= lastCol; i++) ws.getCell(row, i).border = thinBorder
  row++
  setLabel(ws.getCell(row, 1), '  Free SP')
  ws.getCell(row, 2).border = thinBorder
  setData(ws.getCell(row, 3), round2(c.doctors.reduce((s, d) => s + d.freeSp, 0)), { fmt: MONEY_FMT })
  setLabel(ws.getCell(row, 4), '唔計店舖營收，已計入醫生收入（已包含喺上面「應付醫生」）', { gray: true, italic: true })
  row++
  setLabel(ws.getCell(row, 1), '  Credit')
  ws.getCell(row, 2).border = thinBorder
  setData(ws.getCell(row, 3), round2(c.doctors.reduce((s, d) => s + d.credit, 0)), { fmt: MONEY_FMT })
  setLabel(ws.getCell(row, 4), '店舖營收、醫生收入兩樣都唔計（記賬用）', { gray: true, italic: true })
  row += 2

  // ★ A8：底部免責句（唔准慳）— 冇佢會令人以為「診所淨收入」係最終盈利
  const disclaimer = ws.getCell(row, 1)
  disclaimer.value = '※「應付醫生」已扣 Lab／植體成本。「診所淨收入」未扣診所自身開支（租金、人工、器材）。'
  disclaimer.font = mkFont({ italic: true, color: COLOR_GRAY })

  return ws
}

// ── 每日大數（cwm-dailyrev-20261003）──────────────────────────────

/**
 * 每日大數頁：A 區同醫生頁「A 逐日收款」同一格式（行 = 醫生 或 逐日）＋ B 區醫生收入及分成。
 * 數字由 lib/payout/daily-report.ts 一次過計好（網頁同 Excel 同一份 data，唔准各計一次）。
 */
export function buildDailySheet(wb: ExcelJS.Workbook, d: DailyReport): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(nextSheetName(wb, '每日大數'))
  const M = d.methods.length
  const methodCol = (i: number): number => 2 + i
  const totalCol = 2 + M
  const spCountCol = 2 + M + 1
  const lastCol = Math.max(spCountCol, 6)
  setWidths(ws, Array.from({ length: lastCol }, (_, i) => (i === 0 ? 16 : i === spCountCol - 1 ? 9 : 12)))

  let row = 1
  ws.mergeCells(row, 1, row, lastCol)
  ws.getCell(row, 1).value = `每日大數 · ${d.title}`
  ws.getCell(row, 1).font = mkFont({ bold: true, size: 14 })
  row += 2

  // ── A 區 ──
  sectionTitle(ws, row, d.mode === 'byDoctor' ? 'A  逐醫生收款' : 'A  逐日收款', lastCol)
  row++
  headerRow(ws, row, [d.mode === 'byDoctor' ? '醫生' : '日期', ...d.methods.map(m => m.label), 'TOTAL', 'SP 筆數'], true)
  row++
  const aFirst = row
  for (const r of d.rows) {
    setData(ws.getCell(row, 1), r.label)
    let anyIncome = false
    d.methods.forEach((m, i) => {
      const v = r.byMethod[m.key] ?? 0
      const cell = ws.getCell(row, methodCol(i))
      if (v !== 0) {
        setData(cell, round2(v), { fmt: MONEY_FMT })
        if (m.storeIncome) anyIncome = true
      } else {
        cell.value = null
        cell.border = thinBorder
      }
    })
    const tCell = ws.getCell(row, totalCol)
    const parts = d.methods.map((m, i) => (m.storeIncome ? `${colName(methodCol(i))}${row}` : null)).filter(Boolean).join(',')
    if (anyIncome && parts) setFormula(tCell, `SUM(${parts})`, { fmt: MONEY_FMT, result: r.storeTotal })
    else { tCell.value = null; tCell.border = thinBorder }
    const spCell = ws.getCell(row, spCountCol)
    if (r.spCount > 0) setData(spCell, r.spCount)
    else { spCell.value = null; spCell.border = thinBorder }
    row++
  }
  const aLast = row - 1
  setLabel(ws.getCell(row, 1), 'Total', { bold: true })
  d.methods.forEach((m, i) => {
    const c = ws.getCell(row, methodCol(i))
    if (d.rows.length > 0) setFormula(c, `SUM(${colName(methodCol(i))}${aFirst}:${colName(methodCol(i))}${aLast})`, { fmt: MONEY_FMT, bold: true, result: d.totals.byMethod[m.key] ?? 0, gray: !m.storeIncome && !m.doctorIncome })
    else setData(c, 0, { fmt: MONEY_FMT, gray: true })
  })
  const atCell = ws.getCell(row, totalCol)
  if (d.rows.length > 0) setFormula(atCell, `SUM(${colName(totalCol)}${aFirst}:${colName(totalCol)}${aLast})`, { fmt: MONEY_FMT, bold: true, result: d.totals.storeTotal })
  else setData(atCell, 0, { fmt: MONEY_FMT, gray: true })
  atCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_YELLOW } }
  setData(ws.getCell(row, spCountCol), d.totals.spCount)
  // ★ cwm-dailyv2-20261007 ⑤：手續費＋已扣手續費（淨額）—— 同網頁同一份 data（totals）
  const feeRow = row + 1
  const netRow = row + 2
  setLabel(ws.getCell(feeRow, 1), '手續費', { gray: true, italic: true })
  d.methods.forEach((m, i) => {
    const c = ws.getCell(feeRow, methodCol(i))
    const fee = round2((d.totals.byMethod[m.key] ?? 0) - (d.totals.byMethodNet[m.key] ?? 0))
    if (d.rows.length > 0) setFormula(c, `${colName(methodCol(i))}${row}-${colName(methodCol(i))}${netRow}`, { fmt: MONEY_FMT, gray: true, result: fee })
    else setData(c, 0, { fmt: MONEY_FMT, gray: true })
  })
  {
    const c = ws.getCell(feeRow, totalCol)
    const fee = round2(d.totals.storeTotal - d.totals.storeNet)
    if (d.rows.length > 0) setFormula(c, `${colName(totalCol)}${row}-${colName(totalCol)}${netRow}`, { fmt: MONEY_FMT, gray: true, result: fee })
    else setData(c, 0, { fmt: MONEY_FMT, gray: true })
  }
  ws.getCell(feeRow, spCountCol).value = null
  ws.getCell(feeRow, spCountCol).border = thinBorder
  setLabel(ws.getCell(netRow, 1), '已扣手續費（淨額）', { bold: true })
  d.methods.forEach((m, i) => {
    const c = ws.getCell(netRow, methodCol(i))
    if (d.rows.length > 0) setStatic(c, d.totals.byMethodNet[m.key] ?? 0, { fmt: MONEY_FMT, bold: true, gray: !m.storeIncome && !m.doctorIncome })
    else setData(c, 0, { fmt: MONEY_FMT, gray: true })
  })
  {
    const c = ws.getCell(netRow, totalCol)
    const parts = d.methods.map((m, i) => (m.storeIncome ? `${colName(methodCol(i))}${netRow}` : null)).filter(Boolean).join(',')
    if (d.rows.length > 0 && parts) setFormula(c, `SUM(${parts})`, { fmt: MONEY_FMT, bold: true, result: d.totals.storeNet })
    else setData(c, 0, { fmt: MONEY_FMT, gray: true })
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_YELLOW } }
  }
  ws.getCell(netRow, spCountCol).value = null
  ws.getCell(netRow, spCountCol).border = thinBorder
  row += 4

  // ── B 區：醫生收入及分成 ──
  sectionTitle(ws, row, 'B  醫生收入及分成（未扣成本）', lastCol)
  row++
  headerRow(ws, row, [d.mode === 'byDoctor' ? '醫生' : '日期', '收款（醫生收入）', '手續費', '收入淨額', '醫生分成'], true)
  row++
  const bFirst = row
  for (const r of d.rows) {
    if (r.key === CLINIC_ROW_KEY) continue // ★ cwm-dailyv3：B 區（醫生收入及分成）跳過 Clinic 雜項行
    setData(ws.getCell(row, 1), r.label)
    setData(ws.getCell(row, 2), r.doctorRaw, { fmt: MONEY_FMT })
    setFormula(ws.getCell(row, 3), `B${row}-D${row}`, { fmt: MONEY_FMT, result: round2(r.doctorRaw - r.doctorNet) })
    setData(ws.getCell(row, 4), r.doctorNet, { fmt: MONEY_FMT })
    if (r.share != null) setData(ws.getCell(row, 5), r.share, { fmt: MONEY_FMT })
    else setLabel(ws.getCell(row, 5), '未設拆帳', { gray: true, italic: true })
    row++
  }
  const bLast = row - 1
  setLabel(ws.getCell(row, 1), 'Total', { bold: true })
  for (const [col, result] of [[2, d.totals.doctorRaw], [3, round2(d.totals.doctorRaw - d.totals.doctorNet)], [4, d.totals.doctorNet], [5, d.totals.share ?? 0]] as [number, number][]) {
    const c = ws.getCell(row, col)
    if (d.rows.length > 0) setFormula(c, `SUM(${colName(col)}${bFirst}:${colName(col)}${bLast})`, { fmt: MONEY_FMT, bold: true, result })
    else setData(c, 0, { fmt: MONEY_FMT, gray: true })
  }
  ws.getCell(row, 5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_YELLOW } }
  row += 2

  const notes = [
    'TOTAL = 店舖營收（只計計入營收嘅付款方式）；灰字欄唔計店舖營收。',
    `醫生分成 = 收入淨額 × 拆帳比例${d.percent != null ? `（${d.percent}%）` : ''}；未扣 Lab／植牙成本，未計 SP 補貼／轉介／調整 —— 以月結單為準。`,
    ...(d.missingCommission.length ? [`未設拆帳：${d.missingCommission.join('、')}`] : []),
  ]
  for (const n of notes) {
    ws.mergeCells(row, 1, row, lastCol)
    ws.getCell(row, 1).value = n
    ws.getCell(row, 1).font = mkFont({ italic: true, color: COLOR_GRAY })
    row++
  }
  return ws
}
