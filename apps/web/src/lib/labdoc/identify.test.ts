/**
 * cwm-labdoc P2 — §6.1 Lab 識別 + §6.4 單號／重複 單元測試。
 * （§6.2 診所／§6.3 醫生 喺 CHUNK 2 加 — 同一個 identify.ts 擴充。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { toHalfWidth, normLabName, normDocNo, identifyLab, identifyDocNo } from './identify'
import type { LabDocResult } from './schema'

function baseRes(over: Partial<LabDocResult> = {}): LabDocResult {
  return {
    kind: 'INVOICE',
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
    sections: [],
    subtotal: null,
    total: null,
    readIssues: [],
    ...over,
  }
}

// ── 正規化 ───────────────────────────────────────────
test('toHalfWidth：全形英數／空白轉半形', () => {
  assert.equal(toHalfWidth('０１２ＡＢＣ'), '012ABC')
  assert.equal(toHalfWidth('a b　c'), 'a b c')
})

test('normLabName：細階＋去標點＋去 limited|ltd|lab|dental|有限公司|牙科', () => {
  assert.equal(normLabName('Excel Dental Laboratory Limited'), 'excel')
  assert.equal(normLabName('Excel Limited'), 'excel')
  assert.equal(normLabName('和呈牙科器材有限公司'), '和呈')
  assert.equal(normLabName('  EXCEL　dental '), 'excel')
  // company 唔會俾 co 食咗（長 token 優先）
  assert.equal(normLabName('ABC Company'), 'abc')
})

test('normDocNo：去空格、大階、全形轉半形；唔去前置 0、唔將 O 轉 0', () => {
  assert.equal(normDocNo(' inv-001 '), 'INV-001')
  assert.equal(normDocNo('０２５４１３１'), '0254131')
  assert.equal(normDocNo('0321231O'), '0321231O')
  assert.equal(normDocNo(null), null)
  assert.equal(normDocNo('   '), null)
})

// ── identifyLab ─────────────────────────────────────
test('identifyLab：alias 命中（NAME_EN）→ ALIAS', async () => {
  const prisma: any = {
    labAlias: { findFirst: async (args: any) => (args.where.rawNorm === 'excel' ? { labId: 'lab-x1' } : null) },
    lab: { findMany: async () => [] },
  }
  const r = await identifyLab(prisma, baseRes())
  assert.equal(r.labId, 'lab-x1')
  assert.equal(r.labBasis, 'ALIAS')
})

test('identifyLab：NAME 互相包含（較短邊 ≥4、只有一間中）', async () => {
  const prisma: any = {
    labAlias: { findFirst: async () => null },
    lab: { findMany: async () => [{ id: 'lab-a', name: 'Excel Dental Lab' }, { id: 'lab-b', name: 'ABC' }] },
  }
  const r = await identifyLab(prisma, baseRes({ lab: { nameRaw: 'EXCEL DENTAL', nameCnRaw: null, payeeRaw: null } }))
  assert.equal(r.labId, 'lab-a')
  assert.equal(r.labBasis, 'NAME')
})

test('identifyLab：兩間中 → null（唔確定唔亂填）', async () => {
  const prisma: any = {
    labAlias: { findFirst: async () => null },
    lab: { findMany: async () => [{ id: 'lab-a', name: 'Excel' }, { id: 'lab-b', name: 'Excel Dental' }] },
  }
  const r = await identifyLab(prisma, baseRes())
  assert.equal(r.labId, null)
  assert.equal(r.labBasis, null)
})

test('identifyLab：較短邊 < 4 → 唔算（例 lab 名「ACE」vs raw「ACE DENTAL」）', async () => {
  const prisma: any = {
    labAlias: { findFirst: async () => null },
    lab: { findMany: async () => [{ id: 'lab-a', name: 'ACE' }] },
  }
  const r = await identifyLab(prisma, baseRes({ lab: { nameRaw: 'ACE DENTAL LAB', nameCnRaw: null, payeeRaw: null } }))
  assert.equal(r.labId, null)
})

test('payeeIsNew：認到 Lab、payeeRaw 唔喺 PAYEE alias → true；喺內 → false；payeeRaw 空 → false', async () => {
  const mk = (hasAlias: boolean): any => ({
    labAlias: {
      findFirst: async (args: any) => {
        if (args.where.kind === 'NAME_EN') return { labId: 'lab-x1' }
        if (args.where.kind === 'PAYEE') return hasAlias ? { id: 'a1' } : null
        return null
      },
    },
    lab: { findMany: async () => [] },
  })
  const r1 = await identifyLab(mk(false), baseRes({ lab: { nameRaw: 'Excel', nameCnRaw: null, payeeRaw: 'Excel Ltd T/C' } }))
  assert.equal(r1.payeeIsNew, true)
  const r2 = await identifyLab(mk(true), baseRes({ lab: { nameRaw: 'Excel', nameCnRaw: null, payeeRaw: 'Excel Ltd T/C' } }))
  assert.equal(r2.payeeIsNew, false)
  const r3 = await identifyLab(mk(false), baseRes({ lab: { nameRaw: 'Excel', nameCnRaw: null, payeeRaw: null } }))
  assert.equal(r3.payeeIsNew, false)
})

// ── identifyDocNo ───────────────────────────────────
test('identifyDocNo：INVOICE_NO 撞另一張活動單 → duplicateOfId', async () => {
  const prisma: any = {
    labDocument: { findFirst: async (args: any) => (args.where.docNo === 'INV-1' ? { id: 'doc-orig' } : null) },
  }
  const r = await identifyDocNo(prisma, baseRes({ docNoRaw: 'inv-1', kind: 'INVOICE' }), {
    selfDocId: 'doc-self',
    labId: 'lab-x1',
    defaultDocNoKind: 'INVOICE_NO',
  })
  assert.equal(r.docNo, 'INV-1')
  assert.equal(r.docNoKind, 'INVOICE_NO')
  assert.equal(r.duplicateOfId, 'doc-orig')
})

test('identifyDocNo：docNoLabel 含 case → CASE_NO（唔做硬擋）', async () => {
  const prisma: any = { labDocument: { findFirst: async () => ({ id: 'doc-orig' }) } }
  const r = await identifyDocNo(prisma, baseRes({ docNoRaw: '0254131', docNoLabel: 'Case No.' }), {
    selfDocId: 'doc-self',
    labId: 'lab-x1',
    defaultDocNoKind: 'INVOICE_NO',
  })
  assert.equal(r.docNoKind, 'CASE_NO')
  assert.equal(r.duplicateOfId, null)
})

test('identifyDocNo：labId null（Others）→ 唔做硬擋', async () => {
  const prisma: any = { labDocument: { findFirst: async () => ({ id: 'doc-orig' }) } }
  const r = await identifyDocNo(prisma, baseRes({ docNoRaw: 'INV-1' }), { selfDocId: 'doc-self', labId: null, defaultDocNoKind: 'INVOICE_NO' })
  assert.equal(r.duplicateOfId, null)
})

test('identifyDocNo：冇單號 → 全 null', async () => {
  const prisma: any = { labDocument: { findFirst: async () => null } }
  const r = await identifyDocNo(prisma, baseRes({ docNoRaw: null }), { selfDocId: 'doc-self', labId: 'lab-x1', defaultDocNoKind: 'INVOICE_NO' })
  assert.equal(r.docNo, null)
  assert.equal(r.docNoKind, null)
  assert.equal(r.duplicateOfId, null)
})
