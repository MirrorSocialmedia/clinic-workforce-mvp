/**
 * ★ cwm-chequetpl-20261004：出糧總表模版
 *   ① LEGACY_CONFIG 出嘅 Excel 同舊 route 逐格一樣（舊 aoa 邏輯原封不動抄落 legacyBuild 做參照）
 *   ② 按出糧診所分組＋調組＋小計（SUBTOTAL 唔會重複計）＋每組一張 Sheet
 * 跑法: TZ=UTC npx tsx --test src/lib/cheque-sheet/build.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { buildChequeWorkbook, sheetRowFrom, safeSheetName, type PlaceRef } from './build'
import { LEGACY_CONFIG, NEW_TEMPLATE_DEFAULT, normalizeSheetConfig } from './config'

const place = (clinicId: string, clinicName: string, companyId: string | null, companyName: string): PlaceRef => ({ clinicId, clinicName, companyId, companyName })
const TW = place('c-tw', '大圍', 'co-z', '臻善')
const YL = place('c-yl', '元朗', 'co-w', '匯樂')
const TY = place('c-ty', '青衣', 'co-j', '菁薈')

const item = (name: string, full: string | null, o: { gross: number; mpf: number; net: number; misc?: number; cheque?: string | null; hourly?: number; monthly?: number; tbDed?: number; broken?: boolean }) => ({
  id: `i-${name}`,
  detailJson: o.broken ? '{bad' : JSON.stringify({ grossPay: o.gross, mpf: o.mpf, netPay: o.net, ...(o.tbDed ? { resignSettlement: { tbDeduction: o.tbDed } } : {}) }),
  miscAmount: o.misc ?? 0,
  totalPayable: o.net + (o.misc ?? 0),
  chequeNo: o.cheque ?? null,
  workedHours: 160, otHours: 0, leaveDays: 1, absentDays: 0, basePay: o.gross, otPay: 0, splitPay: null, deduction: 0, storeBonus: 0, maternityPay: 0, paternityPay: 0,
  employee: {
    id: `e-${name}`,
    user: { name, fullName: full },
    payRules: [{ payType: o.hourly ? 'HOURLY' : 'MONTHLY', configJson: JSON.stringify(o.hourly ? { base_type: 'hourly', hourly_rate: o.hourly } : { base_type: 'monthly', monthly_salary: o.monthly ?? o.gross }) }],
  },
})

const RUNS = [
  { status: 'DRAFT', home: TW, items: [item('Kelly', 'Kelly Lam', { gross: 10400, mpf: 520, net: 9880, misc: 35.5, hourly: 80, cheque: '000123' }), item('Amy', null, { gross: 18000, mpf: 900, net: 17100, misc: 120 })] },
  { status: 'FINALIZED', home: YL, items: [item('Jason', 'Jason Ho', { gross: 16500, mpf: 825, net: 15000, tbDed: 675 }), item('Suki', 'Suki Lee', { gross: 15000, mpf: 750, net: 14250, misc: 22.9, broken: false })] },
  { status: 'FINALIZED', home: TY, items: [item('Bessie', 'Liang', { gross: 26500, mpf: 1325, net: 25175 })] },
]

// ── 舊 route 嘅 aoa 邏輯（cwm-payrollsheet S4，原封不動，只係改成食 RUNS） ──
function legacyBuild(runs: typeof RUNS, anyDraft: boolean, monthAbbr: string): XLSX.WorkSheet {
  const rows: any[] = []
  for (const run of runs) {
    const companyName = run.home.companyName
    for (const it of run.items as any[]) {
      let detailBroken = false
      let detail: any = {}
      try { detail = it.detailJson ? JSON.parse(it.detailJson) : {} } catch { detailBroken = true }
      const salary = Number(detail.grossPay) || 0
      const mpf = Number(detail.mpf) || 0
      const net = Number(detail.netPay) || 0
      const fare = Number(it.miscAmount) || 0
      const total = Number(it.totalPayable) || 0
      const tbDed = Number(detail.resignSettlement?.tbDeduction) || 0
      let basic: number | string | null = null
      const cfg = JSON.parse(it.employee.payRules[0].configJson)
      if (cfg?.base_type === 'hourly' && typeof cfg.hourly_rate === 'number') basic = `${cfg.hourly_rate} /HR`
      else if (typeof cfg?.monthly_salary === 'number') basic = cfg.monthly_salary
      const notes: string[] = []
      if (detailBroken) notes.push('⚠ 明細資料損壞，金額未必齊 — 請人手核對')
      if (tbDed > 0) notes.push(`含離職扣減 $${tbDed.toFixed(2)}`)
      if (Math.abs(salary - mpf - tbDed - net) > 0.005) notes.push('⚠ Net Pay 截零（負數）')
      if (Math.abs(net + fare - total) > 0.005) notes.push('⚠ Net+FARE≠Total')
      rows.push({ companyKey: run.home.companyId ?? '__all__', companyName, nickname: it.employee.user.name, fullName: it.employee.user.fullName ?? it.employee.user.name, basic, net, mpf, salary, fare, total, cheque: it.chequeNo ?? '', note: notes.join('；') })
    }
  }
  rows.sort((a, b) => a.companyName.localeCompare(b.companyName, 'zh-HK') || a.nickname.localeCompare(b.nickname, 'en'))
  const HEADERS = ['暱稱', 'Full Name', 'B.Basic Salary', 'Net Pay', 'MPF', 'Salary', 'FARE', 'Total', 'Cheque No.', '備註']
  const aoa: any[][] = []
  const row1: any[] = HEADERS.map(() => null); row1[2] = monthAbbr; aoa.push(row1)
  aoa.push(HEADERS)
  let dataStart = 2
  if (anyDraft) { aoa.push(['⚠️ 包含未確認計糧單（DRAFT）—— 數字未必最終', null, null, null, null, null, null, null, null, null]); dataStart = 3 }
  let last: string | null = null
  for (const r of rows) {
    if (r.companyKey !== last) { last = r.companyKey; aoa.push([`── ${r.companyName} `, null, null, null, null, null, null, null, null, null]) }
    aoa.push([r.nickname, r.fullName, r.basic === null ? null : r.basic, r.net, r.mpf, r.salary, r.fare, r.total, r.cheque, r.note || null])
  }
  const sumRow: any[] = HEADERS.map(() => null); sumRow[0] = '合計'; aoa.push(sumRow)
  const sumRowIndex = aoa.length - 1
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const sums: Record<number, number> = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }
  for (const r of rows) { if (typeof r.basic === 'number') sums[2] += r.basic; sums[3] += r.net; sums[4] += r.mpf; sums[5] += r.salary; sums[6] += r.fare; sums[7] += r.total }
  for (const c of [2, 3, 4, 5, 6, 7]) {
    ws[XLSX.utils.encode_cell({ r: sumRowIndex, c })] = { t: 'n', f: `SUM(${XLSX.utils.encode_col(c)}${dataStart + 1}:${XLSX.utils.encode_col(c)}${sumRowIndex})`, v: Math.round(sums[c] * 100) / 100, z: '#,##0.00' }
  }
  for (let ri = dataStart; ri <= sumRowIndex - 1; ri++) {
    for (const c of [2, 3, 4, 5, 6, 7]) { const cell = ws[XLSX.utils.encode_cell({ r: ri, c })]; if (cell && cell.t === 'n') cell.z = '#,##0.00' }
    const cc = ws[XLSX.utils.encode_cell({ r: ri, c: 8 })]; if (cc && cc.v !== null && cc.v !== undefined) cc.t = 's'
  }
  return ws
}

function newRows(runs: typeof RUNS, groupBy: any, payerOf: (empId: string, home: PlaceRef) => PlaceRef = (_e, h) => h, orderOf: (empId: string) => number | null = () => null) {
  return runs.flatMap(run => run.items.map(it => sheetRowFrom(it, { home: run.home, payer: payerOf(it.employee.id, run.home), groupBy, sortOrder: orderOf(it.employee.id) })))
}
const cells = (ws: XLSX.WorkSheet) => Object.fromEntries(Object.entries(ws).filter(([k]) => !k.startsWith('!')).map(([k, v]: any) => [k, { t: v.t, v: v.v, f: v.f, z: v.z }]))

describe('LEGACY_CONFIG = 舊版出糧總表', () => {
  for (const anyDraft of [true, false]) {
    it(`逐格一樣（${anyDraft ? '有' : '冇'}草稿）`, () => {
      const wb = buildChequeWorkbook(newRows(RUNS, 'COMPANY'), LEGACY_CONFIG, { monthAbbr: 'SEP', anyDraft })
      assert.deepEqual(wb.SheetNames, ['出糧總表'])
      const got = wb.Sheets['出糧總表'], want = legacyBuild(RUNS, anyDraft, 'SEP')
      assert.equal(got['!ref'], want['!ref'])
      assert.deepEqual(cells(got), cells(want))
    })
  }
})

describe('自訂模版', () => {
  // Jason 屬元朗，但喺大圍出糧
  const payerOf = (e: string, h: PlaceRef) => (e === 'e-Jason' ? TW : h)
  const cfg = normalizeSheetConfig({ ...NEW_TEMPLATE_DEFAULT, columns: [{ key: 'nickname', header: '名' }, { key: 'totalPayable', header: 'Total' }, { key: 'payerClinic' }, { key: 'note' }] })

  it('按出糧診所分組；調咗組嘅人入新組＋備註所屬；每組一張 Sheet＋全部', () => {
    const wb = buildChequeWorkbook(newRows(RUNS, 'CLINIC', payerOf), cfg, { monthAbbr: 'SEP', anyDraft: false })
    const groups = ['臻善 · 大圍', '匯樂 · 元朗', '菁薈 · 青衣'].sort((a, b) => a.localeCompare(b, 'zh-HK'))
    assert.deepEqual(wb.SheetNames, [...groups, '全部（合計）'])
    const tw = XLSX.utils.sheet_to_json<any[]>(wb.Sheets['臻善 · 大圍'], { header: 1, defval: null })
    const names = tw.map(r => r[0])
    assert.deepEqual(names, [null, '名', '── 臻善 · 大圍 ', 'Amy', 'Jason', 'Kelly', '小計', '合計'])
    const jason = tw.find(r => r[0] === 'Jason')!
    assert.match(String(jason[3]), /所屬：匯樂 · 元朗/)
    assert.equal(jason[2], '臻善 · 大圍')
  })

  it('小計用 SUBTOTAL，合計唔會重複計小計', () => {
    const wb = buildChequeWorkbook(newRows(RUNS, 'CLINIC', payerOf), cfg, { monthAbbr: 'SEP', anyDraft: false })
    const ws = wb.Sheets['全部（合計）']
    const aoa = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: null })
    const totalR = aoa.findIndex(r => r[0] === '合計')
    const cell = ws[XLSX.utils.encode_cell({ r: totalR, c: 1 })]
    assert.match(cell.f, /^SUBTOTAL\(9,B3:B\d+\)$/)
    const expected = RUNS.flatMap(r => r.items).reduce((s, i) => s + i.totalPayable, 0)
    assert.equal(cell.v, Math.round(expected * 100) / 100)
    const subs = aoa.map((r, i) => (r[0] === '小計' ? ws[XLSX.utils.encode_cell({ r: i, c: 1 })].v : null)).filter(v => v != null)
    assert.equal(Math.round(subs.reduce((a: number, b: number) => a + b, 0) * 100) / 100, cell.v)
  })

  it('自訂次序：有次序排前，冇次序按暱稱排最尾', () => {
    const order: Record<string, number> = { 'e-Kelly': 1, 'e-Jason': 2 }
    const c2 = { ...cfg, sort: 'CUSTOM' as const, sheetPerGroup: false }
    const wb = buildChequeWorkbook(newRows(RUNS, 'CLINIC', payerOf, e => order[e] ?? null), c2, { monthAbbr: 'SEP', anyDraft: false })
    const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets['出糧總表'], { header: 1, defval: null })
    const st = aoa.findIndex(r => r[0] === '── 臻善 · 大圍 ') + 1
    const tw = aoa.slice(st, aoa.findIndex((r, i) => i >= st && r[0] === '小計')).map(r => r[0])
    assert.deepEqual(tw, ['Kelly', 'Jason', 'Amy'])
  })

  it('唔分組：冇組標題、冇小計', () => {
    const wb = buildChequeWorkbook(newRows(RUNS, 'NONE'), { ...cfg, groupBy: 'NONE' }, { monthAbbr: 'SEP', anyDraft: false })
    assert.deepEqual(wb.SheetNames, ['出糧總表'])
    const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets['出糧總表'], { header: 1, defval: null })
    assert.ok(!aoa.some(r => String(r[0] ?? '').startsWith('──') || r[0] === '小計'))
    assert.equal(aoa.filter(r => ['Amy', 'Bessie', 'Jason', 'Kelly', 'Suki'].includes(r[0])).length, 5)
  })

  it('支票號碼保持文字（前導零）', () => {
    const c3 = normalizeSheetConfig({ ...cfg, columns: [{ key: 'nickname' }, { key: 'chequeNo' }], sheetPerGroup: false })
    const wb = buildChequeWorkbook(newRows(RUNS, 'CLINIC'), c3, { monthAbbr: 'SEP', anyDraft: false })
    const ws = wb.Sheets['出糧總表']
    const aoa = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: null, raw: false })
    const r = aoa.findIndex(x => x[0] === 'Kelly')
    const cell = ws[XLSX.utils.encode_cell({ r, c: 1 })]
    assert.deepEqual([cell.t, cell.v], ['s', '000123'])
  })
})

describe('normalizeSheetConfig / safeSheetName', () => {
  it('未知欄、重複欄剷走；表頭空 = 預設；冇欄 = 舊版欄', () => {
    const c = normalizeSheetConfig({ columns: [{ key: 'mpf', header: '  ' }, { key: 'evil' }, { key: 'mpf', header: 'x' }], groupBy: 'HACK' })
    assert.deepEqual(c.columns, [{ key: 'mpf', header: 'MPF' }])
    assert.equal(c.groupBy, 'CLINIC')
    assert.equal(normalizeSheetConfig({ columns: [] }).columns.length, LEGACY_CONFIG.columns.length)
  })
  it('工作表名：去非法字、限 31 字、唔重複', () => {
    const used = new Set<string>()
    assert.equal(safeSheetName('A/B', used), 'A B')
    assert.equal(safeSheetName('A/B', used), 'A B (2)')
    assert.equal(safeSheetName('x'.repeat(40), used).length, 31)
  })
})

describe('fix：欄闊＋草稿警告', () => {
  it('每欄夠闊放得落最長值（合計唔會出 ########）', () => {
    const cfg = normalizeSheetConfig(NEW_TEMPLATE_DEFAULT)
    const wb = buildChequeWorkbook(newRows(RUNS, 'CLINIC'), cfg, { monthAbbr: 'SEP', anyDraft: true })
    const ws = wb.Sheets['全部（合計）']
    const totalCol = cfg.columns.findIndex(c => c.key === 'totalPayable')
    const aoa = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: null })
    const totalR = aoa.findIndex(r => r[0] === '合計')
    const shown = ws[XLSX.utils.encode_cell({ r: totalR, c: totalCol })].v.toLocaleString('en-US', { minimumFractionDigits: 2 })
    assert.ok(ws['!cols']![totalCol].wch! >= shown.length + 1, `wch ${ws['!cols']![totalCol].wch} < ${shown}`)
    assert.ok(ws['!cols']!.every((c: any) => c.wch >= 6 && c.wch <= 50))
  })
  it('模版一律唔出草稿警告行（舊格式照出）', () => {
    const cfg = normalizeSheetConfig({ ...NEW_TEMPLATE_DEFAULT, draftRow: true })
    assert.equal(cfg.draftRow, false)
    const wb = buildChequeWorkbook(newRows(RUNS, 'CLINIC'), cfg, { monthAbbr: 'SEP', anyDraft: true })
    for (const n of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[n], { header: 1, defval: null })
      assert.ok(!aoa.some(r => String(r[0] ?? '').includes('DRAFT')), n)
    }
    const legacy = buildChequeWorkbook(newRows(RUNS, 'COMPANY'), LEGACY_CONFIG, { monthAbbr: 'SEP', anyDraft: true })
    assert.ok(XLSX.utils.sheet_to_json<any[]>(legacy.Sheets['出糧總表'], { header: 1, defval: null }).some(r => String(r[0] ?? '').includes('DRAFT')))
  })
})
