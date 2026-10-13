/**
 * 實 DB 整合測試：「結轉等單」— 上月標咗「計入下個月」，本月未有同 Lab＋診所＋醫生月結單帶入之前要睇得到
 *
 * ⚠ 會建測試資料 — 只可以對住一個即棄嘅空數據庫跑：
 *   createdb carrywait_it && DATABASE_URL=postgresql://…/carrywait_it npx prisma migrate deploy
 *   LABDOC_IT_THROWAWAY_DB=1 DATABASE_URL=postgresql://…/carrywait_it JWT_SECRET=x npx tsx scripts/it-labdoc-carry-waiting.mts
 */
import assert from 'node:assert'
import { NextRequest } from 'next/server'

if (process.env.LABDOC_IT_THROWAWAY_DB !== '1') {
  console.error('要設 LABDOC_IT_THROWAWAY_DB=1 而且 DATABASE_URL 指住即棄數據庫先跑（會寫測試資料）')
  process.exit(1)
}
const { createToken } = await import('../src/lib/auth')
const { prisma } = await import('../src/lib/prisma')
const PROG = await import('../src/app/api/lab-docs/statement-progress/route')
const REC = await import('../src/app/api/lab-docs/[id]/sections/[sid]/reconcile/route')
const RES = await import('../src/app/api/lab-docs/[id]/sections/[sid]/lines/[lid]/resolve/route')
const DOCR = await import('../src/app/api/lab-docs/[id]/route')

const owner = await prisma.user.create({ data: { name: 'IT Owner', phone: '90000007', password: 'x', role: 'OWNER', status: 'ACTIVE' } as any })
const clinic = await prisma.clinic.create({ data: { name: 'IT 大圍', shortName: 'TW' } as any })
const clinic2 = await prisma.clinic.create({ data: { name: 'IT 元朗', shortName: 'YL' } as any })
const mgr = await prisma.user.create({ data: { name: 'IT Kiosk', phone: '90000008', password: 'x', role: 'KIOSK', status: 'ACTIVE' } as any })
await prisma.userClinic.create({ data: { userId: mgr.id, clinicId: clinic2.id } as any })
const prov = await prisma.provider.create({ data: { name: 'Dr Wait', isActive: true } as any })
const prov2 = await prisma.provider.create({ data: { name: 'Dr Other', isActive: true } as any })
const lab = await prisma.lab.create({ data: { name: 'HC-W' } as any })
const t = createToken({ userId: owner.id, role: 'OWNER', clinics: [], tokenVersion: 0 })
const tm = createToken({ userId: mgr.id, role: 'KIOSK', clinics: [clinic2.id], tokenVersion: 0 })
const mk = (method: string, url: string, body?: unknown, tok = t) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `session=${tok}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

type St = { doc: any; sec: any }
async function mkStatement(month: string, amounts: number[], providerId = prov.id): Promise<St> {
  const doc = await prisma.labDocument.create({ data: { kind: 'STATEMENT', status: 'IN_PROGRESS', labId: lab.id, statementMonth: month, uploadedBy: owner.id } as any })
  const sec = await prisma.labStatementSection.create({ data: { documentId: doc.id, sectionIndex: 0, clinicId: clinic.id, providerId, status: 'PENDING' } as any })
  for (let i = 0; i < amounts.length; i++) {
    await prisma.labStatementLine.create({ data: { sectionId: sec.id, lineIndex: i, lineType: 'INVOICE', amount: amounts[i], docNoRaw: `${month}-${i}`, docNo: `${month}-${i}`, description: 'Crown' } as any })
  }
  return { doc, sec }
}
const rec = async (x: St) => {
  const r = await REC.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/reconcile`), { params: { id: x.doc.id, sid: x.sec.id } })
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j
}
const resolve = async (x: St, lineId: string, resolution: string) => {
  const r = await RES.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/lines/${lineId}/resolve`, { resolution }), { params: { id: x.doc.id, sid: x.sec.id, lid: lineId } })
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j
}
const prog = async (tok = t) => {
  const r = await PROG.GET(mk('GET', '/api/lab-docs/statement-progress?month=2026-10', undefined, tok))
  const j: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j
}
const fp = async () => JSON.stringify(await Promise.all([
  prisma.labStatementLine.findMany({ orderBy: { id: 'asc' } }),
  prisma.labStatementSection.findMany({ orderBy: { id: 'asc' } }),
  prisma.labDocument.findMany({ orderBy: { id: 'asc' } }),
  prisma.auditLog.count(),
]))

// 九月：440 + 60（都標計入下個月）+ 320（唔標）
const sep = await mkStatement('2026-09', [440, 60, 320])
await rec(sep)
const lines = await prisma.labStatementLine.findMany({ where: { sectionId: sep.sec.id }, orderBy: { lineIndex: 'asc' } })
let j = await prog()
assert.deepEqual(j.carryWaiting, []); assert.equal(j.fromMonth, '2026-09')
console.log('1 未標 → 十月冇結轉等單')

await resolve(sep, lines[0].id, 'NEXT_MONTH'); await resolve(sep, lines[1].id, 'NEXT_MONTH')
const before = await fp()
j = await prog()
assert.equal(await fp(), before, 'GET 唔可以寫任何嘢')
assert.equal(j.carryWaiting.length, 1)
assert.deepEqual([j.carryWaiting[0].amount, j.carryWaiting[0].count, j.carryWaiting[0].sectionId, j.carryWaiting[0].clinicName, j.carryWaiting[0].providerName], [500, 2, sep.sec.id, 'IT 大圍', 'Dr Wait'])
const card = j.clinics.find((c: any) => c.clinicName === 'IT 大圍')
assert.ok(card, '冇十月成本／月結單都要有卡')
const ct = card.todo.filter((x: any) => x.kind === 'CARRY')
assert.equal(ct.length, 1); assert.equal(ct[0].amount, 500); assert.equal(ct[0].labName, 'HC-W'); assert.equal(ct[0].sectionId, sep.sec.id)
console.log('2 標咗兩行 → 十月卡片「結轉等單 HC-W · Dr Wait · $500（2 行）」＋列表頂一欄；GET 純讀（DB 指紋冇變）')

// KIOSK → 用唔到進度卡（RBAC 403），唔會見到任何店嘅結轉；其他有 Lab 權限 = 全集團（labdoc B16）
{
  const r = await PROG.GET(mk('GET', '/api/lab-docs/statement-progress?month=2026-10', undefined, tm))
  assert.equal(r.status, 403, '進度卡 KIOSK 用唔到 → 唔會漏其他店嘅結轉')
}
console.log('3 KIOSK → 403（唔會見到結轉）')

// 十月另一位醫生嘅單 → 照等（結轉只入同醫生）
const octOther = await mkStatement('2026-10', [100], prov2.id)
j = await prog()
assert.equal(j.carryWaiting.length, 1)
console.log('4 十月有同 Lab 另一位醫生嘅單 → 仲係等緊')

// 十月同醫生嘅單上傳＋對數 → 自動帶入，唔再等
const oct = await mkStatement('2026-10', [1000])
await rec(oct)
assert.equal(await prisma.labStatementLine.count({ where: { sectionId: oct.sec.id, carriedFromLineId: { not: null } } }), 2)
j = await prog()
assert.deepEqual(j.carryWaiting, [])
assert.equal(j.clinics.find((c: any) => c.clinicName === 'IT 大圍').todo.filter((x: any) => x.kind === 'CARRY').length, 0)
console.log('5 十月同 Lab＋醫生單上傳＋對數 → 兩行自動帶入，「結轉等單」消失')

// 作廢十月單 → 又變返等緊
let r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${oct.doc.id}`, { reason: 'IT' }), { params: { id: oct.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
j = await prog()
assert.equal(j.carryWaiting.length, 1); assert.equal(j.carryWaiting[0].amount, 500)
console.log('6 作廢十月單 → 返去等緊（$500）')

// 九月取消其中一行 → 等單金額跟住變
await resolve(sep, lines[1].id, 'CLEAR')
j = await prog()
assert.equal(j.carryWaiting[0].amount, 440); assert.equal(j.carryWaiting[0].count, 1)
console.log('7 九月取消一行 → 等單變 $440（1 行）')

// 作廢九月單 → 冇得等
r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${sep.doc.id}`, { reason: 'IT' }), { params: { id: sep.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
j = await prog()
assert.deepEqual(j.carryWaiting, [])
void octOther
console.log('8 作廢九月單 → 結轉等單冇咗')

console.log('全部通過')
await prisma.$disconnect()
