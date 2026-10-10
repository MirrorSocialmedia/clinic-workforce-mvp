/**
 * cwm-labdoc P2 — §5.6 敏感數字過濾 單元測試（spec §15.2；T18 相鄰）
 * 跑法: npx tsx --test src/lib/labdoc/sensitive-filter.test.ts
 *
 * spec 指定字串（真單遮咗）：
 *   必刪：040-543613-838、809-644065-838、000661528、016-478、3118xx 004 691 524xxx xxx
 *   必留：INV-260805010、IN-MDL2001313043、202609-0811、0172649、DT9003874
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { filterSensitiveNumbers, isSensitiveNumber } from './sensitive-filter'
import { labDocResultSchema, type LabDocResult } from './schema'

// ── 合約 fixture（§5.4 形狀；zod parse 過先入測試） ─────────────
function baseResult(over: Record<string, unknown> = {}): LabDocResult {
  return labDocResultSchema.parse({
    kind: 'INVOICE',
    lab: { nameRaw: null, nameCnRaw: null, payeeRaw: null },
    billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
    docNoRaw: null,
    docNoLabel: null,
    dateRaw: null,
    date: null,
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: null,
    groups: [
      {
        patientNameRaw: null,
        patientCodeRaw: null,
        labCaseRef: null,
        lines: [
          { description: 'Crown', toothRaw: null, qty: 1, unitPrice: 100, listPrice: null, discountRaw: null, amount: 100 },
        ],
      },
    ],
    sections: [],
    subtotal: 100,
    total: 100,
    readIssues: [],
    ...over,
  })
}

describe('isSensitiveNumber — spec §5.6 規則', () => {
  it('港式銀行帳號：3-6-3 / 3-3-6 dash 形態', () => {
    assert.equal(isSensitiveNumber('040-543613-838'), true)
    assert.equal(isSensitiveNumber('809-644065-838'), true)
    assert.equal(isSensitiveNumber('004-016-123456'), true)
  })

  it('Bank & Branch + 帳號（0XX-XXX … 9 位）', () => {
    assert.equal(isSensitiveNumber('HSBC 016-478 000661528'), true)
    assert.equal(isSensitiveNumber('016-478 000661528'), true)
    // 冇 9 位帳號跟住 → 唔刪（branch code 单独唔夠）
    assert.equal(isSensitiveNumber('Branch 016-478 only'), false)
  })

  it('9-12 位 digit 要同欄有帳號关键字', () => {
    assert.equal(isSensitiveNumber('A/C 000661528'), true)
    assert.equal(isSensitiveNumber('account 123456789'), true)
    assert.equal(isSensitiveNumber('帳號 000661528'), true)
    assert.equal(isSensitiveNumber('戶口 83804000123'), true)
    assert.equal(isSensitiveNumber('000661528'), false) // 冇关键字 → 唔刪
    assert.equal(isSensitiveNumber('inv 260805010'), false) // 9 位但無关键字
  })

  it('Swift code 要同欄有 swift', () => {
    assert.equal(isSensitiveNumber('swift HSBCHKHH'), true)
    assert.equal(isSensitiveNumber('SWIFT CODE: HSBCHKHHXXX'), true)
    assert.equal(isSensitiveNumber('HSBCHKHH'), false) // 冇 keyword
  })

  it('MICR：圈零字元 / 6-3-3-6-3 分組（digit）/ OCR 掩碼（x）', () => {
    assert.equal(isSensitiveNumber('⑆3118004691524xxx'), true)
    assert.equal(isSensitiveNumber('123456 789 012 345678 901'), true)
    // spec §15.2 指定字串：OCR 把 MICR 圈零讀成 x
    assert.equal(isSensitiveNumber('3118xx 004 691 524xxx xxx'), true)
  })

  it('FPS 要同欄有 FPS', () => {
    assert.equal(isSensitiveNumber('FPS 12345678'), true)
    assert.equal(isSensitiveNumber('fps id 8380401'), true)
    assert.equal(isSensitiveNumber('12345678'), false) // 冇 FPS 关键字
  })

  it('spec 必留字串全部唔命中', () => {
    assert.equal(isSensitiveNumber('INV-260805010'), false)
    assert.equal(isSensitiveNumber('IN-MDL2001313043'), false)
    assert.equal(isSensitiveNumber('202609-0811'), false)
    assert.equal(isSensitiveNumber('0172649'), false)
    assert.equal(isSensitiveNumber('DT9003874'), false)
  })
})

describe('filterSensitiveNumbers — 欄位白名單（T18 核心）', () => {
  let warnSpy: Array<unknown[]>
  let origWarn: typeof console.warn

  before(() => {
    origWarn = console.warn
    warnSpy = []
    console.warn = (...args: unknown[]) => {
      warnSpy.push(args)
    }
  })
  after(() => {
    console.warn = origWarn
  })

  it('T18：lab.nameRaw 含 040-543613-838 → 刪；docNoRaw INV-260805010 → 保留', () => {
    warnSpy = []
    const r = baseResult({
      lab: { nameRaw: '禾呈大圍 040-543613-838', nameCnRaw: null, payeeRaw: null },
      docNoRaw: 'INV-260805010',
    })
    const { result, removedFields } = filterSensitiveNumbers(r, { docId: 'doc1' })
    assert.equal(result.lab.nameRaw, null)
    assert.equal(result.docNoRaw, 'INV-260805010')
    assert.deepEqual(removedFields, ['lab.nameRaw'])
    // 命中要 console.warn metadata（docId + field），唔得有原文
    const w = warnSpy.find((args) => args[0] === '[labdoc] sensitive removed')
    assert.ok(w, '應該有 sensitive removed warn')
    const meta = w[1] as Record<string, unknown>
    assert.equal(meta.docId, 'doc1')
    assert.equal(meta.field, 'lab.nameRaw')
    assert.ok(!JSON.stringify(warnSpy).includes('040-543613-838'), 'log 唔得有原文')
  })

  it('spec 五個必刪字串（各自放喺受查欄位）全部刪', () => {
    const r = baseResult({
      lab: { nameRaw: '809-644065-838', nameCnRaw: null, payeeRaw: 'A/C 000661528' },
      billTo: {
        nameRaw: '016-478 000661528',
        addressRaw: 'swift HSBCHKHH',
        customerNoRaw: '123',
        shortCodeRaw: null,
        doctorRaw: null,
      },
    })
    r.groups[0].lines[0].description = '3118xx 004 691 524xxx xxx'
    const { result, removedFields } = filterSensitiveNumbers(r, { docId: 'doc2' })
    assert.equal(result.lab.nameRaw, null)
    assert.equal(result.lab.payeeRaw, null)
    assert.equal(result.billTo.nameRaw, null)
    assert.equal(result.billTo.addressRaw, null)
    assert.equal(result.groups[0].lines[0].description, null)
    assert.deepEqual(
      removedFields.sort(),
      ['billTo.addressRaw', 'billTo.nameRaw', 'groups[0].lines[0].description', 'lab.nameRaw', 'lab.payeeRaw'].sort(),
    )
  })

  it('F-03 豁免欄位：docNoRaw／labCaseRef／patientCodeRaw／billTo.customerNoRaw 唔查', () => {
    const r = baseResult({
      docNoRaw: '040-543613-838',
      billTo: {
        nameRaw: null,
        addressRaw: null,
        customerNoRaw: '040-543613-838',
        shortCodeRaw: '0172649',
        doctorRaw: 'DT9003874',
      },
    })
    r.groups[0].patientCodeRaw = '0172649'
    r.groups[0].labCaseRef = 'DT9003874'
    r.groups[0].lines[0].description = 'IN-MDL2001313043'
    const { result, removedFields } = filterSensitiveNumbers(r, { docId: 'doc3' })
    assert.equal(result.docNoRaw, '040-543613-838')
    assert.equal(result.billTo.customerNoRaw, '040-543613-838')
    assert.equal(result.billTo.shortCodeRaw, '0172649')
    assert.equal(result.billTo.doctorRaw, 'DT9003874')
    assert.equal(result.groups[0].patientCodeRaw, '0172649')
    assert.equal(result.groups[0].labCaseRef, 'DT9003874')
    assert.equal(result.groups[0].lines[0].description, 'IN-MDL2001313043')
    assert.deepEqual(removedFields, [])
  })

  it('STATEMENT 欄位：clinicRaw／doctorRaw／patientRaw／行 description 照查', () => {
    const s = labDocResultSchema.parse({
      kind: 'STATEMENT',
      lab: { nameRaw: null, nameCnRaw: null, payeeRaw: null },
      billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
      docNoRaw: null,
      docNoLabel: null,
      dateRaw: null,
      date: null,
      deliveryDate: null,
      orderReceivedDate: null,
      statementMonth: '2026-09',
      groups: [],
      sections: [
        {
          clinicRaw: '臻善 040-543613-838',
          doctorRaw: null,
          customerNoRaw: 'C1',
          addressRaw: null,
          pageFrom: 1,
          pageTo: 1,
          total: 100,
          currentTotal: null,
          lines: [
            {
              lineType: 'INVOICE',
              docNoRaw: '202609-0811',
              date: '2026-09-11',
              patientRaw: '000661528 account',
              patientCodeRaw: 'TW007159',
              labCaseRef: null,
              description: 'Crown',
              toothRaw: null,
              qty: 1,
              unitPrice: 100,
              amount: 100,
              agingBucket: null,
            },
          ],
        },
      ],
      subtotal: null,
      total: 100,
      readIssues: [],
    })
    const { result, removedFields } = filterSensitiveNumbers(s, { docId: 'doc4' })
    assert.equal(result.sections[0].clinicRaw, null)
    assert.equal(result.sections[0].lines[0].patientRaw, null)
    // 行 docNoRaw 202609-0811 唔查（F-03）
    assert.equal(result.sections[0].lines[0].docNoRaw, '202609-0811')
    assert.equal(result.sections[0].lines[0].patientCodeRaw, 'TW007159')
    assert.deepEqual(removedFields, ['sections[0].clinicRaw', 'sections[0].lines[0].patientRaw'])
  })

  it('readIssues 元素命中 → 移除；未命中元素保留', () => {
    const r = baseResult({ readIssues: ['CHEQUE_PRESENT', '040-543613-838'] })
    const { result, removedFields } = filterSensitiveNumbers(r, { docId: 'doc5' })
    assert.deepEqual(result.readIssues, ['CHEQUE_PRESENT'])
    assert.deepEqual(removedFields, ['readIssues[1]'])
  })

  it('原物件唔會畀改（回新物件）', () => {
    const r = baseResult({ lab: { nameRaw: '809-644065-838', nameCnRaw: null, payeeRaw: null } })
    const { result } = filterSensitiveNumbers(r, { docId: 'doc6' })
    assert.equal(result.lab.nameRaw, null)
    assert.equal(r.lab.nameRaw, '809-644065-838')
  })
})
