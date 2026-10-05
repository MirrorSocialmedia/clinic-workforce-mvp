/**
 * cwm-labdoc P2 — §5.5 讀單後系統檢查 單元測試（spec §15.2；m-6 驗收項）
 * 跑法: npx tsx --test src/lib/labdoc/validate-extract.test.ts
 *
 * spec 指定案例：
 *   - Σ 唔等擋確認；total null 擋確認
 *   - Sodental 8 月 D3：Σ 17,490 vs 21,330 → 分段紅（差 $3,840）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkExtracted, AMOUNT_TOO_LARGE_LIMIT } from './validate-extract'
import { labDocResultSchema, type LabDocResult } from './schema'

const UPLOAD_AT = new Date('2026-10-05T00:00:00Z')

function invoice(over: Record<string, unknown> = {}): LabDocResult {
  return labDocResultSchema.parse({
    kind: 'INVOICE',
    lab: { nameRaw: null, nameCnRaw: null, payeeRaw: null },
    billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
    docNoRaw: 'INV-260805010',
    docNoLabel: 'Invoice No.',
    dateRaw: '05/10/2026',
    date: '2026-10-05',
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: null,
    groups: [
      {
        patientNameRaw: 'A B',
        patientCodeRaw: 'TW007159',
        labCaseRef: null,
        lines: [{ description: 'Crown', toothRaw: null, qty: 2, unitPrice: 300, listPrice: null, discountRaw: null, amount: 600 }],
      },
    ],
    sections: [],
    subtotal: 600,
    total: 600,
    readIssues: [],
    ...over,
  })
}

function statementLine(over: Record<string, unknown> = {}) {
  return {
    lineType: 'INVOICE',
    docNoRaw: null,
    date: null,
    patientRaw: null,
    patientCodeRaw: null,
    labCaseRef: null,
    description: null,
    toothRaw: null,
    qty: null,
    unitPrice: null,
    amount: 0,
    agingBucket: null,
    ...over,
  }
}

function statement(over: Record<string, unknown> = {}): LabDocResult {
  return labDocResultSchema.parse({
    kind: 'STATEMENT',
    lab: { nameRaw: null, nameCnRaw: null, payeeRaw: null },
    billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
    docNoRaw: null,
    docNoLabel: null,
    dateRaw: null,
    date: null,
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: '2026-08',
    groups: [],
    sections: [
      {
        clinicRaw: null,
        doctorRaw: null,
        customerNoRaw: null,
        addressRaw: null,
        pageFrom: 1,
        pageTo: 1,
        total: 100,
        currentTotal: null,
        lines: [statementLine({ amount: 100 })],
      },
    ],
    subtotal: null,
    total: 100,
    readIssues: [],
    ...over,
  })
}

describe('§5.5 行檢查（兩種單都查）', () => {
  it('qty × unitPrice = amount（齊先查）— 唔等 ±0.01 → 行黃 QTY_MISMATCH', () => {
    const r = invoice()
    r.groups[0].lines[0].qty = 2
    r.groups[0].lines[0].unitPrice = 300
    r.groups[0].lines[0].amount = 600.02 // Σ 都要改返一致，淨看行 check
    r.total = 600.02
    r.subtotal = 600.02
    const res = checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.lineFlags, [{ groupIndex: 0, lineIndex: 0, issues: ['QTY_MISMATCH'] }])
  })

  it('±0.01 內 → 唔標（2×300=600 vs 600.01）', () => {
    const r = invoice()
    r.groups[0].lines[0].amount = 600.01
    r.total = 600.01
    r.subtotal = 600.01
    const res = checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.lineFlags, [])
  })

  it('qty／unitPrice 有 null → 唔查行（齊先查）', () => {
    const r = invoice()
    r.groups[0].lines[0].qty = null
    r.groups[0].lines[0].amount = 50
    r.total = 50
    r.subtotal = 50
    const res = checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.lineFlags, [])
  })

  it('§5.4：|amount| > 1,000,000 → 行紅 AMOUNT_TOO_LARGE + readIssue；剛好 1,000,000 唔計', () => {
    assert.equal(AMOUNT_TOO_LARGE_LIMIT, 1_000_000)
    const r = invoice()
    r.groups[0].lines[0].qty = 1
    r.groups[0].lines[0].unitPrice = 1_000_001
    r.groups[0].lines[0].amount = 1_000_001
    r.total = 1_000_001
    r.subtotal = 1_000_001
    const res = checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.equal(res.lineFlags.length, 1)
    assert.ok(res.lineFlags[0].issues.includes('AMOUNT_TOO_LARGE'))
    assert.ok(res.readIssues.includes('AMOUNT_TOO_LARGE'))

    const r2 = invoice()
    r2.groups[0].lines[0].qty = 1
    r2.groups[0].lines[0].unitPrice = 1_000_000
    r2.groups[0].lines[0].amount = 1_000_000
    r2.total = 1_000_000
    r2.subtotal = 1_000_000
    const res2 = checkExtracted(r2, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res2.lineFlags, [])
    assert.ok(!res2.readIssues.includes('AMOUNT_TOO_LARGE'))
  })
})

describe('§5.5 INVOICE 總數檢查（擋確認）', () => {
  it('Σ 行 = total → 唔擋', () => {
    const res = checkExtracted(invoice(), { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.blocking, [])
    assert.equal(res.totalDiff, null)
  })

  it('Σ 行 ≠ total → 擋 TOTAL_MISMATCH + totalDiff（最可疑行由 UI 用 lineFlags 排頭）', () => {
    const r = invoice()
    r.total = 500 // Σ = 600 → 差 +100
    const res = checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.blocking, ['TOTAL_MISMATCH'])
    assert.equal(res.totalDiff, 100)
    assert.ok(res.readIssues.includes('TOTAL_MISMATCH'))
  })

  it('total null 但有 subtotal → 對 subtotal', () => {
    const r = invoice()
    r.total = null
    r.subtotal = 600
    const res = checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.blocking, [])

    r.subtotal = 550
    const res2 = checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res2.blocking, ['TOTAL_MISMATCH'])
    assert.equal(res2.totalDiff, 50)
  })

  it('total、subtotal 都係 null → 擋 TOTAL_MISSING（F-16：要員工填總數）', () => {
    const r = invoice()
    r.total = null
    r.subtotal = null
    const res = checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.blocking, ['TOTAL_MISSING'])
    assert.ok(res.readIssues.includes('TOTAL_MISSING'))
  })
})

describe('§5.5 STATEMENT 分段檢查', () => {
  it('spec 案例：Sodental 8 月 D3 — Σ(INVOICE+CREDIT+CHARGE) 17,490 vs total 21,330 → 分段紅，差 -$3,840', () => {
    const s = statement({
      sections: [
        {
          clinicRaw: null,
          doctorRaw: null,
          customerNoRaw: null,
          addressRaw: null,
          pageFrom: 3,
          pageTo: 3,
          total: 21_330,
          currentTotal: null,
          lines: [
            statementLine({ lineType: 'INVOICE', amount: 10_000, docNoRaw: '202608-0001' }),
            statementLine({ lineType: 'INVOICE', amount: 5_000, docNoRaw: '202608-0002' }),
            statementLine({ lineType: 'CREDIT', amount: -1_500, docNoRaw: '202608-0003' }),
            statementLine({ lineType: 'CHARGE', amount: 3_990, docNoRaw: '202608-0004' }),
            // PAYMENT／BF 行唔計入分段總和
            statementLine({ lineType: 'PAYMENT', amount: -2_000 }),
            statementLine({ lineType: 'BF', amount: -1_000 }),
          ],
        },
      ],
    })
    // Σ = 10000 + 5000 - 1500 + 3990 = 17,490 vs 21,330
    const res = checkExtracted(s, { docKind: 'STATEMENT', uploadedAt: UPLOAD_AT })
    assert.equal(res.sectionFlags.length, 1)
    assert.equal(res.sectionFlags[0].sectionIndex, 0)
    assert.equal(res.sectionFlags[0].issue, 'SUM_MISMATCH')
    assert.equal(res.sectionFlags[0].diff, -3_840)
  })

  it('分段 Σ = total → 唔標', () => {
    const res = checkExtracted(statement(), { docKind: 'STATEMENT', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.sectionFlags, [])
  })

  it('OUTSTANDING：Σ CURRENT = currentTotal 先驗收', () => {
    const s = statement({
      sections: [
        {
          clinicRaw: null,
          doctorRaw: null,
          customerNoRaw: null,
          addressRaw: null,
          pageFrom: 1,
          pageTo: 1,
          total: null,
          currentTotal: 1_061,
          lines: [
            statementLine({ agingBucket: 'CURRENT', amount: 800, docNoRaw: '202609-0509' }),
            statementLine({ agingBucket: 'CURRENT', amount: 261, docNoRaw: '202609-0811' }),
            statementLine({ agingBucket: 'D31_90', amount: 500, docNoRaw: '202512-0885' }),
          ],
        },
      ],
    })
    assert.deepEqual(checkExtracted(s, { docKind: 'STATEMENT', uploadedAt: UPLOAD_AT, statementKind: 'OUTSTANDING' }).sectionFlags, [])

    // Σ CURRENT = 1,061 vs currentTotal 1,000 → 紅
    const s2 = statement({
      sections: [
        {
          clinicRaw: null,
          doctorRaw: null,
          customerNoRaw: null,
          addressRaw: null,
          pageFrom: 1,
          pageTo: 1,
          total: null,
          currentTotal: 1_000,
          lines: [
            statementLine({ agingBucket: 'CURRENT', amount: 800, docNoRaw: '202609-0509' }),
            statementLine({ agingBucket: 'CURRENT', amount: 261, docNoRaw: '202609-0811' }),
          ],
        },
      ],
    })
    const res = checkExtracted(s2, { docKind: 'STATEMENT', uploadedAt: UPLOAD_AT, statementKind: 'OUTSTANDING' })
    assert.equal(res.sectionFlags.length, 1)
    assert.equal(res.sectionFlags[0].issue, 'CURRENT_MISMATCH')
    assert.equal(res.sectionFlags[0].diff, 61)
  })
})

describe('§5.5 其他檢查', () => {
  it('date 喺上傳日前 400 日內、唔喺未來 > 7 日 — 邊界（動態日期）', () => {
    const mk = (date: string | null) => {
      const r = invoice()
      r.date = date
      return checkExtracted(r, { docKind: 'INVOICE', uploadedAt: UPLOAD_AT })
    }
    const d = (deltaDays: number) => new Date(UPLOAD_AT.getTime() + deltaDays * 86_400_000).toISOString().slice(0, 10)
    assert.ok(!mk(d(0)).readIssues.includes('DATE_SUSPICIOUS')) // 當日
    assert.ok(!mk(d(-3)).readIssues.includes('DATE_SUSPICIOUS')) // 過去
    assert.ok(!mk(d(7)).readIssues.includes('DATE_SUSPICIOUS')) // 未來 7 日（<= 7 允許）
    assert.ok(mk(d(8)).readIssues.includes('DATE_SUSPICIOUS')) // 未來 8 日
    assert.ok(!mk(d(-399)).readIssues.includes('DATE_SUSPICIOUS')) // 400 日內
    assert.ok(mk(d(-401)).readIssues.includes('DATE_SUSPICIOUS')) // 超過 400 日
    assert.ok(!mk(null).readIssues.includes('DATE_SUSPICIOUS')) // 冇 date 唔查
  })

  it('kind ≠ 上傳時揀嘅分頁 → KIND_MISMATCH（提示轉月結單）', () => {
    const r = invoice()
    const res = checkExtracted(r, { docKind: 'STATEMENT', uploadedAt: UPLOAD_AT })
    assert.ok(res.readIssues.includes('KIND_MISMATCH'))
    assert.deepEqual(res.blocking, []) // 提示唔擋
  })

  it('blocking 唔含提示類（KIND_MISMATCH/DATE_SUSPICIOUS 唔擋確認）', () => {
    const r = invoice()
    r.date = new Date(UPLOAD_AT.getTime() + 8 * 86_400_000).toISOString().slice(0, 10) // 未來 8 日 → 黃
    const res = checkExtracted(r, { docKind: 'STATEMENT', uploadedAt: UPLOAD_AT })
    assert.deepEqual(res.blocking, [])
    assert.ok(res.readIssues.includes('DATE_SUSPICIOUS'))
    assert.ok(res.readIssues.includes('KIND_MISMATCH'))
  })
})
