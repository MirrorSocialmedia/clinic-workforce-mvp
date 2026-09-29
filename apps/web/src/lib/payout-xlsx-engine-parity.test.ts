/**
 * src/lib/payout-xlsx-engine-parity.test.ts — cwm-payout P-1 parity test
 *
 * ★ 目的（MD §1.5）：醫生月結 Excel F 區（收款總額／收入淨額／應付總額）必須同
 *   `lib/payout/engine.ts` L391–401 完全同口徑 —— 醫生收入 = countAsIncome || FREE_SP。
 *   CREDIT、HCV（countAsIncome=false 規則）唔計醫生收入；FREE_SP 唔計店舖營收但計醫生收入。
 *   2026-08 事故：Excel F 區把 CREDIT 2,500 當收入計 → 應付 319,443.80（系統 318,193.80）。
 *
 * ★ 方法：fake prisma（loadDoctorSheetData(runId, db) 可選注入 — P-1 改動）→ 零 DB 依賴；
 *   直接讀 ExcelJS workbook cell（formula + cached result）斷言。
 *
 * Fixture A（parity，percent 50%）：
 *   CASH    true   19,080   fee 0
 *   VISA    true   306,310  fee 2%  → net 300,183.80
 *   FREE_SP false   1,000   fee 0   （snapshot 行：engine 計醫生收入）
 *   CREDIT  false   2,500   fee 0   （extra 行：兩樣都唔計）
 *   HCV     false   4,440   fee 0   （extra 行：規則設咗唔計收入）
 *   Lab 42,216 / Implant 4,643.20
 *   gross   = 19,080 + 300,183.80 + 1,000          = 320,263.80
 *   profit  = 320,263.80 − 42,216 − 4,643.20        = 273,404.60
 *   payable = 273,404.60 × 50%                      = 136,702.30
 *
 * CI：加返入 .github/workflows/ci.yml 嘅 test 清單（no-DB：fake prisma）。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import ExcelJS from 'exceljs'
import { loadDoctorSheetData } from './payout/report-data'
import { buildDoctorSheet, buildCoverSheet, LABEL_PAYABLE, incomeTotalOf } from './payout/xlsx-report'

const PERIOD = '2026-08'
const r2 = (n: number): number => Math.round(n * 100) / 100

type AllocRow = {
  method: string
  countAsIncome?: boolean
  rawAmount: number
  netAmount: number
  feePercentUsed: number
  paidAt: string
}

function alloc(
  method: string,
  countAsIncome: boolean,
  amount: number,
  feePct: number,
  paidAt = '2026-08-05T12:00:00+08:00',
): AllocRow {
  return {
    method,
    countAsIncome,
    rawAmount: amount,
    netAmount: r2(amount * (1 - feePct)),
    feePercentUsed: feePct,
    paidAt,
  }
}

function makeRun(breakdown: AllocRow[], totalAmount: number, stripCountAsIncome = false) {
  const bd = stripCountAsIncome
    ? breakdown.map(({ countAsIncome: _omit, ...rest }) => rest) // 舊 run 快照冇該欄
    : breakdown
  return {
    id: 'run-parity-1',
    providerId: 'prov1',
    clinicId: 'cl1',
    periodMonth: PERIOD,
    status: 'DRAFT',
    lockedAt: null,
    percentUsed: 50, // DB 存百分數
    totalAmount,
    breakdownJson: bd,
  }
}

function makeFakeDb(run: ReturnType<typeof makeRun>, extraAllocs: AllocRow[], costs: any[]) {
  return {
    payoutRun: { findUnique: async () => run },
    provider: { findUnique: async () => ({ id: 'prov1', name: 'Dr. Test', shortName: 'DrT' }) },
    clinic: {
      findUnique: async () => ({ id: 'cl1', name: 'Test Clinic', shortName: 'TC', apricotClinicId: 'cl-ext' }),
    },
    // ★ ApricotPractitioner 係醫生↔Apricot 帳號唯一來源 — 冇綁帳號 extra 行撈唔到
    apricotPractitioner: { findMany: async () => [{ apricotId: 'prov-ext' }] },
    paymentAllocation: {
      findMany: async () =>
        extraAllocs.map(a => ({
          methodNorm: a.method,
          amount: a.rawAmount,
          netAmount: a.netAmount,
          feePercentUsed: a.feePercentUsed,
          paidAt: a.paidAt,
          billExtId: null,
        })),
    },
    apricotBill: { findMany: async () => [] },
    spSubsidy: { findMany: async () => [] },
    providerReferral: { findMany: async () => [] },
    payoutAdjustment: { findMany: async () => [] },
    costCase: { findMany: async () => costs },
    materialItem: { findMany: async () => [] },
  }
}

const COSTS = [
  {
    id: 'c-lab', category: 'LAB', itemType: 'CROWNS', finalCost: 42216,
    orderedAt: '2026-08-10T10:00:00+08:00', patientCode: 'P1', patientName: 'A',
    labOther: 'LabX', materials: [],
  },
  {
    id: 'c-imp', category: 'IMPLANT', itemType: 'IMPLANT', finalCost: 4643.2,
    orderedAt: '2026-08-12T10:00:00+08:00', patientCode: 'P2', patientName: 'B',
    labOther: '', materials: [],
  },
]

// Fixture A 常數（MD §1.5）
const BREAKDOWN_A: AllocRow[] = [
  alloc('CASH', true, 19080, 0),
  alloc('VISA', true, 306310, 0.02), // net 300,183.80
  alloc('FREE_SP', false, 1000, 0),
]
const EXTRA_A: AllocRow[] = [
  alloc('CREDIT', false, 2500, 0),
  alloc('HCV', false, 4440, 0),
]
const GROSS_A = r2(19080 + r2(306310 * 0.98) + 1000) // 320,263.80
const PROFIT_A = r2(GROSS_A - 42216 - 4643.2) // 273,404.60
const PAYABLE_A = r2(PROFIT_A * 0.5) // 136,702.30
const DOCTOR_COLLECT_A = r2(19080 + 306310 + 1000) // 326,390（收款總額 = 醫生收入欄 raw）
const EXCLUDED_A = r2(2500 + 4440) // 6,940（不計醫生收入對數行）
const STORE_TOTAL_A = r2(19080 + 306310) // 325,390（A 區 TOTAL = countAsIncome 欄 raw）

// ── cell 讀取 helpers ─────────────────────────────────────────────
function cellText(v: ExcelJS.CellValue): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'result' in (v as any)) return String((v as any).result ?? '')
  return ''
}
function findLabelRow(ws: ExcelJS.Worksheet, label: string, prefix = false): number | null {
  for (let r = 1; r <= 300; r++) {
    const t = cellText(ws.getCell(r, 1).value as ExcelJS.CellValue)
    if (prefix ? t.startsWith(label) : t === label) return r
  }
  return null
}
const colLetter = (n: number): string => {
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}
/** 公式引用嘅欄位（A..Z）集合 — 例如 'SUM(B5,D5)' → ['B','D'] */
function formulaCols(formula: string): string[] {
  const cols = new Set<string>()
  for (const m of formula.matchAll(/([A-Z]+)\d+/g)) cols.add(m[1])
  return [...cols]
}
function cellFormula(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getCell(row, col).value
  return v && typeof v === 'object' && 'formula' in (v as any) ? String((v as any).formula) : ''
}
function cellResult(ws: ExcelJS.Worksheet, row: number, col: number): number {
  const v = ws.getCell(row, col).value
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && 'result' in (v as any)) return Number((v as any).result)
  return 0
}

/** method key → 欄位號（methodCol(i) = 2+i，同產生器同一把尺） */
const methodColOf = (data: { methods: { key: string }[] }, key: string): number =>
  2 + data.methods.findIndex(m => m.key === key)

async function buildSheet(run: ReturnType<typeof makeRun>, extra: AllocRow[]) {
  const loaded = await loadDoctorSheetData(run.id, makeFakeDb(run, extra, COSTS))
  assert.ok(loaded, 'loadDoctorSheetData 必須有返 data')
  const wb = new ExcelJS.Workbook()
  const { ws, payable } = buildDoctorSheet(wb, loaded!.data)
  return { wb, ws, data: loaded!.data, payable }
}

// ── 測試 ─────────────────────────────────────────────────────────

test('P-1 §1.5-1：F 區「收入淨額」TOTAL = engine gross（CASH + VISA 淨額 + FREE_SP；唔包 CREDIT、HCV）', async () => {
  const { ws, data } = await buildSheet(makeRun(BREAKDOWN_A, PAYABLE_A), EXTRA_A)
  const M = data.methods.length
  const totalCol = 2 + M
  const netRow = findLabelRow(ws, '收入淨額')
  assert.ok(netRow, '搵唔到「收入淨額」行')
  assert.strictEqual(cellResult(ws, netRow!, totalCol), GROSS_A, '收入淨額 TOTAL ≠ engine gross')
})

test('P-1 §1.5-2：「應付總額」result = engine totalAmount（136,702.30）', async () => {
  const { ws, payable } = await buildSheet(makeRun(BREAKDOWN_A, PAYABLE_A), EXTRA_A)
  const payRow = findLabelRow(ws, LABEL_PAYABLE)
  assert.ok(payRow, '搵唔到「應付總額」行')
  assert.strictEqual(cellResult(ws, payRow!, 2), PAYABLE_A, '應付總額 ≠ engine totalAmount')
  assert.strictEqual(payable, PAYABLE_A, 'buildDoctorSheet 返回嘅 payable 同 cell cached result 必須一致')
})

test('P-1 §1.5-3：F 區 TOTAL 公式引用嘅格唔包 CREDIT、HCV 欄（公式層面斷言，唔淨係信 cached result）', async () => {
  const { ws, data } = await buildSheet(makeRun(BREAKDOWN_A, PAYABLE_A), EXTRA_A)
  const M = data.methods.length
  const totalCol = 2 + M
  const netRow = findLabelRow(ws, '收入淨額')!
  const collectRow = findLabelRow(ws, '收款總額')!
  for (const row of [collectRow, netRow]) {
    const formula = cellFormula(ws, row, totalCol)
    assert.ok(formula.startsWith('SUM('), `${row} TOTAL 必須係 SUM 公式：${formula}`)
    const cols = formulaCols(formula)
    for (const ex of ['CREDIT', 'HCV']) {
      const c = colLetter(methodColOf(data, data.methods.find(m => m.key.startsWith(ex + '|'))!.key))
      assert.ok(!cols.includes(c), `${row} 行公式引用咗 ${ex} 欄（${c}）：${formula}`)
    }
    // 醫生收入欄（CASH/VISA/FREE_SP）必須全部入公式
    for (const inc of ['CASH', 'VISA', 'FREE_SP']) {
      const m = data.methods.find(mm => mm.key.startsWith(inc + '|'))!
      const c = colLetter(methodColOf(data, m.key))
      assert.ok(cols.includes(c), `${row} 行公式漏咗 ${inc} 欄（${c}）：${formula}`)
    }
  }
  // 收款總額 result = 醫生收入欄 raw 合計
  assert.strictEqual(cellResult(ws, collectRow, totalCol), DOCTOR_COLLECT_A)
})

test('P-1 §1.5-4：A 區 TOTAL（店舖營收）唔包 CREDIT、FREE_SP、HCV', async () => {
  const { ws, data } = await buildSheet(makeRun(BREAKDOWN_A, PAYABLE_A), EXTRA_A)
  const M = data.methods.length
  const totalCol = 2 + M
  // 有收入嗰日（05/08）嘅 TOTAL 格
  const dayRow = findLabelRow(ws, '05/08')
  assert.ok(dayRow, '搵唔到 05/08 日行')
  const formula = cellFormula(ws, dayRow!, totalCol)
  assert.ok(formula.startsWith('SUM('), `A 區 TOTAL 必須係 SUM 公式：${formula}`)
  const cols = formulaCols(formula)
  for (const ex of ['CREDIT', 'FREE_SP', 'HCV']) {
    const m = data.methods.find(mm => mm.key.startsWith(ex + '|'))!
    const c = colLetter(methodColOf(data, m.key))
    assert.ok(!cols.includes(c), `A 區 TOTAL 公式引用咗 ${ex} 欄（${c}）：${formula}`)
  }
  assert.strictEqual(cellResult(ws, dayRow!, totalCol), STORE_TOTAL_A, 'A 區 TOTAL ≠ countAsIncome 欄 raw 合計')
  // 全月 Total 行 = 逐日加總同口徑
  const totalRow = findLabelRow(ws, 'Total')
  assert.strictEqual(cellResult(ws, totalRow!, totalCol), STORE_TOTAL_A)
})

test('P-1 §1.5-5：「不計醫生收入」對數行 = 2,500 + 4,440 = 6,940（灰字、唔入任何合計）', async () => {
  const { ws } = await buildSheet(makeRun(BREAKDOWN_A, PAYABLE_A), EXTRA_A)
  const row = findLabelRow(ws, '不計醫生收入', true)
  assert.ok(row, '搵唔到「不計醫生收入（...）」對數行')
  const label = cellText(ws.getCell(row!, 1).value as ExcelJS.CellValue)
  assert.ok(label.includes('CREDIT') && label.includes('HCV'), `對數行 label 要列明方法：${label}`)
  assert.strictEqual(cellResult(ws, row!, 2), EXCLUDED_A)
})

test('P-1 §1.5-6：截圖真實數字（§1.1 謝德輝 TW 2026-08）— 應付總額 = 318,193.80', async () => {
  // 系統口徑：收入淨額 683,246.80 − Lab 42,216 − Implant 4,643.20 = 636,387.60 × 50% = 318,193.80
  // （CREDIT 2,500 唔計醫生收入；Excel 舊 bug 會多計 → 319,443.80）
  const breakdown = [alloc('CASH', true, 683246.8, 0)]
  const extra = [alloc('CREDIT', false, 2500, 0)]
  const { ws, payable } = await buildSheet(makeRun(breakdown, 318193.8), extra)
  const payRow = findLabelRow(ws, LABEL_PAYABLE)!
  assert.strictEqual(cellResult(ws, payRow, 2), 318193.8, '應付總額必須 = 系統數 318,193.80')
  assert.strictEqual(payable, 318193.8)
})

test('P-1 §1.5-7：舊 run（breakdown 冇 countAsIncome 欄）— fallback 結果同新 run 一致（MD §1.5-1/2 口徑）', async () => {
  const old = await buildSheet(makeRun(BREAKDOWN_A, PAYABLE_A, true), EXTRA_A)
  const fresh = await buildSheet(makeRun(BREAKDOWN_A, PAYABLE_A), EXTRA_A)
  const M = old.data.methods.length
  const totalCol = 2 + M
  const netOld = findLabelRow(old.ws, '收入淨額')!
  const netNew = findLabelRow(fresh.ws, '收入淨額')!
  assert.strictEqual(cellResult(old.ws, netOld, totalCol), cellResult(fresh.ws, netNew, totalCol), '收入淨額 TOTAL 舊/新 run 必須一致')
  assert.strictEqual(cellResult(old.ws, netOld, totalCol), GROSS_A, '收入淨額 = engine gross')
  const payOld = findLabelRow(old.ws, LABEL_PAYABLE)!
  const payNew = findLabelRow(fresh.ws, LABEL_PAYABLE)!
  assert.strictEqual(cellResult(old.ws, payOld, 2), cellResult(fresh.ws, payNew, 2), '應付總額 舊/新 run 必須一致')
  assert.strictEqual(cellResult(old.ws, payOld, 2), PAYABLE_A, '應付總額 = engine totalAmount')
  // 舊 run fallback：breakdown 行 storeIncome = !NON_INCOME.has(method)
  //   → CASH/VISA 計店舖營收、FREE_SP 唔計（寫死口徑）；extra 行（CREDIT/HCV）恆兩樣唔計
  const storeOld = findLabelRow(old.ws, 'Total')!
  const storeNew = findLabelRow(fresh.ws, 'Total')!
  assert.strictEqual(cellResult(old.ws, storeOld, totalCol), STORE_TOTAL_A)
  assert.strictEqual(cellResult(fresh.ws, storeNew, totalCol), STORE_TOTAL_A)
})

test('P-1 §1.5-8：全店月報封面「應付醫生」cached result = 醫生頁應付總額 result（跨 sheet 連結一致）', async () => {
  const { wb, ws, data } = await buildSheet(makeRun(BREAKDOWN_A, PAYABLE_A), EXTRA_A)
  const M = data.methods.length
  const totalCol = 2 + M
  const payRow = findLabelRow(ws, LABEL_PAYABLE)!
  const payableResult = cellResult(ws, payRow, 2)
  const revenue = r2(data.days.reduce((s, day) => s + incomeTotalOf(data.methods, day.byMethod), 0))
  const cover = buildCoverSheet(wb, {
    clinicName: 'Test Clinic',
    periodMonth: PERIOD,
    doctors: [
      {
        providerName: 'Dr. Test',
        sheetName: ws.name,
        status: 'DRAFT',
        totalAmount: payableResult,
        revenue,
        freeSp: 1000,
        credit: 2500,
        methodCount: M,
      },
    ],
    miscNet: 0,
  })
  // 封面醫生行：第 1 欄 = 醫生名，第 4 欄 = 應付醫生
  let docRow: number | null = null
  for (let r = 1; r <= 300; r++) {
    if (cellText(cover.getCell(r, 1).value as ExcelJS.CellValue) === 'Dr. Test') { docRow = r; break }
  }
  assert.ok(docRow, '封面搵唔到醫生行')
  const v = cover.getCell(docRow!, 4).value
  assert.ok(v && typeof v === 'object' && 'formula' in (v as any), '應付醫生必須係跨 sheet 公式連結')
  assert.strictEqual(Number((v as any).result), payableResult, '封面 cached result ≠ 醫生頁應付總額')
  assert.ok(
    String((v as any).formula).includes(`B${payRow}`),
    `封面公式必須連去醫生頁 B${payRow}：${(v as any).formula}`,
  )
})
