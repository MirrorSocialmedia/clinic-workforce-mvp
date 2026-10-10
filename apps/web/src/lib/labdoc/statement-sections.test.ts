/**
 * cwm-labdoc P3 — §8.1 月結單分段：statementMonth 規則／行最遲月份／section 級識別／重複偵測。
 * 純函數 + mock prisma（同 identify.test.ts 做法）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveStatementMonth,
  findStatementSectionDuplicate,
  sectionDuplicateIssue,
  type StatementDuplicate,
} from './statement-sections'
import { identifyStatementSection, latestStatementLineMonth, sectionSources, normClinicName, normDoctor } from './identify'
import type { LabDocResult } from './schema'

function stmtRes(over: Partial<LabDocResult> = {}): LabDocResult {
  return {
    kind: 'STATEMENT',
    lab: { nameRaw: 'Excel', nameCnRaw: null, payeeRaw: null },
    billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
    docNoRaw: null,
    docNoLabel: null,
    dateRaw: null,
    date: null,
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: null,
    groups: [],
    sections: [
      {
        clinicRaw: '滙樂牙科（土瓜湾）',
        doctorRaw: 'Dr. Ho Ka Chun',
        customerNoRaw: null,
        addressRaw: null,
        pageFrom: 1,
        pageTo: 1,
        total: 1830,
        currentTotal: null,
        lines: [
          {
            lineType: 'INVOICE',
            docNoRaw: 'IN195193',
            date: '2026-09-30',
            patientRaw: null,
            patientCodeRaw: null,
            labCaseRef: null,
            description: '全鋯',
            toothRaw: '16',
            qty: 1,
            unitPrice: 1830,
            amount: 1830,
            agingBucket: null,
          },
        ],
      },
    ],
    subtotal: null,
    total: 1830,
    readIssues: [],
    ...over,
  }
}

// ── resolveStatementMonth ───────────────────────────
test('resolveStatementMonth：AI 值優先', () => {
  assert.deepEqual(resolveStatementMonth({ aiMonth: '2026-09', preselected: '2026-08', latestLineMonth: '2026-07' }), { month: '2026-09', source: 'AI' })
})
test('resolveStatementMonth：AI 冇 → 預選（唔標黃）', () => {
  assert.deepEqual(resolveStatementMonth({ aiMonth: null, preselected: '2026-08', latestLineMonth: '2026-07' }), { month: '2026-08', source: 'PRESELECTED' })
})
test('resolveStatementMonth：AI/預選都冇 → 行最遲月份（標黃）', () => {
  assert.deepEqual(resolveStatementMonth({ aiMonth: null, preselected: null, latestLineMonth: '2026-09' }), { month: '2026-09', source: 'LINES' })
})
test('resolveStatementMonth：三邊都冇 → null', () => {
  assert.deepEqual(resolveStatementMonth({ aiMonth: null, preselected: null, latestLineMonth: null }), { month: null, source: null })
})

// ── latestStatementLineMonth ────────────────────────
test('latestStatementLineMonth：跨段最遲日期', () => {
  const r = stmtRes({
    sections: [
      { clinicRaw: 'A', doctorRaw: 'B', customerNoRaw: null, addressRaw: null, pageFrom: 1, pageTo: 1, total: null, currentTotal: null, lines: [{ lineType: 'INVOICE', docNoRaw: 'X', date: '2026-09-05', patientRaw: null, patientCodeRaw: null, labCaseRef: null, description: 'd', toothRaw: null, qty: null, unitPrice: null, amount: 1, agingBucket: null }] },
      { clinicRaw: 'A', doctorRaw: 'C', customerNoRaw: null, addressRaw: null, pageFrom: 2, pageTo: 2, total: null, currentTotal: null, lines: [{ lineType: 'INVOICE', docNoRaw: 'Y', date: '2026-09-28', patientRaw: null, patientCodeRaw: null, labCaseRef: null, description: 'd', toothRaw: null, qty: null, unitPrice: null, amount: 2, agingBucket: null }] },
    ],
  })
  assert.equal(latestStatementLineMonth(r), '2026-09')
})
test('latestStatementLineMonth：無日期行 → null', () => {
  const r = stmtRes({
    sections: [
      { clinicRaw: 'A', doctorRaw: 'B', customerNoRaw: null, addressRaw: null, pageFrom: null, pageTo: null, total: null, currentTotal: null, lines: [{ lineType: 'PAYMENT', docNoRaw: null, date: null, patientRaw: null, patientCodeRaw: null, labCaseRef: null, description: '付款', toothRaw: null, qty: null, unitPrice: null, amount: -500, agingBucket: null }] },
    ],
  })
  assert.equal(latestStatementLineMonth(r), null)
})

// ── sectionSources ──────────────────────────────────
test('sectionSources：section customerNo 優先 billTo；name 去重', () => {
  const r = stmtRes({
    billTo: { nameRaw: '滙樂牙科', addressRaw: null, customerNoRaw: 'EC-101', shortCodeRaw: 'TW', doctorRaw: 'Dr. Ho Ka Chun' },
  })
  const s = r.sections[0]
  const src = sectionSources(r, s)
  // section.customerNoRaw null → 落返 billTo
  assert.equal(src.customerNoRaw, 'EC-101')
  assert.deepEqual(src.nameCandidates, ['滙樂牙科（土瓜湾）', '滙樂牙科'])
  assert.equal(src.shortCodeRaw, 'TW')
  const src2 = sectionSources(r, { ...s, customerNoRaw: 'EC-202' })
  assert.equal(src2.customerNoRaw, 'EC-202')
})

// ── identifyStatementSection（mock prisma）──────────
test('identifyStatementSection：CUSTOMER_NO 帶 clinic＋provider → complete', async () => {
  const prisma: any = {
    labCustomerNo: { findFirst: async (args: any) => (args.where.customerNo === 'EC-101' ? { clinicId: 'cl-a', providerId: 'pr-a' } : null) },
    clinicNameAlias: { findFirst: async () => null },
    clinic: { findMany: async () => [] },
    providerNameAlias: { findFirst: async () => null },
    provider: { findMany: async () => [] },
  }
  const r = stmtRes({ billTo: { nameRaw: '滙樂牙科', addressRaw: null, customerNoRaw: 'EC-101', shortCodeRaw: null, doctorRaw: 'Dr. Ho Ka Chun' } })
  const out = await identifyStatementSection(prisma, r, { labId: 'lab-x', section: r.sections[0] })
  assert.equal(out.clinicId, 'cl-a')
  assert.equal(out.clinicBasis, 'CUSTOMER_NO')
  assert.equal(out.providerId, 'pr-a')
  assert.equal(out.providerBasis, 'CUSTOMER_NO')
  assert.equal(out.complete, true)
})

test('identifyStatementSection：CLINIC_ALIAS＋DOCTOR_ALIAS → complete', async () => {
  const prisma: any = {
    labCustomerNo: { findFirst: async () => null },
    clinicNameAlias: { findFirst: async (args: any) => (args.where.rawNorm === normClinicName('滙樂牙科（土瓜湾）') ? { clinicId: 'cl-b' } : null) },
    clinic: { findMany: async () => [] },
    providerNameAlias: { findFirst: async (args: any) => (args.where.rawNorm === normDoctor('Dr. Ho Ka Chun') ? { providerId: 'pr-b' } : null) },
    provider: { findMany: async () => [] },
  }
  const out = await identifyStatementSection(prisma, stmtRes(), { labId: 'lab-x', section: stmtRes().sections[0] })
  assert.equal(out.clinicId, 'cl-b')
  assert.equal(out.clinicBasis, 'CLINIC_ALIAS')
  assert.equal(out.providerId, 'pr-b')
  assert.equal(out.providerBasis, 'DOCTOR_ALIAS')
  assert.equal(out.complete, true)
})

test('identifyStatementSection：都唔中 → complete=false（NEEDS_ASSIGN）', async () => {
  const prisma: any = {
    labCustomerNo: { findFirst: async () => null },
    clinicNameAlias: { findFirst: async () => null },
    clinic: { findMany: async () => [] },
    providerNameAlias: { findFirst: async () => null },
    provider: { findMany: async () => [] },
  }
  const out = await identifyStatementSection(prisma, stmtRes(), { labId: 'lab-x', section: stmtRes().sections[0] })
  assert.equal(out.clinicId, null)
  assert.equal(out.clinicBasis, 'MANUAL')
  assert.equal(out.providerId, null)
  assert.equal(out.providerBasis, 'MANUAL')
  assert.equal(out.complete, false)
})

test('identifyStatementSection：clinic 中咗但 doctor 唔中 → complete=false', async () => {
  const prisma: any = {
    labCustomerNo: { findFirst: async () => null },
    clinicNameAlias: { findFirst: async () => ({ clinicId: 'cl-c' }) },
    clinic: { findMany: async () => [] },
    providerNameAlias: { findFirst: async () => null },
    provider: { findMany: async () => [] },
  }
  const out = await identifyStatementSection(prisma, stmtRes(), { labId: 'lab-x', section: stmtRes().sections[0] })
  assert.equal(out.clinicId, 'cl-c')
  assert.equal(out.providerId, null)
  assert.equal(out.complete, false)
})

// ── findStatementSectionDuplicate（mock）────────────
const dup: StatementDuplicate = { docId: 'doc-old-1', uploadedAt: new Date('2026-10-01T16:30:00Z'), uploadedBy: 'u1' } // HK 10/2 00:30

test('findStatementSectionDuplicate：param 缺 → null（唔比對）', async () => {
  const prisma: any = { labStatementSection: { findFirst: async () => { throw new Error('should not query') } } }
  assert.equal(await findStatementSectionDuplicate(prisma, { labId: null, clinicId: 'c', providerId: 'p', statementMonth: '2026-09', selfDocId: 'd' }), null)
  assert.equal(await findStatementSectionDuplicate(prisma, { labId: 'l', clinicId: null, providerId: 'p', statementMonth: '2026-09', selfDocId: 'd' }), null)
  assert.equal(await findStatementSectionDuplicate(prisma, { labId: 'l', clinicId: 'c', providerId: 'p', statementMonth: null, selfDocId: 'd' }), null)
})

test('findStatementSectionDuplicate：命中 → 舊 doc（排除自己／VOID／SUPERSEDED／DUPLICATE 由 where 保證）', async () => {
  let captured: any = null
  const prisma: any = {
    labStatementSection: {
      findFirst: async (args: any) => {
        captured = args
        return { document: { id: dup.docId, status: 'NEEDS_REVIEW', createdAt: dup.uploadedAt, uploadedBy: dup.uploadedBy } }
      },
    },
  }
  const out = await findStatementSectionDuplicate(prisma, { labId: 'lab-x', clinicId: 'cl-a', providerId: 'pr-a', statementMonth: '2026-09', selfDocId: 'self-1' })
  assert.deepEqual(out, dup)
  assert.equal(captured.where.document.id.not, 'self-1')
  assert.deepEqual(captured.where.document.status.notIn, ['VOID', 'SUPERSEDED', 'DUPLICATE'])
  assert.equal(captured.where.document.kind, 'STATEMENT')
  // ★ regression（E2E-2 實測）：section 表冇 createdAt — orderBy 必經 document.uploadedAt
  assert.deepEqual(captured.orderBy, { document: { createdAt: 'asc' } })
})

test('findStatementSectionDuplicate：無命中 → null', async () => {
  const prisma: any = { labStatementSection: { findFirst: async () => null } }
  assert.equal(await findStatementSectionDuplicate(prisma, { labId: 'l', clinicId: 'c', providerId: 'p', statementMonth: '2026-09', selfDocId: 'd' }), null)
})

// ── sectionDuplicateIssue（HK 日期）─────────────────
test('sectionDuplicateIssue：HK 日期（UTC+8 過日）', () => {
  // 2026-10-01T16:30Z = HK 2026-10-02 00:30 → 10-02
  assert.equal(sectionDuplicateIssue(2, dup), 'SECTION_DUPLICATE:si=2;doc=doc-old-1;date=2026-10-02')
})
