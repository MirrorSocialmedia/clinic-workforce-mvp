/**
 * 實 DB 對抗式整合測試：月結單人手加行／改行／刪行（錢、權限、鎖、並發、IDOR、audit）
 *
 * ⚠ 會建測試資料 — 只可以對住一個即棄嘅空數據庫跑：
 *   createdb lineedit_it && DATABASE_URL=postgresql://…/lineedit_it npx prisma migrate deploy
 *   LABDOC_IT_THROWAWAY_DB=1 DATABASE_URL=postgresql://…/lineedit_it JWT_SECRET=x npx tsx scripts/it-labdoc-statement-line-edit.mts
 */
import assert from 'node:assert'
import { NextRequest } from 'next/server'

if (process.env.LABDOC_IT_THROWAWAY_DB !== '1') {
  console.error('要設 LABDOC_IT_THROWAWAY_DB=1 而且 DATABASE_URL 指住即棄數據庫先跑（會寫測試資料）')
  process.exit(1)
}
const { createToken } = await import('../src/lib/auth')
const { prisma } = await import('../src/lib/prisma')
const ADD = await import('../src/app/api/lab-docs/[id]/sections/[sid]/lines/route')
const ONE = await import('../src/app/api/lab-docs/[id]/sections/[sid]/lines/[lid]/route')
const REC = await import('../src/app/api/lab-docs/[id]/sections/[sid]/reconcile/route')
const CONF = await import('../src/app/api/lab-docs/[id]/sections/[sid]/confirm/route')
const RES = await import('../src/app/api/lab-docs/[id]/sections/[sid]/lines/[lid]/resolve/route')
const COMB = await import('../src/app/api/lab-docs/[id]/sections/[sid]/combine/route')
const DOCR = await import('../src/app/api/lab-docs/[id]/route')
const RETRY = await import('../src/app/api/lab-docs/[id]/retry/route')

const owner = await prisma.user.create({ data: { name: 'IT Owner', phone: '90000011', password: 'x', role: 'OWNER', status: 'ACTIVE' } as any })
const emp = await prisma.user.create({ data: { name: 'IT Emp', phone: '90000012', password: 'x', role: 'EMPLOYEE', status: 'ACTIVE' } as any })
const kiosk = await prisma.user.create({ data: { name: 'IT Kiosk', phone: '90000013', password: 'x', role: 'KIOSK', status: 'ACTIVE' } as any })
const clinic = await prisma.clinic.create({ data: { name: 'IT 大圍', shortName: 'TW' } as any })
const clinic2 = await prisma.clinic.create({ data: { name: 'IT 元朗', shortName: 'YL' } as any })
await prisma.userClinic.create({ data: { userId: kiosk.id, clinicId: clinic2.id } as any })
const prov = await prisma.provider.create({ data: { name: 'Dr Edit', isActive: true } as any })
const lab = await prisma.lab.create({ data: { name: 'WC-IT' } as any })
const t = createToken({ userId: owner.id, role: 'OWNER', clinics: [], tokenVersion: 0 })
const te = createToken({ userId: emp.id, role: 'EMPLOYEE', clinics: [], tokenVersion: 0 })
const tk = createToken({ userId: kiosk.id, role: 'KIOSK', clinics: [clinic2.id], tokenVersion: 0 })
const mk = (method: string, url: string, body?: unknown, tok = t) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `session=${tok}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

type St = { doc: any; sec: any }
async function mkStatement(month: string, lines: Array<{ amount: number; docNo: string }>): Promise<St> {
  const doc = await prisma.labDocument.create({ data: { kind: 'STATEMENT', status: 'IN_PROGRESS', labId: lab.id, statementMonth: month, uploadedBy: owner.id } as any })
  const sec = await prisma.labStatementSection.create({ data: { documentId: doc.id, sectionIndex: 0, clinicId: clinic.id, providerId: prov.id, status: 'PENDING' } as any })
  for (let i = 0; i < lines.length; i++) {
    await prisma.labStatementLine.create({ data: { sectionId: sec.id, lineIndex: i, lineType: 'INVOICE', amount: lines[i].amount, docNoRaw: lines[i].docNo, docNo: lines[i].docNo, description: 'Crown', patientCode: 'TW1234' } as any })
  }
  await new Promise((r) => setTimeout(r, 5))
  return { doc, sec }
}
const cost = (month: string, amount: number, code: string) => prisma.costCase.create({
  data: { category: 'LAB', clinicId: clinic.id, providerId: prov.id, labId: lab.id, patientCode: code, orderedAt: new Date(`${month}-01T00:00:00Z`),
    receivedAt: new Date(`${month}-15T00:00:00Z`), periodMonth: month, baseCost: amount, finalCost: amount, status: 'PRICED', createdBy: owner.id } as any,
})
const ver = async (x: St) => (await prisma.labDocument.findUnique({ where: { id: x.doc.id } }))!.version
const rj = async (x: St) => ((await prisma.labStatementSection.findUnique({ where: { id: x.sec.id } }))!.resultJson as any)
const add = async (x: St, body: Record<string, unknown>, tok = t) => {
  const r = await ADD.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/lines`, body, tok), { params: { id: x.doc.id, sid: x.sec.id } })
  return [r.status, await r.json()] as const
}
const edit = async (x: St, lid: string, body: Record<string, unknown>, tok = t) => {
  const r = await ONE.PATCH(mk('PATCH', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/lines/${lid}`, body, tok), { params: { id: x.doc.id, sid: x.sec.id, lid } })
  return [r.status, await r.json()] as const
}
const del = async (x: St, lid: string, body: Record<string, unknown>, tok = t) => {
  const r = await ONE.DELETE(mk('DELETE', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/lines/${lid}`, body, tok), { params: { id: x.doc.id, sid: x.sec.id, lid } })
  return [r.status, await r.json()] as const
}
const rec = async (x: St) => {
  const r = await REC.POST(mk('POST', `/api/lab-docs/${x.doc.id}/sections/${x.sec.id}/reconcile`), { params: { id: x.doc.id, sid: x.sec.id } })
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
}
const lineCount = (x: St) => prisma.labStatementLine.count({ where: { sectionId: x.sec.id } })

// 九月：AI 讀到 440，漏咗 4000；成本 440 + 4000
await cost('2026-09', 440, 'C1'); await cost('2026-09', 4000, 'C2')
const A = await mkStatement('2026-09', [{ amount: 440, docNo: 'INV-1' }])
await rec(A)
assert.equal((await rj(A)).diff, -4000)
const aiLine = (await prisma.labStatementLine.findFirst({ where: { sectionId: A.sec.id } }))!

// ── 驗證 ──
let [st, b] = await add(A, { version: await ver(A) }); assert.equal(st, 400, JSON.stringify(b))
for (const amount of ['abc', 1e9, 1.234, '']) { ;[st, b] = await add(A, { amount, version: await ver(A) }); assert.equal(st, 400, `${amount}: ${JSON.stringify(b)}`) }
;[st, b] = await add(A, { amount: 4000, date: '2026-02-30', version: await ver(A) }); assert.equal(st, 400, JSON.stringify(b))
;[st, b] = await add(A, { amount: 4000 }); assert.equal(st, 400, JSON.stringify(b)) // 冇 version
assert.equal(await lineCount(A), 1)
console.log('1 驗證：冇金額／唔係數字／太大／3 個小數位／唔存在嘅日期／冇 version → 400，冇寫到')

// ── 權限／範圍／IDOR ──
;[st] = await add(A, { amount: 4000, version: await ver(A) }, te); assert.equal(st, 403)
;[st] = await add(A, { amount: 4000, version: await ver(A) }, tk); assert.equal(st, 403)
const B = await mkStatement('2026-09', [{ amount: 1, docNo: 'X-1' }])
let r = await ADD.POST(mk('POST', `/api/lab-docs/${A.doc.id}/sections/${B.sec.id}/lines`, { amount: 1, version: await ver(A) }), { params: { id: A.doc.id, sid: B.sec.id } })
assert.equal(r.status, 404) // 段唔屬呢份單
const bLine = (await prisma.labStatementLine.findFirst({ where: { sectionId: B.sec.id } }))!
;[st] = await edit(A, bLine.id, { amount: 2, version: await ver(A) }); assert.equal(st, 404) // 行唔屬呢段
assert.equal(Number((await prisma.labStatementLine.findUnique({ where: { id: bLine.id } }))!.amount), 1)
await prisma.labDocument.update({ where: { id: B.doc.id }, data: { status: 'VOID' } })
console.log('2 權限：冇 lab_statement 403、KIOSK 其他店 403；IDOR：別份單嘅段／別段嘅行 404，冇改到')

// ── 加行 → 重新對數一致 ──
const v0 = await ver(A)
;[st, b] = await add(A, { amount: '4,000', docNo: 'INV-2507', date: '2026-09-25', description: '種植', patientCode: 'TW9999', note: 'AI 讀漏第 2 頁', version: v0 })
assert.equal(st, 200, JSON.stringify(b)); assert.equal(b.reconcile.status, 'OK'); assert.equal(b.reconcile.statementTotal, 4440)
const added = (await prisma.labStatementLine.findUnique({ where: { id: b.lineId } }))!
assert.equal(added.manualSource, 'ADDED'); assert.equal(Number(added.amount), 4000); assert.equal(added.docNo, 'INV-2507'); assert.equal(added.lineIndex, 1)
assert.equal(await ver(A), v0 + 1)
let audit = await prisma.auditLog.findFirst({ where: { action: 'LAB_STATEMENT_LINE_ADD' }, orderBy: { createdAt: 'desc' } })
assert.ok(audit); assert.ok(!JSON.stringify(audit).includes('TW9999'), 'audit 唔可以有病人編號')
console.log('3 加 $4,000 行 → 4440 vs 成本 4440 一致；版本 +1；audit 冇病人編號')

// 舊版本 → 409，冇加到
;[st, b] = await add(A, { amount: 1, version: v0 }); assert.equal(st, 409); assert.equal(b.code, 'VERSION')
assert.equal(await lineCount(A), 2)
// 並發：兩個人用同一個版本同時加 → 只有一個成功
const v1 = await ver(A)
const both = await Promise.all([add(A, { amount: 10, version: v1 }), add(A, { amount: 20, version: v1 })])
assert.deepEqual(both.map(([s]) => s).sort(), [200, 409], JSON.stringify(both))
assert.equal(await lineCount(A), 3)
const winner = both.find(([s]) => s === 200)![1].lineId
console.log('4 舊版本 409；兩個人同時加 → 一個成功、一個 409（唔會重複加）')
;[st] = await del(A, winner, { version: await ver(A) }); assert.equal(st, 200)

// 單號重複：同 Lab 另一份有效月結單有 INV-1 → 問；allowDuplicate 先加
const C = await mkStatement('2026-08', [{ amount: 99, docNo: 'DUP-9' }])
;[st, b] = await add(A, { amount: 99, docNo: 'dup-9', version: await ver(A) }); assert.equal(st, 409); assert.equal(b.code, 'DUPLICATE_DOCNO'); assert.equal(b.month, '2026-08')
;[st, b] = await add(A, { amount: 99, docNo: 'dup-9', version: await ver(A), allowDuplicate: true }); assert.equal(st, 200, JSON.stringify(b))
;[st] = await del(A, b.lineId, { version: await ver(A) }); assert.equal(st, 200)
void C
console.log('5 單號同另一個月重複（大細楷唔同都認到）→ 409 問；確認先加')

// ── 改 AI 行：保留 AI 原值 ──
;[st, b] = await edit(A, aiLine.id, { amount: 400, note: 'AI 讀錯', version: await ver(A) }); assert.equal(st, 200, JSON.stringify(b))
let l1 = (await prisma.labStatementLine.findUnique({ where: { id: aiLine.id } }))!
assert.equal(l1.manualSource, 'EDITED'); assert.equal((l1.aiOriginal as any).amount, 440); assert.equal(Number(l1.amount), 400)
assert.equal(b.reconcile.statementTotal, 4400)
;[st, b] = await edit(A, aiLine.id, { amount: 440, version: await ver(A) }); assert.equal(st, 200)
l1 = (await prisma.labStatementLine.findUnique({ where: { id: aiLine.id } }))!
assert.equal((l1.aiOriginal as any).amount, 440, 'AI 原值唔可以俾第二次改蓋'); assert.equal(l1.manualSource, 'EDITED')
;[st, b] = await edit(A, aiLine.id, { amount: 440, version: await ver(A) }); assert.equal(st, 400) // 冇改到嘢
audit = await prisma.auditLog.findFirst({ where: { action: 'LAB_STATEMENT_LINE_EDIT' }, orderBy: { createdAt: 'desc' } })
assert.ok(audit?.beforeJson?.includes('400') && audit?.afterJson?.includes('440'), JSON.stringify(audit))
console.log('6 改 AI 行 440→400→440：AI 原值一直係 440；冇改到嘢 → 400；audit 有舊數→新數')

// ── 刪：AI 行唔准；人手加嘅行先准 ──
;[st, b] = await del(A, aiLine.id, { version: await ver(A) }); assert.equal(st, 409); assert.equal(b.code, 'LINE_LOCKED')
console.log('7 刪 AI 行 → 409（只可以改或者標記）')

// ── 行層面鎖：計入下個月／人手配對／結轉副本 ──
r = await RES.POST(mk('POST', `/api/lab-docs/${A.doc.id}/sections/${A.sec.id}/lines/${added.id}/resolve`, { resolution: 'NEXT_MONTH' }), { params: { id: A.doc.id, sid: A.sec.id, lid: added.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
;[st, b] = await edit(A, added.id, { amount: 1, version: await ver(A) }); assert.equal(st, 409); assert.ok(b.error.includes('計入下個月'))
;[st] = await del(A, added.id, { version: await ver(A) }); assert.equal(st, 409)
const Oct = await mkStatement('2026-10', [])
await rec(Oct)
const copy = (await prisma.labStatementLine.findFirst({ where: { sectionId: Oct.sec.id, carriedFromLineId: added.id } }))!
;[st, b] = await edit(Oct, copy.id, { amount: 1, version: await ver(Oct) }); assert.equal(st, 409); assert.ok(b.error.includes('上月結轉'))
r = await RES.POST(mk('POST', `/api/lab-docs/${A.doc.id}/sections/${A.sec.id}/lines/${added.id}/resolve`, { resolution: 'CLEAR' }), { params: { id: A.doc.id, sid: A.sec.id, lid: added.id } })
assert.equal(r.status, 200)
await prisma.labStatementLine.update({ where: { id: added.id }, data: { pairMode: 'MANUAL' } })
;[st, b] = await edit(A, added.id, { amount: 1, version: await ver(A) }); assert.equal(st, 409); assert.ok(b.error.includes('未配對到'))
;[st, b] = await edit(A, added.id, { description: '種植（補）', version: await ver(A) }); assert.equal(st, 200, JSON.stringify(b)) // 唔改金額可以
await prisma.labStatementLine.update({ where: { id: added.id }, data: { pairMode: null } })
assert.equal(Number((await prisma.labStatementLine.findUnique({ where: { id: added.id } }))!.amount), 4000)
console.log('8 鎖：計入下個月嘅行改／刪 409；上月結轉副本改 409；人手配對咗嘅行改金額 409（改項目得）')

// ── 確認後唔准；加埋一齊對另一份確認咗都唔准 ──
await rec(A)
r = await CONF.POST(mk('POST', `/api/lab-docs/${A.doc.id}/sections/${A.sec.id}/confirm`, {}), { params: { id: A.doc.id, sid: A.sec.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
;[st, b] = await add(A, { amount: 1, version: await ver(A) }); assert.equal(st, 409); assert.equal(b.code, 'CONFIRMED')
;[st] = await edit(A, aiLine.id, { amount: 1, version: await ver(A) }); assert.equal(st, 409)
;[st] = await del(A, added.id, { version: await ver(A) }); assert.equal(st, 409)
const D = await mkStatement('2026-09', [{ amount: 5, docNo: 'G-1' }])
r = await COMB.POST(mk('POST', `/api/lab-docs/${D.doc.id}/sections/${D.sec.id}/combine`, {}), { params: { id: D.doc.id, sid: D.sec.id } })
assert.equal(r.status, 409) // A 已確認 → 要問
const E = await mkStatement('2026-11', [{ amount: 5, docNo: 'E-1' }])
const F = await mkStatement('2026-11', [{ amount: 6, docNo: 'F-1' }])
await rec(E); await rec(F)
r = await COMB.POST(mk('POST', `/api/lab-docs/${F.doc.id}/sections/${F.sec.id}/combine`, {}), { params: { id: F.doc.id, sid: F.sec.id } })
assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
await prisma.labStatementSection.update({ where: { id: E.sec.id }, data: { status: 'CONFIRMED' } })
;[st, b] = await add(F, { amount: 1, version: await ver(F) }); assert.equal(st, 409); assert.equal(b.code, 'CONFIRMED')
console.log('9 分段已確認 → 加／改／刪全部 409；加埋一齊對嘅另一份已確認 → 都 409')

// ── 作廢文件 → 404 ──
r = await DOCR.DELETE(mk('DELETE', `/api/lab-docs/${D.doc.id}`, { reason: 'IT' }), { params: { id: D.doc.id } }); assert.equal(r.status, 200)
;[st] = await add(D, { amount: 1, version: await ver(D) }); assert.equal(st, 404)
console.log('10 作廢文件 → 404')

// ── 再讀：有人手行 → 409 問；確認先讀 ──
const G = await mkStatement('2026-12', [{ amount: 7, docNo: 'R-1' }])
await rec(G)
;[st] = await add(G, { amount: 8, version: await ver(G) }); assert.equal(st, 200)
await prisma.labDocument.update({ where: { id: G.doc.id }, data: { status: 'EXTRACT_FAILED' } })
process.env.WA_INBOX_LABDOC_URL ??= 'http://127.0.0.1:9/never'
process.env.INTERNAL_LLM_SECRET ??= Buffer.alloc(32).toString('base64')
r = await RETRY.POST(mk('POST', `/api/lab-docs/${G.doc.id}/retry`, {}), { params: { id: G.doc.id } })
let jb: any = await r.json(); assert.equal(r.status, 409, JSON.stringify(jb)); assert.equal(jb.code, 'MANUAL_LINES'); assert.equal(jb.manualLines, 1)
assert.equal((await prisma.labDocument.findUnique({ where: { id: G.doc.id } }))!.status, 'EXTRACT_FAILED')
r = await RETRY.POST(mk('POST', `/api/lab-docs/${G.doc.id}/retry`, { confirmManual: true }), { params: { id: G.doc.id } })
assert.equal(r.status, 202, JSON.stringify(await r.clone().json()))
console.log('11 再讀：有 1 行人手加 → 409 問（狀態冇變）；確認 → 202')

console.log('全部通過')
await prisma.$disconnect()
process.exit(0)
