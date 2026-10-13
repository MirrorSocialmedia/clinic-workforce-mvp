/**
 * 實 DB 整合測試：成本錄入逐筆「月結單核對」（OK 綠＋月／CHANGED 改咗價／MISSING 月結冇呢筆）
 *
 * ⚠ 會建測試資料 — 只可以對住一個即棄嘅空數據庫跑：
 *   createdb links_it && DATABASE_URL=postgresql://…/links_it npx prisma migrate deploy
 *   LABDOC_IT_THROWAWAY_DB=1 DATABASE_URL=postgresql://…/links_it JWT_SECRET=x npx tsx scripts/it-labdoc-cost-statement-links.mts
 * 覆蓋：未確認唔綠、確認後綠／月結冇呢筆、GET 純讀（DB 冇任何改動）、經 PUT 改價→改咗價→改返→綠、改醫生、
 *   作廢成本、確認後新加成本、作廢月結單、取代（新版確認先返綠）、「兩份加埋一齊對」、MANAGER 範圍唔漏其他店。
 */
import assert from 'node:assert'
import { NextRequest } from 'next/server'

if (process.env.LABDOC_IT_THROWAWAY_DB !== '1') {
  console.error('要設 LABDOC_IT_THROWAWAY_DB=1 而且 DATABASE_URL 指住即棄數據庫先跑（會寫測試資料）')
  process.exit(1)
}
const { createToken } = await import('../src/lib/auth')
const { prisma } = await import('../src/lib/prisma')
const LISTC = await import('../src/app/api/cost-cases/route')
const COST = await import('../src/app/api/cost-cases/[id]/route')
const REC = await import('../src/app/api/lab-docs/[id]/sections/[sid]/reconcile/route')
const CONF = await import('../src/app/api/lab-docs/[id]/sections/[sid]/confirm/route')
const COMB = await import('../src/app/api/lab-docs/[id]/sections/[sid]/combine/route')
const DOCR = await import('../src/app/api/lab-docs/[id]/route')
const SUP = await import('../src/app/api/lab-docs/[id]/supersede/route')

// ── fixtures ──
const owner = await prisma.user.create({ data: { name: 'IT Owner', phone: '90000003', password: 'x', role: 'OWNER', status: 'ACTIVE' } as any })
const clinic = await prisma.clinic.create({ data: { name: 'IT 診所', shortName: 'LK' } as any })
const clinic2 = await prisma.clinic.create({ data: { name: 'IT 診所二', shortName: 'LK2' } as any })
const mgr = await prisma.user.create({ data: { name: 'IT Mgr', phone: '90000004', password: 'x', role: 'MANAGER', status: 'ACTIVE' } as any })
await prisma.userClinic.create({ data: { userId: mgr.id, clinicId: clinic2.id } as any })
const prov = await prisma.provider.create({ data: { name: 'Dr Link', isActive: true } as any })
const prov2 = await prisma.provider.create({ data: { name: 'Dr Link2', isActive: true } as any })
const lab = await prisma.lab.create({ data: { name: 'HC-IT' } as any })
const t = createToken({ userId: owner.id, role: 'OWNER', clinics: [], tokenVersion: 0 })
const tm = createToken({ userId: mgr.id, role: 'MANAGER', clinics: [clinic2.id], tokenVersion: 0 })
const mk = (method: string, url: string, body?: unknown, tok = t) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `session=${tok}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

type St = { doc: any; sec: any }
async function mkStatement(month: string, amounts: number[]): Promise<St> {
  const doc = await prisma.labDocument.create({ data: { kind: 'STATEMENT', status: 'IN_PROGRESS', labId: lab.id, statementMonth: month, uploadedBy: owner.id } as any })
  const sec = await prisma.labStatementSection.create({ data: { documentId: doc.id, sectionIndex: 0, clinicId: clinic.id, providerId: prov.id, status: 'PENDING' } as any })
  for (let i = 0; i < amounts.length; i++) {
    await prisma.labStatementLine.create({ data: { sectionId: sec.id, lineIndex: i, lineType: 'INVOICE', amount: amounts[i], docNoRaw: `N${i}`, docNo: `N${i}`, description: 'Crown' } as any })
  }
  await new Promise((r) => setTimeout(r, 5))
  return { doc, sec }
}
const cost = (amount: number, code: string, o: Record<string, unknown> = {}) => prisma.costCase.create({
  data: { category: 'LAB', clinicId: clinic.id, providerId: prov.id, labId: lab.id, patientCode: code, orderedAt: new Date('2026-09-01T00:00:00Z'),
    receivedAt: new Date('2026-09-15T00:00:00Z'), periodMonth: '2026-09', baseCost: amount, finalCost: amount, status: 'PRICED', createdBy: owner.id, ...o } as any,
})
const rec = async (x: St) => {
  const r = await REC.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/reconcile`), { params: { id: x.doc.id, sid: x.sec.id } })
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j
}
const confirm = async (x: St, reason = 'IT 有差') => {
  const r = await CONF.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/confirm`, { reason }), { params: { id: x.doc.id, sid: x.sec.id } })
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j
}
const links = async (tok = t, qs = 'periodMonth=2026-09&dateMode=received') => {
  const r = await LISTC.GET(mk('GET', `/api/cost-cases?${qs}`, undefined, tok))
  const j: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(j))
  return Object.fromEntries(j.cases.map((c: any) => [c.patientCode, c.statementLink])) as Record<string, any>
}
const put = async (id: string, body: unknown) => {
  const r = await COST.PUT(mk('PUT', `/api/cost-cases/${id}`, body), { params: Promise.resolve({ id }) })
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j
}
// DB 指紋：GET 之後要一模一樣（純讀）
const fingerprint = async () => JSON.stringify(await Promise.all([
  prisma.costCase.findMany({ orderBy: { id: 'asc' } }),
  prisma.labStatementSection.findMany({ orderBy: { id: 'asc' } }),
  prisma.labStatementLine.findMany({ orderBy: { id: 'asc' } }),
  prisma.labDocument.findMany({ orderBy: { id: 'asc' } }),
  prisma.auditLog.count(),
]))

// 九月：成本 440（P1）、320（P2）；月結單得 440 一行 → P2 月結冇
const c1 = await cost(440, 'P1'); const c2 = await cost(320, 'P2')
const A = await mkStatement('2026-09', [440])
await rec(A)
let L = await links(); assert.equal(L.P1, null); assert.equal(L.P2, null)
console.log('1 對咗數但未確認 → 兩筆都冇標示（唔綠）')

await confirm(A)
const fp0 = await fingerprint()
L = await links()
assert.deepEqual(L.P1, { state: 'OK', docId: A.doc.id, sectionId: A.sec.id, confirmedFinalCost: 440 })
assert.equal(L.P2.state, 'MISSING'); assert.equal(L.P2.sectionId, A.sec.id)
await links(); await links(t, 'periodMonth=2026-09') // 落單日模式都有
assert.equal(await fingerprint(), fp0, 'GET 唔可以寫任何嘢')
L = await links(t, 'periodMonth=2026-09'); assert.equal(L.P1.state, 'OK')
console.log('2 確認 → P1 綠（月）、P2「月結冇呢筆」；落單日模式都有；GET 三次 DB 指紋冇變（純讀）')

// ── 經真 PUT 改價 → 改咗價；改返 → 綠 ──
await put(c1.id, { baseCost: 480 })
assert.equal(Number((await prisma.costCase.findUnique({ where: { id: c1.id } }))!.finalCost), 480)
L = await links(); assert.equal(L.P1.state, 'CHANGED'); assert.equal(L.P1.confirmedFinalCost, 440)
await put(c1.id, { baseCost: 440 })
L = await links(); assert.equal(L.P1.state, 'OK')
console.log('3 PUT 改價 480 → 核對後改咗價（確認時 440）；改返 440 → 返綠')

// ── 改醫生 → 改咗資料；改返 → 綠 ──
await put(c1.id, { providerId: prov2.id })
L = await links(); assert.equal(L.P1.state, 'CHANGED'); assert.equal(L.P1.confirmedFinalCost, null)
await put(c1.id, { providerId: prov.id })
L = await links(); assert.equal(L.P1.state, 'OK')
console.log('4 改醫生 → 核對後改咗資料；改返 → 返綠')

// ── 作廢成本 → 冇標示；確認後先加嘅成本 → 月結冇呢筆 ──
let r = await COST.DELETE(mk('DELETE', `/api/cost-cases/${c2.id}`), { params: Promise.resolve({ id: c2.id }) })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
await cost(55, 'P3')
L = await links(); assert.equal(L.P2, null); assert.equal(L.P3.state, 'MISSING')
console.log('5 作廢 P2 → 冇標示；確認後新加 P3 → 月結冇呢筆')

// ── MANAGER（只管第二間店）→ 睇唔到第一間店嘅成本／月結段 ──
await prisma.costCase.create({ data: { category: 'LAB', clinicId: clinic2.id, providerId: prov.id, labId: lab.id, patientCode: 'Q1', orderedAt: new Date('2026-09-01T00:00:00Z'), receivedAt: new Date('2026-09-15T00:00:00Z'), periodMonth: '2026-09', baseCost: 440, finalCost: 440, status: 'PRICED', createdBy: owner.id } as any })
L = await links(tm)
assert.deepEqual(Object.keys(L), ['Q1']); assert.equal(L.Q1, null, '第二間店冇月結段 → 唔會借用第一間店嘅段')
console.log('6 MANAGER 範圍：只見自己店，唔會攞到其他店月結段')

// ── 作廢月結單 → 全部冇標示 ──
r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${A.doc.id}`, { reason: 'IT 作廢' }), { params: { id: A.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
L = await links(); assert.equal(L.P1, null); assert.equal(L.P3, null)
console.log('7 作廢月結單 → P1、P3 標示即刻冇')

// ── 取代：B 確認 → 綠；B2 取代 B → 冇綠（未確認）；B2 確認 → 綠指去 B2 ──
const B = await mkStatement('2026-09', [440, 55])
await rec(B); await confirm(B, 'x')
L = await links(); assert.equal(L.P1.state, 'OK'); assert.equal(L.P3.state, 'OK'); assert.equal(L.P1.sectionId, B.sec.id)
const B2 = await mkStatement('2026-09', [440, 55])
const v = (await prisma.labDocument.findUnique({ where: { id: B2.doc.id } }))!.version
r = await SUP.POST(mk('POST', `/api/lab-docs/${B2.doc.id}/supersede`, { oldDocumentId: B.doc.id, reason: 'IT 重發', version: v }), { params: { id: B2.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
L = await links(); assert.equal(L.P1, null)
await rec(B2); await confirm(B2, 'x')
L = await links(); assert.equal(L.P1.state, 'OK'); assert.equal(L.P1.sectionId, B2.sec.id)
console.log('8 取代：舊版綠即刻冇；新版確認先返綠，指去新版')

// ── 兩份加埋一齊對（十月）：440 喺 D、200 喺 E → 兩筆都綠，各一個 ──
await prisma.costCase.createMany({ data: [
  { category: 'LAB', clinicId: clinic.id, providerId: prov.id, labId: lab.id, patientCode: 'R1', orderedAt: new Date('2026-10-01T00:00:00Z'), receivedAt: new Date('2026-10-10T00:00:00Z'), periodMonth: '2026-10', baseCost: 440, finalCost: 440, status: 'PRICED', createdBy: owner.id },
  { category: 'LAB', clinicId: clinic.id, providerId: prov.id, labId: lab.id, patientCode: 'R2', orderedAt: new Date('2026-10-01T00:00:00Z'), receivedAt: new Date('2026-10-10T00:00:00Z'), periodMonth: '2026-10', baseCost: 200, finalCost: 200, status: 'PRICED', createdBy: owner.id },
] as any })
const D = await mkStatement('2026-10', [440]); const E = await mkStatement('2026-10', [200])
await rec(D); await rec(E)
r = await COMB.POST(mk('POST', `/api/lab-docs/${E.doc.id}/sections/${E.sec.id}/combine`, {}), { params: { id: E.doc.id, sid: E.sec.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
L = await links(t, 'periodMonth=2026-10&dateMode=received'); assert.equal(L.R1, null); assert.equal(L.R2, null)
await confirm(D, 'x')
L = await links(t, 'periodMonth=2026-10&dateMode=received')
assert.equal(L.R1.state, 'OK'); assert.equal(L.R2.state, 'OK')
console.log('9 加埋一齊對：未確認冇綠；成組確認 → R1、R2 都綠')

console.log('全部通過')
await prisma.$disconnect()
