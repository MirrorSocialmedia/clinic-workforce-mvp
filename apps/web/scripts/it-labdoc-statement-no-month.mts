/**
 * 實 DB 整合測試：讀單讀唔到月份嘅月結單 — 入口（列表頂「處理中／要補資料」、檔案庫）＋人手補月份
 *
 * ⚠ 會建測試資料 — 只可以對住一個即棄嘅空數據庫跑：
 *   createdb nomonth_it && DATABASE_URL=postgresql://…/nomonth_it npx prisma migrate deploy
 *   LABDOC_IT_THROWAWAY_DB=1 DATABASE_URL=postgresql://…/nomonth_it JWT_SECRET=x npx tsx scripts/it-labdoc-statement-no-month.mts
 */
import assert from 'node:assert'
import { NextRequest } from 'next/server'

if (process.env.LABDOC_IT_THROWAWAY_DB !== '1') {
  console.error('要設 LABDOC_IT_THROWAWAY_DB=1 而且 DATABASE_URL 指住即棄數據庫先跑（會寫測試資料）')
  process.exit(1)
}
const { createToken } = await import('../src/lib/auth')
const { prisma } = await import('../src/lib/prisma')
const LIST = await import('../src/app/api/lab-docs/route')
const HDR = await import('../src/app/api/lab-docs/[id]/statement-header/route')

const owner = await prisma.user.create({ data: { name: 'IT Owner', phone: '90000005', password: 'x', role: 'OWNER', status: 'ACTIVE' } as any })
const emp = await prisma.user.create({ data: { name: 'IT Emp', phone: '90000006', password: 'x', role: 'EMPLOYEE', status: 'ACTIVE' } as any })
const lab = await prisma.lab.create({ data: { name: 'CB-IT' } as any })
const t = createToken({ userId: owner.id, role: 'OWNER', clinics: [], tokenVersion: 0 })
const te = createToken({ userId: emp.id, role: 'EMPLOYEE', clinics: [], tokenVersion: 0 })
const mk = (method: string, url: string, body?: unknown, tok = t) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `session=${tok}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const list = async (qs: string) => {
  const r = await LIST.GET(mk('GET', `/api/lab-docs?${qs}`))
  const j: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(j))
  return j.items.map((d: any) => d.id) as string[]
}
const setMonth = async (id: string, body: unknown, tok = t) => {
  const r = await HDR.PUT(mk('PUT', `/api/lab-docs/${id}/statement-header`, body, tok), { params: { id } })
  return [r.status, await r.json()] as const
}
const doc = (o: Record<string, unknown>) => prisma.labDocument.create({ data: { kind: 'STATEMENT', labId: lab.id, uploadedBy: owner.id, ...o } as any })

const noMonth = await doc({ status: 'NEEDS_REVIEW', statementMonth: null })
const noMonthVoid = await doc({ status: 'VOID', statementMonth: null })
const sep = await doc({ status: 'IN_PROGRESS', statementMonth: '2026-09' })
const queued = await doc({ status: 'UPLOADED', statementMonth: null })

// 主列表（揀咗 9 月）→ 冇月份嗰張唔見；「處理中」兩個請求 → 見到
let ids = await list('kind=STATEMENT&month=2026-09&hideVoid=1&excludeProcessing=1')
assert.deepEqual(ids, [sep.id])
ids = await list('kind=STATEMENT&noMonth=1&status=NEEDS_REVIEW,IN_PROGRESS')
assert.deepEqual(ids, [noMonth.id], '作廢、排隊中都唔入「要補月份」')
ids = await list('kind=STATEMENT&status=UPLOADED,EXTRACTING,EXTRACT_FAILED')
assert.deepEqual(ids, [queued.id])
console.log('1 揀咗 9 月：主列表只有 9 月；「處理中／要補資料」有冇月份嗰張（作廢唔入）＋排隊中嗰張')

// 冇揀月份：主列表唔會同「處理中」重複
ids = await list('kind=STATEMENT&hideVoid=1&excludeProcessing=1')
assert.deepEqual(ids, [sep.id])
// 檔案庫（冇 excludeProcessing）照列晒
ids = await list('kind=STATEMENT')
assert.deepEqual(ids.sort(), [noMonth.id, noMonthVoid.id, sep.id, queued.id].sort())
// 到貨單唔受 noMonth 影響
assert.deepEqual(await list('kind=INVOICE&noMonth=1'), [])
console.log('2 冇揀月份：主列表唔重複；檔案庫照列晒（包括作廢）')

// 補月份：冇權限 → 403；壞月份 → 400；舊版本 → 409；啱 → 200 → 落去 9 月列表
let [st, b] = await setMonth(noMonth.id, { statementMonth: '2026-09', version: noMonth.version }, te)
assert.equal(st, 403, JSON.stringify(b))
;[st, b] = await setMonth(noMonth.id, { statementMonth: '2026-13', version: noMonth.version })
assert.equal(st, 400, JSON.stringify(b))
;[st, b] = await setMonth(noMonth.id, { statementMonth: '2026-09', version: noMonth.version + 5 })
assert.equal(st, 409, JSON.stringify(b))
assert.equal((await prisma.labDocument.findUnique({ where: { id: noMonth.id } }))!.statementMonth, null, '失敗唔可以寫咗')
const auditBefore = await prisma.auditLog.count({ where: { action: 'LAB_STATEMENT_HEADER' } })
;[st, b] = await setMonth(noMonth.id, { statementMonth: '2026-09', version: noMonth.version })
assert.equal(st, 200, JSON.stringify(b))
const after = (await prisma.labDocument.findUnique({ where: { id: noMonth.id } }))!
assert.equal(after.statementMonth, '2026-09'); assert.equal(after.version, noMonth.version + 1); assert.equal(after.status, 'NEEDS_REVIEW')
assert.equal(await prisma.auditLog.count({ where: { action: 'LAB_STATEMENT_HEADER' } }), auditBefore + 1)
console.log('3 補月份：冇權限 403、壞月份 400、舊版本 409（都冇寫）；成功 → 版本 +1、audit 一筆')

// 同一個舊版本再撳（兩部機同時撳）→ 409，唔會寫兩次
;[st, b] = await setMonth(noMonth.id, { statementMonth: '2026-08', version: noMonth.version })
assert.equal(st, 409, JSON.stringify(b))
assert.equal((await prisma.labDocument.findUnique({ where: { id: noMonth.id } }))!.statementMonth, '2026-09')
console.log('4 另一部機用舊版本再改 → 409，月份唔變')

ids = await list('kind=STATEMENT&month=2026-09&hideVoid=1&excludeProcessing=1')
assert.deepEqual(ids.sort(), [noMonth.id, sep.id].sort())
assert.deepEqual(await list('kind=STATEMENT&noMonth=1&status=NEEDS_REVIEW,IN_PROGRESS'), [])
console.log('5 補咗之後：9 月列表見到、「要補資料」冇咗')

// 作廢咗嘅冇月份單 → 唔可以補
;[st, b] = await setMonth(noMonthVoid.id, { statementMonth: '2026-09', version: noMonthVoid.version })
assert.equal(st, 404, JSON.stringify(b))
console.log('6 作廢單補月份 → 404')

console.log('全部通過')
await prisma.$disconnect()
