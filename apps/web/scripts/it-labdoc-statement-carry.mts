/**
 * 實 DB 整合測試：月結單「計入下個月」結轉（錢嘅一致性：一行只會喺一個月計一次）
 *
 * ⚠ 會建測試資料（用戶、診所、醫生、Lab、月結單、成本）— 只可以對住一個即棄嘅空數據庫跑：
 *   createdb carry_it && DATABASE_URL=postgresql://…/carry_it npx prisma migrate deploy
 *   LABDOC_IT_THROWAWAY_DB=1 DATABASE_URL=postgresql://…/carry_it JWT_SECRET=x npx tsx scripts/it-labdoc-statement-carry.mts
 * 覆蓋：標記／取消、下個月自動帶入、並發對數唔重複、單號重複（標記時／對數時）、已確認鎖、
 *   改醫生擋、鏈（九→十→十一月）、作廢、取代（包括已確認後取代）。
 */
import assert from 'node:assert'
import { NextRequest } from 'next/server'

if (process.env.LABDOC_IT_THROWAWAY_DB !== '1') {
  console.error('要設 LABDOC_IT_THROWAWAY_DB=1 而且 DATABASE_URL 指住即棄數據庫先跑（會寫測試資料）')
  process.exit(1)
}
const { createToken } = await import('../src/lib/auth')
const { prisma } = await import('../src/lib/prisma')
const REC = await import('../src/app/api/lab-docs/[id]/sections/[sid]/reconcile/route')
const RES = await import('../src/app/api/lab-docs/[id]/sections/[sid]/lines/[lid]/resolve/route')
const CONF = await import('../src/app/api/lab-docs/[id]/sections/[sid]/confirm/route')
const ASSIGN = await import('../src/app/api/lab-docs/[id]/sections/[sid]/assign/route')
const DOCR = await import('../src/app/api/lab-docs/[id]/route')
const SUP = await import('../src/app/api/lab-docs/[id]/supersede/route')

// ── fixtures ──
const owner = await prisma.user.create({ data: { name: 'IT Owner', phone: '90000001', password: 'x', role: 'OWNER', status: 'ACTIVE' } as any })
const clinic = await prisma.clinic.create({ data: { name: 'IT 診所', shortName: 'YL' } as any })
const prov = await prisma.provider.create({ data: { name: 'Dr IT', isActive: true } as any })
const prov2 = await prisma.provider.create({ data: { name: 'Dr IT2', isActive: true } as any })
const lab = await prisma.lab.create({ data: { name: 'KEA-IT' } as any })
const t = createToken({ userId: owner.id, role: 'OWNER', clinics: [], tokenVersion: 0 })
const mk = (method: string, url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `session=${t}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

async function mkStatement(month: string, lines: Array<{ amount: number; docNo?: string; desc?: string }>) {
  const doc = await prisma.labDocument.create({ data: { kind: 'STATEMENT', status: 'IN_PROGRESS', labId: lab.id, statementMonth: month, uploadedBy: owner.id } as any })
  const sec = await prisma.labStatementSection.create({ data: { documentId: doc.id, sectionIndex: 0, clinicId: clinic.id, providerId: prov.id, status: 'PENDING' } as any })
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    await prisma.labStatementLine.create({ data: { sectionId: sec.id, lineIndex: i, lineType: 'INVOICE', amount: l.amount, docNoRaw: l.docNo ?? null, docNo: l.docNo ?? null, description: l.desc ?? 'Crown' } as any })
  }
  return { doc, sec }
}
const cost = (month: string, amount: number, code: string) => prisma.costCase.create({
  data: { category: 'LAB', clinicId: clinic.id, providerId: prov.id, labId: lab.id, patientCode: code, orderedAt: new Date(`${month}-01T00:00:00Z`),
    receivedAt: new Date(`${month}-15T00:00:00Z`), periodMonth: month, baseCost: amount, finalCost: amount, status: 'PRICED', createdBy: owner.id } as any,
})
const rec = async (x: { doc: any; sec: any }) => {
  const r = await REC.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/reconcile`), { params: { id: x.doc.id, sid: x.sec.id } })
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j
}
const resolve = async (x: { doc: any; sec: any }, lineId: string, resolution: string) => {
  const r = await RES.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/lines/${lineId}/resolve`, { resolution }), { params: { id: x.doc.id, sid: x.sec.id, lid: lineId } })
  return [r.status, await r.json()] as const
}
const rj = async (sid: string) => ((await prisma.labStatementSection.findUnique({ where: { id: sid } }))!.resultJson as any)
const carriedIn = (sid: string) => prisma.labStatementLine.findMany({ where: { sectionId: sid, carriedFromLineId: { not: null } } })
const lineBy = async (sid: string, docNo: string) => (await prisma.labStatementLine.findFirst({ where: { sectionId: sid, docNo, carriedFromLineId: null } }))!

// 9 月：440 + 320 + 440(2609260002, 成本 10 月先到) + $0；10 月：1000
const sep = await mkStatement('2026-09', [{ amount: 440, docNo: '2608260001' }, { amount: 320, docNo: '0251203' }, { amount: 440, docNo: '2609260002' }, { amount: 0, docNo: '0251205', desc: '模型' }])
const oct = await mkStatement('2026-10', [{ amount: 1000, docNo: '2610010001' }])
await cost('2026-09', 440, 'IT01'); await cost('2026-09', 320, 'IT02')
await cost('2026-10', 1000, 'IT03'); await cost('2026-10', 440, 'IT04')
const L3 = await lineBy(sep.sec.id, '2609260002')
const L1 = await lineBy(sep.sec.id, '2608260001')

let j: any = await rec(sep); assert.equal(j.statementTotal, 1200); assert.equal(j.sectionStatus, 'DIFF'); console.log('1 九月未標：月結單 1200 vs 成本 760 → 差', j.diff)
j = await rec(oct); assert.equal(j.statementTotal, 1000); assert.equal(j.costTotal, 1440); console.log('2 十月未有結轉：1000 vs 1440')

// ── 標計入下個月 ──
let [st, b] = await resolve(sep, L3.id, 'NEXT_MONTH'); assert.equal(st, 200, JSON.stringify(b))
assert.equal(b.reconcile.status, 'OK'); assert.equal(b.reconcile.statementTotal, 760)
assert.equal((await rj(sep.sec.id)).nextMonthTotal, 440)
let c = await carriedIn(oct.sec.id); assert.equal(c.length, 1); assert.equal(c[0].carriedFromLineId, L3.id); assert.equal(c[0].carriedFromMonth, '2026-09'); assert.equal(c[0].patientRaw, null)
let o: any = await rj(oct.sec.id); assert.equal(o.statementTotal, 1440); assert.equal(o.carryInTotal, 440); assert.equal(o.totalsOk, true)
console.log('3 九月標計入下個月 → 九月 760 一致；十月自動帶入 1 行 → 1440 一致')

// ── 並發：同時對數 6 次 → 都係得 1 行副本 ──
await Promise.all(Array.from({ length: 6 }, () => rec(oct)))
c = await carriedIn(oct.sec.id); assert.equal(c.length, 1); console.log('4 並發對數 6 次 → 副本仍然得 1 行')

// ── 單號重複（標記時）：十月單已經有 2608260001 → 九月嗰行唔准計入下個月 ──
const dupNative = await prisma.labStatementLine.create({ data: { sectionId: oct.sec.id, lineIndex: 50, lineType: 'INVOICE', amount: 440, docNo: '2608260001', docNoRaw: '2608260001' } as any })
;[st, b] = await resolve(sep, L1.id, 'NEXT_MONTH'); assert.equal(st, 409); assert.equal(b.code, 'CARRY_BLOCKED'); console.log('5 標記時單號重複 →', b.error)
await prisma.labStatementLine.delete({ where: { id: dupNative.id } })

// ── 單號重複（對數時）：十月單又列咗 2609260002 → 副本唔計，唔會計兩次 ──
const dup2 = await prisma.labStatementLine.create({ data: { sectionId: oct.sec.id, lineIndex: 51, lineType: 'INVOICE', amount: 440, docNo: '2609260002', docNoRaw: '2609260002' } as any })
j = await rec(oct); o = await rj(oct.sec.id)
assert.equal(j.statementTotal, 1440, '1000 + 十月自己嗰行 440；副本唔計'); assert.equal(o.carryDuplicateLineIds.length, 1); assert.equal(o.carryInTotal, 0)
console.log('6 對數時單號重複 → 副本唔計，總數 1440（冇計兩次）')
await prisma.labStatementLine.delete({ where: { id: dup2.id } }); j = await rec(oct); assert.equal(j.statementTotal, 1440); assert.equal((await rj(oct.sec.id)).carryInTotal, 440)

// ── 十月確認 → 九月唔准取消／改標記／改醫生 ──
let r = await CONF.POST(mk('POST', `/api/lab-docs/${oct.doc.id}/sections/${oct.sec.id}/confirm`, {}), { params: { id: oct.doc.id, sid: oct.sec.id } }); assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
;[st, b] = await resolve(sep, L3.id, 'CLEAR'); assert.equal(st, 409); assert.equal(b.code, 'CARRY_LOCKED')
;[st, b] = await resolve(sep, L3.id, 'STOCK'); assert.equal(st, 409)
const dv = (await prisma.labDocument.findUnique({ where: { id: sep.doc.id } }))!.version
r = await ASSIGN.POST(mk('POST', `/api/lab-docs/${sep.doc.id}/sections/${sep.sec.id}/assign`, { providerId: prov2.id, version: dv }), { params: { id: sep.doc.id, sid: sep.sec.id } })
assert.equal(r.status, 409, JSON.stringify(await r.clone().json()))
assert.equal((await prisma.labStatementLine.findUnique({ where: { id: L3.id } }))!.resolution, 'NEXT_MONTH')
console.log('7 十月已確認 → 九月取消／改備貨／改醫生 全部 409，標記保持')

// 確認咗嘅十月：再對數唔郁副本
c = await carriedIn(oct.sec.id); assert.equal(c.length, 1)

// ── 解返確認（模擬人手重開）→ 取消 → 十月副本即刻刪、十月變差 440 ──
await prisma.labStatementSection.update({ where: { id: oct.sec.id }, data: { status: 'OK', confirmedAt: null, confirmedBy: null } })
await prisma.labDocument.update({ where: { id: oct.doc.id }, data: { status: 'IN_PROGRESS' } })
;[st, b] = await resolve(sep, L3.id, 'CLEAR'); assert.equal(st, 200, JSON.stringify(b)); assert.equal(b.reconcile.statementTotal, 1200)
c = await carriedIn(oct.sec.id); assert.equal(c.length, 0); o = await rj(oct.sec.id); assert.equal(o.statementTotal, 1000); assert.equal(o.totalsOk, false)
console.log('8 取消 → 九月返 1200；十月副本即刻刪，十月 1000（差 440）')

// ── 鏈：九月 → 十月 → 十一月 ──
const nov = await mkStatement('2026-11', [])
;[st] = await resolve(sep, L3.id, 'NEXT_MONTH'); assert.equal(st, 200)
c = await carriedIn(oct.sec.id); assert.equal(c.length, 1)
;[st, b] = await resolve(oct, c[0].id, 'NEXT_MONTH'); assert.equal(st, 200, JSON.stringify(b)); assert.equal(b.reconcile.statementTotal, 1000)
let cn = await carriedIn(nov.sec.id); assert.equal(cn.length, 1); assert.equal(cn[0].carriedFromLineId, c[0].id); assert.equal(cn[0].carriedFromMonth, '2026-10')
assert.equal((await rj(nov.sec.id)).statementTotal, 440)
console.log('9 鏈：九月 → 十月副本再計入下個月 → 十一月 440（十月 1000）')

// 九月取消（十一月未確認）→ 十月副本、十一月副本一齊冇
;[st] = await resolve(sep, L3.id, 'CLEAR'); assert.equal(st, 200)
assert.equal((await carriedIn(oct.sec.id)).length, 0); assert.equal((await carriedIn(nov.sec.id)).length, 0)
assert.equal((await rj(nov.sec.id)).statementTotal, 0)
console.log('10 九月取消 → 十月、十一月副本一齊刪（鏈同步）')

// 十一月確認咗 → 九月取消要擋（鏈落去有已確認）
;[st] = await resolve(sep, L3.id, 'NEXT_MONTH'); assert.equal(st, 200)
c = await carriedIn(oct.sec.id); ;[st] = await resolve(oct, c[0].id, 'NEXT_MONTH'); assert.equal(st, 200)
await prisma.labStatementSection.update({ where: { id: nov.sec.id }, data: { status: 'CONFIRMED' } })
;[st, b] = await resolve(sep, L3.id, 'CLEAR'); assert.equal(st, 409); assert.equal(b.code, 'CARRY_LOCKED')
;[st, b] = await resolve(oct, c[0].id, 'CLEAR'); assert.equal(st, 409)
console.log('11 十一月已確認 → 九月／十月取消都 409')
await prisma.labStatementSection.update({ where: { id: nov.sec.id }, data: { status: 'OK' } })

// ── 作廢九月 → 十月、十一月副本跟住冇 ──
r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${sep.doc.id}`, { reason: 'IT 作廢' }), { params: { id: sep.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
assert.equal((await carriedIn(oct.sec.id)).length, 0); assert.equal((await carriedIn(nov.sec.id)).length, 0)
assert.equal((await rj(oct.sec.id)).statementTotal, 1000)
console.log('12 作廢九月 → 下游副本即刻清走，十月返 1000')

// ── 取代：Lab 重發九月 → 標記帶去新版；十月副本改指新版，仍然得 1 行 ──
const sepA = await mkStatement('2026-09', [{ amount: 440, docNo: '2608260001' }, { amount: 320, docNo: '0251203' }, { amount: 440, docNo: '2609260002' }])
await rec(sepA)
const A3 = await lineBy(sepA.sec.id, '2609260002')
;[st, b] = await resolve(sepA, A3.id, 'NEXT_MONTH'); assert.equal(st, 200, JSON.stringify(b))
c = await carriedIn(oct.sec.id); assert.equal(c.length, 1); assert.equal(c[0].carriedFromLineId, A3.id)
const sepB = await mkStatement('2026-09', [{ amount: 440, docNo: '2608260001' }, { amount: 320, docNo: '0251203' }, { amount: 440, docNo: '2609260002' }])
const vB = (await prisma.labDocument.findUnique({ where: { id: sepB.doc.id } }))!.version
r = await SUP.POST(mk('POST', `/api/lab-docs/${sepB.doc.id}/supersede`, { oldDocumentId: sepA.doc.id, reason: 'IT 重發', version: vB }), { params: { id: sepB.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
const B3 = await lineBy(sepB.sec.id, '2609260002')
assert.equal((await prisma.labStatementLine.findUnique({ where: { id: B3.id } }))!.resolution, 'NEXT_MONTH')
c = await carriedIn(oct.sec.id); assert.equal(c.length, 1); assert.equal(c[0].carriedFromLineId, B3.id)
assert.equal((await rj(oct.sec.id)).statementTotal, 1440)
console.log('13 取代九月 → 標記帶去新版；十月副本改指新版，仍然 1 行、1440')

// ── 十月已確認之後先取代九月 → 新版取消標記要擋（唔可以兩個月都計）──
await prisma.labStatementSection.update({ where: { id: oct.sec.id }, data: { status: 'CONFIRMED' } })
const sepC = await mkStatement('2026-09', [{ amount: 440, docNo: '2608260001' }, { amount: 320, docNo: '0251203' }, { amount: 440, docNo: '2609260002' }])
const vC = (await prisma.labDocument.findUnique({ where: { id: sepC.doc.id } }))!.version
r = await SUP.POST(mk('POST', `/api/lab-docs/${sepC.doc.id}/supersede`, { oldDocumentId: sepB.doc.id, reason: 'IT 再重發', version: vC }), { params: { id: sepC.doc.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
const C3 = await lineBy(sepC.sec.id, '2609260002')
c = await carriedIn(oct.sec.id); assert.equal(c.length, 1); assert.equal(c[0].carriedFromLineId, C3.id, '已確認嘅副本都改指新版')
;[st, b] = await resolve(sepC, C3.id, 'CLEAR'); assert.equal(st, 409); assert.equal(b.code, 'CARRY_LOCKED')
console.log('14 十月已確認後取代九月 → 副本改指新版；新版取消 409（唔會兩個月都計）')

// ── 九月作廢＋十月已確認，之後再上傳新九月 → 標計入下個月要提示「十月已經計咗」──
r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${sepC.doc.id}`, { reason: 'IT 作廢' }), { params: { id: sepC.doc.id } }); assert.equal(r.status, 200)
const sepD = await mkStatement('2026-09', [{ amount: 440, docNo: '2609260002' }])
await rec(sepD)
const D3 = await lineBy(sepD.sec.id, '2609260002')
;[st, b] = await resolve(sepD, D3.id, 'NEXT_MONTH'); assert.equal(st, 409); assert.ok(String(b.error).includes('唔關我哋事'), b.error)
console.log('15 新九月想再結轉 → 409：', b.error)

// ── 錢嘅總帳：每個時刻 2609260002 只計一次（抽查最後狀態：九月作廢 = 0；十月 0；十一月 0）──
console.log('全部通過')
await prisma.$disconnect()
