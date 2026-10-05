/**
 * cwm-labdoc P2 — §6.5 病人配對 + §7.3 候選成本（candidates.ts data layer）unit
 *
 * 覆蓋：
 *  - §7.3 排序：(baseCost = groupSum) DESC → (receivedAt IS NULL) ASC → orderedAt DESC
 *  - labId 過濾（doc.labId 有值 → 只要同 lab；null → 只要 labId null）
 *  - status VOID 排除
 *  - 已連邊幾張單（mainLink / otherLinks）
 *  - §7.4 預設：1 筆無 MAIN → 全行 MATCH；>1 筆 → 剛好一筆 = groupSum；否則冇
 *  - §6.5 code 未解析 + 純數字 raw → 其他前綴選項（PatientIndex；唔自動揀）
 *  - codeOverride（codeSource = override）
 *  - doc 唔存在 → null
 *  - systemName（PatientIndex 系統姓名）
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { prisma } from '../prisma'
import { getCandidatesForGroup } from './candidates'

const DOC_ID = 'a'.repeat(25)
const DOC_2 = 'b'.repeat(25)
const DOC_3 = 'c'.repeat(25)
const LAB_1 = 'l'.repeat(25)
const LAB_2 = 'q'.repeat(25)
const CLINIC_1 = 'c1'.padEnd(25, '0')
const CLINIC_2 = 'c2'.padEnd(25, '0')
const PROV_1 = 'p'.repeat(25)
const PROV_2 = 'r'.repeat(25)

function d(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}
function mkLine(id: string, groupIndex: number, lineIndex: number, amount: number, over: Record<string, unknown> = {}) {
  return {
    id,
    documentId: DOC_ID,
    groupIndex,
    lineIndex,
    description: `Line ${id}`,
    toothRaw: null,
    qty: 1,
    unitPrice: amount,
    listPrice: null,
    discountRaw: null,
    amount,
    isZero: amount === 0,
    status: 'UNMATCHED',
    ignoreReason: null,
    costCaseId: null,
    linkType: null,
    patientNameRaw: null,
    patientCodeRaw: null,
    patientCode: null,
    labCaseRef: null,
    matchedBy: null,
    matchedAt: null,
    ...over,
  }
}
function mkDoc(over: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    kind: 'INVOICE',
    status: 'CONFIRMED',
    labId: LAB_1,
    clinicId: CLINIC_1,
    providerId: PROV_1,
    docNo: 'INV-1',
    lines: [],
    ...over,
  }
}
function mkCase(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    itemType: 'CROWN',
    itemTypeOther: null,
    orderedAt: d('2026-01-01'),
    providerId: PROV_1,
    clinicId: CLINIC_1,
    labId: LAB_1,
    baseCost: null,
    status: 'PENDING',
    receivedAt: null,
    periodMonth: null,
    lockedByRunId: null,
    ...over,
  }
}

interface State {
  docs: Record<string, any>
  docsList: Array<{ id: string; docNo: string | null }>
  clinics: Array<{ id: string; name: string; shortName: string | null }>
  providers: Array<{ id: string; name: string }>
  cases: any[]
  links: Array<{ costCaseId: string; linkType: string | null; documentId: string; status: string; amount: number }>
  patients: Array<{ patientCode: string; patientName: string | null }>
}

function makeFake(state: State) {
  return {
    labDocument: {
      findUnique: async ({ where }: any) => state.docs[where.id] ?? null,
      findMany: async ({ where }: any) =>
        state.docsList.filter((x) => (where.id?.in ? where.id.in.includes(x.id) : true)),
    },
    clinic: {
      findUnique: async ({ where }: any) => state.clinics.find((c) => c.id === where.id) ?? null,
      findMany: async () => state.clinics,
    },
    costCase: {
      findMany: async ({ where }: any) =>
        state.cases.filter((c) => {
          if (c.patientCodeNorm !== where.patientCodeNorm) return false
          if (where.status?.not && c.status === where.status.not) return false
          if ('labId' in where) {
            if (where.labId === null && c.labId !== null) return false
            if (where.labId !== null && c.labId !== where.labId) return false
          }
          return true
        }),
    },
    provider: {
      findMany: async ({ where }: any) => state.providers.filter((p) => (where.id?.in ? where.id.in.includes(p.id) : true)),
    },
    labDocumentLine: {
      findMany: async ({ where }: any) =>
        state.links.filter(
          (l) => (where.costCaseId?.in ? where.costCaseId.in.includes(l.costCaseId) : true) &&
            (where.status ? l.status === where.status : true),
        ),
    },
    patientIndex: {
      findFirst: async ({ where }: any) => state.patients.find((p) => p.patientCode === where.patientCode) ?? null,
      findMany: async ({ where }: any) => state.patients.filter((p) => (where.patientCode?.in ? where.patientCode.in.includes(p.patientCode) : true)),
    },
  }
}

// fake 的 links 都要有 status: 'MATCHED'（route 查 status MATCHED）
const KEYS = ['labDocument', 'clinic', 'costCase', 'provider', 'labDocumentLine', 'patientIndex'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

function reset(state: State) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}

const BASE_LINES = [
  mkLine('l1'.padEnd(25, '0'), 0, 0, 300),
  mkLine('l2'.padEnd(25, '0'), 0, 1, 200),
  mkLine('l3'.padEnd(25, '0'), 0, 2, 0),
]

test('§7.3 排序 + labId/VOID 過濾 + mainLink/otherLinks', async () => {
  const cases = [
    mkCase('ca'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500, orderedAt: d('2026-01-01'), receivedAt: null }),
    mkCase('cb'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500, orderedAt: d('2026-03-01'), receivedAt: d('2026-01-02') }),
    mkCase('cc'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 400, orderedAt: d('2026-05-01') }),
    mkCase('cd'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 400, orderedAt: d('2026-06-01') }),
    // 唔該中：
    mkCase('ce'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500, labId: LAB_2 }), // 錯 lab
    mkCase('cf'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500, labId: null }), // doc.labId 有值 → 只要同 lab
    mkCase('cg'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500, status: 'VOID' }), // VOID
    mkCase('ch'.padEnd(25, '0'), { patientCodeNorm: 'TKW007159', baseCost: 500 }), // 錯 code
  ]
  reset({
    docs: { [DOC_ID]: mkDoc({ lines: BASE_LINES.map((l) => ({ ...l, patientCode: 'TW007159' })) }) },
    docsList: [
      { id: DOC_2, docNo: 'INV-2' },
      { id: DOC_3, docNo: 'INV-3' },
    ],
    clinics: [
      { id: CLINIC_1, name: '大圍', shortName: 'TW' },
      { id: CLINIC_2, name: '土瓜灣', shortName: 'TKW' },
    ],
    providers: [
      { id: PROV_1, name: 'Dr. Chan' },
      { id: PROV_2, name: 'Dr. Ho' },
    ],
    cases,
    links: [
      { costCaseId: 'cb'.padEnd(25, '0'), linkType: 'MAIN', documentId: DOC_2, status: 'MATCHED', amount: 200 },
      { costCaseId: 'cb'.padEnd(25, '0'), linkType: 'SUPPLEMENT', documentId: DOC_3, status: 'MATCHED', amount: 300 },
    ],
    patients: [{ patientCode: 'TW007159', patientName: 'CHAN, TOM' }],
  })

  const res = await getCandidatesForGroup(DOC_ID, 0, { clinicShortName: 'TW', codeOverride: null })
  assert.ok(res)
  assert.strictEqual(res!.code, 'TW007159')
  assert.strictEqual(res!.codeSource, 'line')
  assert.strictEqual(res!.groupSum, 500)
  assert.strictEqual(res!.systemName, 'CHAN, TOM')
  // 排序：cb（=500 且已到貨）> ca（=500 未到貨）> cd（400, 06月）> cc（400, 05月）
  assert.deepStrictEqual(res!.candidates.map((c) => c.caseId), [
    'cb'.padEnd(25, '0'),
    'ca'.padEnd(25, '0'),
    'cd'.padEnd(25, '0'),
    'cc'.padEnd(25, '0'),
  ])
  const cb = res!.candidates[0]
  assert.strictEqual(cb.mainLink?.docId, DOC_2)
  assert.strictEqual(cb.mainLink?.docNo, 'INV-2')
  assert.strictEqual(cb.otherLinks.length, 1)
  assert.strictEqual(cb.otherLinks[0].docId, DOC_3)
  assert.strictEqual(cb.otherLinks[0].linkType, 'SUPPLEMENT')
  // §7.5 linkedSum 原料：200（主單）+ 300（補收費）= 500
  assert.strictEqual(cb.linkedSum, 500)
  assert.strictEqual(cb.mainLinkedSum, 200)
  assert.strictEqual(cb.otherLinkedSum, 300)
  const ca = res!.candidates[1]
  assert.strictEqual(ca.linkedSum, 0)
  // 預設：>1 筆候選 → 剛好一筆 = groupSum 且無 MAIN（cb 有 MAIN 出局）→ 揀 ca
  assert.strictEqual(res!.defaults.selectedCostCaseId, 'ca'.padEnd(25, '0'))
})

test('§7.3 labId null 口徑：doc.labId = null → 只要 labId IS NULL 嘅成本', async () => {
  reset({
    docs: { [DOC_ID]: mkDoc({ labId: null, lines: BASE_LINES.map((l) => ({ ...l, patientCode: 'TW007159' })) }) },
    docsList: [],
    clinics: [{ id: CLINIC_1, name: '大圍', shortName: 'TW' }],
    providers: [{ id: PROV_1, name: 'Dr. Chan' }],
    cases: [
      mkCase('ca'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 100, labId: null }),
      mkCase('cb'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 100, labId: LAB_1 }),
    ],
    links: [],
    patients: [],
  })
  const res = await getCandidatesForGroup(DOC_ID, 0, { clinicShortName: 'TW', codeOverride: null })
  assert.ok(res)
  assert.deepStrictEqual(res!.candidates.map((c) => c.caseId), ['ca'.padEnd(25, '0')])
})

test('§7.4 預設：候選 1 筆無 MAIN → 全部行（連 $0 行）MATCH 佢', async () => {
  reset({
    docs: { [DOC_ID]: mkDoc({ lines: BASE_LINES.map((l) => ({ ...l, patientCode: 'TW007159' })) }) },
    docsList: [],
    clinics: [{ id: CLINIC_1, name: '大圍', shortName: 'TW' }],
    providers: [{ id: PROV_1, name: 'Dr. Chan' }],
    cases: [mkCase('ca'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500 })],
    links: [],
    patients: [],
  })
  const res = await getCandidatesForGroup(DOC_ID, 0, { clinicShortName: 'TW', codeOverride: null })
  assert.ok(res)
  assert.strictEqual(res!.defaults.selectedCostCaseId, 'ca'.padEnd(25, '0'))
  assert.strictEqual(res!.defaults.lineActions.length, 3) // 連 $0 行（D11）
  for (const a of res!.defaults.lineActions) {
    assert.strictEqual(a.action, 'MATCH')
    assert.strictEqual(a.costCaseId, 'ca'.padEnd(25, '0'))
    assert.strictEqual(a.linkType, 'MAIN')
  }
})

test('§7.4 預設：候選 >1 → 剛好一筆 = groupSum（無 MAIN）先揀', async () => {
  reset({
    docs: { [DOC_ID]: mkDoc({ lines: BASE_LINES.map((l) => ({ ...l, patientCode: 'TW007159' })) }) },
    docsList: [{ id: DOC_2, docNo: 'INV-2' }],
    clinics: [{ id: CLINIC_1, name: '大圍', shortName: 'TW' }],
    providers: [{ id: PROV_1, name: 'Dr. Chan' }],
    cases: [
      mkCase('ca'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500 }),
      mkCase('cb'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500 }),
      mkCase('cc'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 100 }),
    ],
    links: [{ costCaseId: 'cb'.padEnd(25, '0'), linkType: 'MAIN', documentId: DOC_2, status: 'MATCHED', amount: 100 }],
    patients: [],
  })
  const res = await getCandidatesForGroup(DOC_ID, 0, { clinicShortName: 'TW', codeOverride: null })
  assert.ok(res)
  // cb 有 MAIN → 只有 ca 合資格
  assert.strictEqual(res!.defaults.selectedCostCaseId, 'ca'.padEnd(25, '0'))

  // 改：兩筆 = groupSum 都無 MAIN → 冇預設
  reset({
    docs: { [DOC_ID]: mkDoc({ lines: BASE_LINES.map((l) => ({ ...l, patientCode: 'TW007159' })) }) },
    docsList: [],
    clinics: [{ id: CLINIC_1, name: '大圍', shortName: 'TW' }],
    providers: [{ id: PROV_1, name: 'Dr. Chan' }],
    cases: [
      mkCase('ca'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500 }),
      mkCase('cb'.padEnd(25, '0'), { patientCodeNorm: 'TW007159', baseCost: 500 }),
    ],
    links: [],
    patients: [],
  })
  const res2 = await getCandidatesForGroup(DOC_ID, 0, { clinicShortName: 'TW', codeOverride: null })
  assert.ok(res2)
  assert.strictEqual(res2!.defaults.selectedCostCaseId, null)
  assert.ok(res2!.defaults.lineActions.every((a) => a.action === 'UNMATCH'))
})

test('§7.4 候選 0 → showNewCase + showPatientSearch', async () => {
  reset({
    docs: { [DOC_ID]: mkDoc({ lines: BASE_LINES.map((l) => ({ ...l, patientCode: 'TW007159' })) }) },
    docsList: [],
    clinics: [{ id: CLINIC_1, name: '大圍', shortName: 'TW' }],
    providers: [{ id: PROV_1, name: 'Dr. Chan' }],
    cases: [],
    links: [],
    patients: [],
  })
  const res = await getCandidatesForGroup(DOC_ID, 0, { clinicShortName: 'TW', codeOverride: null })
  assert.ok(res)
  assert.strictEqual(res!.candidates.length, 0)
  assert.strictEqual(res!.defaults.showNewCase, true)
  assert.strictEqual(res!.defaults.showPatientSearch, true)
})

test('§6.5 code 未解析＋純數字 raw → 其他前綴選項（唔自動揀；非字母前綴店排除）', async () => {
  reset({
    docs: { [DOC_ID]: mkDoc({ lines: BASE_LINES.map((l) => ({ ...l, patientCodeRaw: ' 7159 ' })) }) },
    docsList: [],
    clinics: [
      { id: CLINIC_1, name: '大圍', shortName: 'TW' },
      { id: CLINIC_2, name: '土瓜灣', shortName: 'TKW' },
      { id: 'c3'.padEnd(25, '0'), name: '青衣', shortName: '青' }, // 非字母 → 排除
    ],
    providers: [],
    cases: [],
    links: [],
    patients: [
      { patientCode: 'TW007159', patientName: 'CHAN, TOM' },
      { patientCode: 'TKW007159', patientName: 'LEE, KWOK' },
    ],
  })
  const res = await getCandidatesForGroup(DOC_ID, 0, { clinicShortName: 'TW', codeOverride: null })
  assert.ok(res)
  assert.strictEqual(res!.code, null)
  assert.strictEqual(res!.candidates.length, 0)
  assert.deepStrictEqual(res!.patientOptions.map((o) => o.code), ['TW007159', 'TKW007159'])
  const tw = res!.patientOptions.find((o) => o.code === 'TW007159')!
  assert.strictEqual(tw.name, 'CHAN, TOM')
  assert.strictEqual(tw.clinicShortName, 'TW')
  // 唔自動揀
  assert.strictEqual(res!.defaults.selectedCostCaseId, null)
})

test('§6.5 codeOverride → codeSource = override；候選跟 override code', async () => {
  reset({
    docs: { [DOC_ID]: mkDoc({ lines: BASE_LINES }) },
    docsList: [],
    clinics: [{ id: CLINIC_1, name: '大圍', shortName: 'TW' }],
    providers: [{ id: PROV_1, name: 'Dr. Chan' }],
    cases: [mkCase('ca'.padEnd(25, '0'), { patientCodeNorm: 'TKW007159', baseCost: 500 })],
    links: [],
    patients: [{ patientCode: 'TKW007159', patientName: 'LEE, KWOK' }],
  })
  const res = await getCandidatesForGroup(DOC_ID, 0, { clinicShortName: 'TW', codeOverride: 'TKW007159' })
  assert.ok(res)
  assert.strictEqual(res!.code, 'TKW007159')
  assert.strictEqual(res!.codeSource, 'override')
  assert.strictEqual(res!.systemName, 'LEE, KWOK')
  assert.strictEqual(res!.candidates.length, 1)
})

test('doc 唔存在 → null', async () => {
  reset({ docs: {}, docsList: [], clinics: [], providers: [], cases: [], links: [], patients: [] })
  const res = await getCandidatesForGroup('z'.repeat(25), 0, { clinicShortName: 'TW', codeOverride: null })
  assert.strictEqual(res, null)
})
