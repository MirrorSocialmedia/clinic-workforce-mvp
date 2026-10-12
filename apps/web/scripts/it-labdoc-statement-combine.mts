/**
 * 實 DB 整合測試：同醫生同 Lab 同月兩份月結單「兩份加埋一齊對」（錢嘅一致性：成本只計一次、結轉只入一段）
 *
 * ⚠ 會建測試資料 — 只可以對住一個即棄嘅空數據庫跑：
 *   createdb combine_it && DATABASE_URL=postgresql://…/combine_it npx prisma migrate deploy
 *   LABDOC_IT_THROWAWAY_DB=1 DATABASE_URL=postgresql://…/combine_it JWT_SECRET=x npx tsx scripts/it-labdoc-statement-combine.mts
 * 覆蓋：加埋（行加埋 vs 成本一次）、詳情頁組資料、列表各自總數、待處理／逐店卡／成本標示只計主段、
 *   一齊確認、已確認再加第三份（GROUP_CONFIRMED → 打返未確認）、上月結轉只入主段、作廢組員／主段 → 散組。
 */
import assert from 'node:assert'
import { NextRequest } from 'next/server'

if (process.env.LABDOC_IT_THROWAWAY_DB !== '1') {
  console.error('要設 LABDOC_IT_THROWAWAY_DB=1 而且 DATABASE_URL 指住即棄數據庫先跑（會寫測試資料）')
  process.exit(1)
}
const { createToken } = await import('../src/lib/auth')
const { prisma } = await import('../src/lib/prisma')
const { costStatementMarks } = await import('../src/lib/labdoc/cost-statement-marks')
const REC = await import('../src/app/api/lab-docs/[id]/sections/[sid]/reconcile/route')
const RES = await import('../src/app/api/lab-docs/[id]/sections/[sid]/lines/[lid]/resolve/route')
const CONF = await import('../src/app/api/lab-docs/[id]/sections/[sid]/confirm/route')
const COMB = await import('../src/app/api/lab-docs/[id]/sections/[sid]/combine/route')
const DOCR = await import('../src/app/api/lab-docs/[id]/route')
const LIST = await import('../src/app/api/lab-docs/route')
const PEND = await import('../src/app/api/lab-docs/pending/route')
const PROG = await import('../src/app/api/lab-docs/statement-progress/route')
const SUP = await import('../src/app/api/lab-docs/[id]/supersede/route')

// ── fixtures ──
const owner = await prisma.user.create({ data: { name: 'IT Owner', phone: '90000002', password: 'x', role: 'OWNER', status: 'ACTIVE' } as any })
const clinic = await prisma.clinic.create({ data: { name: 'IT 診所', shortName: 'TK' } as any })
const prov = await prisma.provider.create({ data: { name: 'Dr Combine', isActive: true } as any })
const lab = await prisma.lab.create({ data: { name: 'MD-IT' } as any })
const t = createToken({ userId: owner.id, role: 'OWNER', clinics: [], tokenVersion: 0 })
const mk = (method: string, url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `session=${t}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

type St = { doc: any; sec: any }
async function mkStatement(month: string, lines: Array<{ amount: number; docNo: string }>): Promise<St> {
  const doc = await prisma.labDocument.create({ data: { kind: 'STATEMENT', status: 'IN_PROGRESS', labId: lab.id, statementMonth: month, uploadedBy: owner.id } as any })
  const sec = await prisma.labStatementSection.create({ data: { documentId: doc.id, sectionIndex: 0, clinicId: clinic.id, providerId: prov.id, status: 'PENDING' } as any })
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    await prisma.labStatementLine.create({ data: { sectionId: sec.id, lineIndex: i, lineType: 'INVOICE', amount: l.amount, docNoRaw: l.docNo, docNo: l.docNo, description: 'Crown' } as any })
  }
  await new Promise((r) => setTimeout(r, 5)) // createdAt 分先後（主段 = 最早上傳）
  return { doc, sec }
}
const cost = (month: string, amount: number, code: string) => prisma.costCase.create({
  data: { category: 'LAB', clinicId: clinic.id, providerId: prov.id, labId: lab.id, patientCode: code, orderedAt: new Date(`${month}-01T00:00:00Z`),
    receivedAt: new Date(`${month}-15T00:00:00Z`), periodMonth: month, baseCost: amount, finalCost: amount, status: 'PRICED', createdBy: owner.id } as any,
})
const rec = async (x: St) => {
  const r = await REC.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/reconcile`), { params: { id: x.doc.id, sid: x.sec.id } })
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j
}
const combine = async (x: St, body: unknown = {}) => {
  const r = await COMB.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/combine`, body), { params: { id: x.doc.id, sid: x.sec.id } })
  return [r.status, await r.json()] as const
}
const confirm = async (x: St, body: unknown = {}) => {
  const r = await CONF.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/confirm`, body), { params: { id: x.doc.id, sid: x.sec.id } })
  return [r.status, await r.json()] as const
}
const getDoc = async (x: St) => {
  const r = await DOCR.GET(mk('GET', `/api/lab-docs/${x.doc.id}`), { params: { id: x.doc.id } })
  const j: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(j))
  return (j.sections ?? j.document?.sections).find((s: any) => s.id === x.sec.id)
}
const sec = async (x: St) => (await prisma.labStatementSection.findUnique({ where: { id: x.sec.id } }))!
const rj = async (x: St) => ((await sec(x)).resultJson as any)
const docStatus = async (x: St) => (await prisma.labDocument.findUnique({ where: { id: x.doc.id } }))!.status
const carriedIn = (x: St) => prisma.labStatementLine.count({ where: { sectionId: x.sec.id, carriedFromLineId: { not: null } } })
const pendingDiff = async () => {
  const r = await PEND.GET(mk('GET', `/api/lab-docs/pending?category=STATEMENT_DIFF&month=2026-10`))
  const j: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(j))
  return j.categories.find((c: any) => c.key === 'STATEMENT_DIFF')
}
const progressTodo = async () => {
  const r = await PROG.GET(mk('GET', `/api/lab-docs/statement-progress?month=2026-10`))
  const j: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(j))
  return j.clinics.find((c: any) => c.clinicId === clinic.id)
}
const listTotals = async () => {
  const r = await LIST.GET(mk('GET', `/api/lab-docs?kind=STATEMENT&month=2026-10`))
  const j: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(j))
  return Object.fromEntries(j.items.map((d: any) => [d.id, d.sectionSummary?.total]))
}
const marks = () => costStatementMarks(prisma, { month: '2026-10', labIds: [lab.id], clinicIds: null, providerId: null })

// 十月成本 1000（500＋300＋200）；月結單 A（較早）500＋300，B（較遲）200 — 真係兩份單
await cost('2026-10', 500, 'CB01'); await cost('2026-10', 300, 'CB02'); await cost('2026-10', 200, 'CB03')
const A = await mkStatement('2026-10', [{ amount: 500, docNo: 'A-001' }, { amount: 300, docNo: 'A-002' }])
const B = await mkStatement('2026-10', [{ amount: 200, docNo: 'B-001' }])

let j: any = await rec(A); assert.equal(j.statementTotal, 800); assert.equal(j.sectionStatus, 'DIFF')
j = await rec(B); assert.equal(j.statementTotal, 200); assert.equal(j.sectionStatus, 'DIFF')
assert.equal((await pendingDiff()).count, 2)
let s: any = await getDoc(B); assert.equal(s.duplicate?.sectionId, A.sec.id); assert.equal(s.combined, null)
console.log('1 未加埋：A 800、B 200 各自同成本 1000 比 → 兩段都差；B 詳情頁見到重複提示（指 A）')

// ── 加埋 ──
let [st, b] = await combine(B); assert.equal(st, 200, JSON.stringify(b))
assert.deepEqual(b.groupSectionIds, [A.sec.id, B.sec.id])
assert.equal(b.reconcile.statementTotal, 1000); assert.equal(b.reconcile.costTotal, 1000); assert.equal(b.reconcile.status, 'OK')
for (const x of [A, B]) {
  const g = await rj(x)
  assert.equal(g.group.primarySectionId, A.sec.id); assert.equal(g.statementTotal, 1000); assert.equal(g.costTotal, 1000)
  assert.equal((await sec(x)).status, 'OK')
}
assert.equal((await rj(A)).ownStatementTotal, 800); assert.equal((await rj(B)).ownStatementTotal, 200)
assert.equal((await sec(B)).combineWithSectionId, A.sec.id)
console.log('2 B 加埋 A → 1000 vs 成本 1000（成本只計一次）一致；兩段都寫組資料，各自 800／200')

;[st, b] = await combine(B); assert.equal(st, 400, JSON.stringify(b))
s = await getDoc(B); assert.equal(s.duplicate, null); assert.equal(s.combined.primarySectionId, A.sec.id)
assert.equal(s.combined.otherLines.length, 2); assert.ok(s.combined.otherLines.every((l: any) => l.sectionId === A.sec.id && l.docId === A.doc.id))
s = await getDoc(A); assert.equal(s.duplicate, null); assert.equal(s.combined.otherLines.length, 1)
let lt = await listTotals(); assert.equal(lt[A.doc.id], 800); assert.equal(lt[B.doc.id], 200)
console.log('3 再加埋 → 400；詳情頁冇重複提示、見到另一份嘅行；列表 A 800、B 200（唔係兩份都 1000）')

// ── 差額只計一次（待處理／逐店卡／成本標示）──
const extra = await cost('2026-10', 50, 'CB04')
j = await rec(A); assert.equal(j.diff, -50)
let p = await pendingDiff(); assert.equal(p.count, 1); assert.equal(p.items.length, 1); assert.equal(p.items[0].id, A.sec.id)
let pr = await progressTodo(); assert.equal(pr.todo.filter((x: any) => x.kind === 'OPEN').length, 1)
;[st, b] = await confirm(B, {}); assert.equal(st, 400, JSON.stringify(b)) // 有差要原因
;[st, b] = await confirm(B, { reason: 'IT 差 50 下月補' }); assert.equal(st, 200, JSON.stringify(b))
for (const x of [A, B]) { assert.equal((await sec(x)).status, 'CONFIRMED'); assert.equal(await docStatus(x), 'RECONCILED') }
let m = (await marks())[lab.id]; assert.equal(m.status, 'OK_DIFF'); assert.equal(m.diff, -50); assert.deepEqual(m.reasons, ['IT 差 50 下月補'])
;[st] = await confirm(A, { reason: 'x' }); assert.equal(st, 409)
console.log('4 加多 50 成本 → 待處理只列 1 段、逐店卡 1 項；確認 B = 成組確認（兩份文件都已對）；成本標示差 -50（唔係 -100）')

await prisma.costCase.update({ where: { id: extra.id }, data: { status: 'VOID' } as any })
m = (await marks())[lab.id]; assert.equal(m.status, 'CHANGED'); assert.equal(m.changedBy, -50)
console.log('5 確認後成本少咗 50 → 標示「改咗」-50（只計一次）')

// ── 已確認之後再加第三份 C ──
const C = await mkStatement('2026-10', [{ amount: 300, docNo: 'C-001' }])
j = await rec(C); assert.equal(j.statementTotal, 300)
;[st, b] = await combine(C); assert.equal(st, 409); assert.equal(b.code, 'GROUP_CONFIRMED')
assert.deepEqual([...b.confirmedSectionIds].sort(), [A.sec.id, B.sec.id].sort())
assert.equal((await sec(A)).status, 'CONFIRMED'); assert.equal((await sec(C)).combineWithSectionId, null)
;[st, b] = await combine(C, { resetConfirmed: true }); assert.equal(st, 200, JSON.stringify(b))
assert.deepEqual(b.groupSectionIds, [A.sec.id, B.sec.id, C.sec.id])
assert.equal(b.reconcile.statementTotal, 1300); assert.equal(b.reconcile.costTotal, 1000)
for (const x of [A, B, C]) { assert.notEqual((await sec(x)).status, 'CONFIRMED'); assert.equal((await rj(x)).group.primarySectionId, A.sec.id) }
assert.equal(await docStatus(A), 'IN_PROGRESS'); assert.equal(await docStatus(B), 'IN_PROGRESS')
console.log('6 已確認再加 C → 409 問用家；確定 → A、B 打返未確認，三份一齊 1300 vs 1000')

// ── 上月結轉只入主段 ──
const S = await mkStatement('2026-09', [{ amount: 440, docNo: 'S-001' }])
await rec(S)
const sl = (await prisma.labStatementLine.findFirst({ where: { sectionId: S.sec.id } }))!
let r = await RES.POST(mk('POST', `/api/lab-docs/${S.doc.id}/sections/${S.sec.id}/lines/${sl.id}/resolve`, { resolution: 'NEXT_MONTH' }), { params: { id: S.doc.id, sid: S.sec.id, lid: sl.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
assert.equal(await carriedIn(A), 1); assert.equal(await carriedIn(B), 0); assert.equal(await carriedIn(C), 0)
for (const x of [A, B, C]) assert.equal((await rj(x)).statementTotal, 1740)
assert.equal((await rj(A)).ownStatementTotal, 800 + 440)
await Promise.all([rec(A), rec(B), rec(C), rec(B)])
assert.equal(await carriedIn(A), 1); assert.equal(await carriedIn(B), 0); assert.equal(await carriedIn(C), 0)
console.log('7 九月標計入下個月 → 只入主段 A（1 行）；組總數 1740；並發對數三段 → 仍然得 1 行')

// ── 作廢組員 C → 組剩 A＋B ──
r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${C.doc.id}`, { reason: 'IT 作廢' }), { params: { id: C.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
for (const x of [A, B]) { const g = await rj(x); assert.deepEqual(g.group.memberSectionIds, [A.sec.id, B.sec.id]); assert.equal(g.statementTotal, 1440) }
console.log('8 作廢 C → 組剩 A＋B，自動重對 1440')

// ── 作廢主段 A → 散組；結轉副本搬去 B ──
r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${A.doc.id}`, { reason: 'IT 作廢' }), { params: { id: A.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
let gb = await rj(B); assert.ok(!gb.group, JSON.stringify(gb.group)); assert.equal(gb.statementTotal, 640)
assert.equal(await carriedIn(B), 1)
const live = await prisma.labStatementLine.count({ where: { carriedFromLineId: sl.id, section: { document: { status: { notIn: ['VOID', 'SUPERSEDED', 'DUPLICATE'] } } } } as any })
assert.equal(live, 1)
p = await pendingDiff(); assert.equal(p.count, 1); assert.equal(p.items[0].id, B.sec.id)
lt = await listTotals(); assert.equal(lt[B.doc.id], 640)
console.log('9 作廢主段 A → 散組；九月結轉副本搬去 B（全部有效單得 1 行），B 640；待處理列 B')

// ── 十一月：已確認嘅組，作廢其中一份 → 另一份打返未確認（之前確認對住舊合計）──
await cost('2026-11', 100, 'CB11')
const D = await mkStatement('2026-11', [{ amount: 60, docNo: 'D-001' }])
const E = await mkStatement('2026-11', [{ amount: 40, docNo: 'E-001' }])
await rec(D); await rec(E)
;[st, b] = await combine(E); assert.equal(st, 200, JSON.stringify(b)); assert.equal(b.reconcile.status, 'OK')
;[st, b] = await confirm(D); assert.equal(st, 200, JSON.stringify(b))
assert.equal((await sec(E)).status, 'CONFIRMED'); assert.equal(await docStatus(E), 'RECONCILED')
r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${D.doc.id}`, { reason: 'IT 作廢主段' }), { params: { id: D.doc.id } })
b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b)); assert.deepEqual(b.unconfirmedSectionIds, [E.sec.id])
assert.notEqual((await sec(E)).status, 'CONFIRMED'); assert.equal(await docStatus(E), 'IN_PROGRESS')
let ge = await rj(E); assert.ok(!ge.group); assert.equal(ge.statementTotal, 40); assert.equal(ge.diff, -60)
console.log('10 已確認組作廢主段 D → E 打返未確認、重對 40 vs 100（唔會停留喺舊合計 100）')

// ── 十二月：已確認嘅組，Lab 重發其中一份（取代）→ 組關係跟新版、另一份打返未確認 ──
await cost('2026-12', 100, 'CB12')
const F = await mkStatement('2026-12', [{ amount: 70, docNo: 'F-001' }])
const G = await mkStatement('2026-12', [{ amount: 30, docNo: 'G-001' }])
await rec(F); await rec(G)
;[st, b] = await combine(G); assert.equal(st, 200, JSON.stringify(b))
;[st, b] = await confirm(G); assert.equal(st, 200, JSON.stringify(b))
const G2 = await mkStatement('2026-12', [{ amount: 30, docNo: 'G-001' }])
const vG2 = (await prisma.labDocument.findUnique({ where: { id: G2.doc.id } }))!.version
r = await SUP.POST(mk('POST', `/api/lab-docs/${G2.doc.id}/supersede`, { oldDocumentId: G.doc.id, reason: 'IT 重發', version: vG2 }), { params: { id: G2.doc.id } })
b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b)); assert.deepEqual(b.unconfirmedSectionIds, [F.sec.id])
assert.equal((await sec(G2)).combineWithSectionId, F.sec.id)
assert.notEqual((await sec(F)).status, 'CONFIRMED'); assert.equal(await docStatus(F), 'IN_PROGRESS')
for (const x of [F, G2]) { const g = await rj(x); assert.deepEqual(g.group.memberSectionIds, [F.sec.id, G2.sec.id]); assert.equal(g.statementTotal, 100); assert.equal(g.diff, 0) }
// 主段 F 被取代 → 指住 F 嘅 G2 改指新版 F2
const F2 = await mkStatement('2026-12', [{ amount: 70, docNo: 'F-001' }])
const vF2 = (await prisma.labDocument.findUnique({ where: { id: F2.doc.id } }))!.version
r = await SUP.POST(mk('POST', `/api/lab-docs/${F2.doc.id}/supersede`, { oldDocumentId: F.doc.id, reason: 'IT 重發主段', version: vF2 }), { params: { id: F2.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
assert.equal((await sec(G2)).combineWithSectionId, F2.sec.id)
for (const x of [G2, F2]) { const g = await rj(x); assert.equal(g.group.primarySectionId, G2.sec.id); assert.equal(g.statementTotal, 100) }
console.log('11 已確認組其中一份被取代 → 新版自動入組、另一份打返未確認；主段被取代 → 組照樣 100 vs 100')

console.log('全部通過')
await prisma.$disconnect()
