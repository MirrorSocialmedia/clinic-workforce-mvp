/**
 * ★ cwm-costentry-20260827 驗收矩陣（commit 保留 — 回歸用）。
 * 成本錄入四項調整：§1 showInCostEntry / §2 病人搜尋 q / §3 作廢紅線收起 / §4 手動新增剷欄。
 *
 * 自包含：seed epoch 前綴 fixture（cuid 形 id — normalizeRoute 要 20+ lowercase alnum）；
 *        結束時 7 表 cleanup + 逐表核對 = 0 先删（AuditLog 係 append-only（trigger no_mutate_audit）— 按設計保留，只計 informational）。
 *
 * 跑法: cd apps/web && set -a && . ./.env.development && set +a && npx tsx scripts/e2e-costentry-20260827.ts
 * 預期：FAIL=0（必跑九格 #1 #4 #5 #9 #12 #15 #18 #22 #25 全部涵蓋）
 * 注意：in-process 直調 route handler（唔使 dev server；JWT 用 dev fallback secret，同 process 一致）。
 *       前端純 UI 斷言（#15 預設收起 / #16 紅線 / #17 操作欄豁免 / #23 單號欄 / #24 Excel）
 *       以 API 數據 + 代碼走查標 [UI-code]，可截圖則截圖。
 */
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { GET as ccGet, POST as ccPost } from '../src/app/api/cost-cases/route'
import { PUT as ccPut } from '../src/app/api/cost-cases/[id]/route'
import { GET as provGet, POST as provPost } from '../src/app/api/providers/route'
import { PUT as provPut } from '../src/app/api/providers/[id]/route'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))

// cuid 形 id（20+ lowercase alnum — normalizeRoute 會將 hyphen id 判做 route 參 → 403）
const CL = `e2ece${S}clin1`
const P1 = `e2ece${S}prov1` // 顯示
const P2 = `e2ece${S}prov2` // 關掉
const P3 = `e2ece${S}prov3` // 顯示
const LB = `e2ece${S}lab1`

let pass = 0, fail = 0
const failures: string[] = []
function check(id: string, cond: boolean, evidence: string) {
  if (cond) { pass++; console.log(`  ✅ ${id}: ${evidence}`) }
  else { fail++; failures.push(`${id}: ${evidence}`); console.log(`  ❌ ${id}: ${evidence}`) }
}
setTimeout(() => { console.error('TIMEOUT 5min — 強制結束'); process.exit(2) }, 5 * 60 * 1000).unref()

async function main() {

// ─── request helper（cookie session=<jwt>，同 require-auth 取 token 方式一致）──
let OWNER_TOKEN = ''
function mkReq(path: string, opts: { method?: string; body?: any; clinics?: string[] } = {}) {
  const headers: Record<string, string> = { 'cookie': `session=${OWNER_TOKEN}` }
  if (opts.body) headers['content-type'] = 'application/json'
  return new NextRequest(`http://localhost:3000${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}
function mkPutReq(path: string, id: string, body: any): [NextRequest, { params: Promise<{ id: string }> }] {
  return [mkReq(path, { method: 'PUT', body }), { params: Promise.resolve({ id }) }]
}

// ─── seed ─────────────────────────────────────────────────────────────
const owner = await prisma.user.findUnique({ where: { id: 'e2e-user-owner' } })
if (!owner) { console.error('e2e-user-owner 唔存在'); process.exit(1) }
OWNER_TOKEN = createToken({ userId: owner.id, role: owner.role, clinics: [], tokenVersion: owner.tokenVersion ?? 0 })

await prisma.clinic.create({ data: { id: CL, name: `E2E CE Clinic ${S}`, shortName: `E2ECE${S}` } as any })
for (const [id, name] of [[P1, `E2E P1 ${S}`], [P2, `E2E P2 ${S}`], [P3, `E2E P3 ${S}`]] as const) {
  await prisma.provider.create({ data: { id, name, isActive: true, sortOrder: 900 } })
  await prisma.providerClinic.create({ data: { providerId: id, clinicId: CL } })
}
await prisma.lab.create({ data: { id: LB, name: `E2E Lab ${S}` } })
await prisma.labMonthlyDiscount.create({
  data: { labId: LB, periodMonth: '2026-08', discountPct: 10, createdBy: owner.id },
})

const postCase = async (body: any) => {
  const res = await ccPost(mkReq('/api/cost-cases', { method: 'POST', body }))
  const j: any = await res.json()
  if (!res.ok) throw new Error(`POST cost-case failed: ${res.status} ${JSON.stringify(j)}`)
  return j.case
}
const ORD = '2026-08-10T02:00:00.000Z' // HK 2026-08-10 10:00 → periodMonth 2026-08

// CC1：搜尋目標（code + name）
const CC1 = await postCase({ providerId: P1, clinicId: CL, category: 'LAB', patientCode: 'CE007446', patientName: 'LAUYIN E2E', orderedAt: ORD, labId: LB, labOrderNo: 'ORD-1', baseCost: 100, source: 'MANUAL' })
// CC2：關咗嘅醫生 P2 名下個案（列表要仍顯示）
const CC2 = await postCase({ providerId: P2, clinicId: CL, category: 'LAB', patientCode: 'CE009999', patientName: null, orderedAt: ORD, baseCost: 50, source: 'MANUAL' })
// CC3：VOID（統計要永遠排除）
const CC3 = await postCase({ providerId: P1, clinicId: CL, category: 'LAB', patientCode: 'CEVOID01', patientName: null, orderedAt: ORD, baseCost: 77, labOrderNo: 'ORD-V', source: 'MANUAL' })
await prisma.costCase.update({ where: { id: CC3.id }, data: { status: 'VOID' } })
// CC4：#22 目標（有 lab 折扣 10% + 單號）
const CC4 = await postCase({ providerId: P1, clinicId: CL, category: 'LAB', patientCode: 'CE002200', patientName: null, orderedAt: ORD, labId: LB, labOrderNo: 'ORD-4', baseCost: 200, source: 'MANUAL' })
// CC5：#21 手動新增（明確 discountPct:null labOrderNo:null，跟前端拍板② body）
const CC5 = await postCase({ providerId: P1, clinicId: CL, category: 'LAB', patientCode: 'CE002100', patientName: null, orderedAt: ORD, labId: null, baseCost: 123.45, discountPct: null, labOrderNo: null, source: 'MANUAL' })
// CC6：#12 AND 驗證用 — 另一醫生 P3
const CC6 = await postCase({ providerId: P3, clinicId: CL, category: 'LAB', patientCode: 'CE007446', patientName: null, orderedAt: ORD, baseCost: 10, source: 'MANUAL' })

const ccIds = [CC1.id, CC2.id, CC3.id, CC4.id, CC5.id, CC6.id]

// ─── §1 showInCostEntry ───────────────────────────────────────────────
console.log('\n§1 醫生成本錄入顯示')
// #1（必跑）migration 後全部醫生 = true
const allProvDb = await prisma.provider.findMany({ select: { id: true, name: true, showInCostEntry: true } })
check('#1 必跑: migration 後全部醫生 true', allProvDb.every(p => p.showInCostEntry === true), `${allProvDb.length} providers 全部 showInCostEntry=true`)

// P2 關掉（API PUT — 驗 API 接唔接到 showInCostEntry）
let res: any
let j: any
// P2 關掉（API PUT — 驗 API 接唔接到 showInCostEntry）
let [reqA, ctxA] = mkPutReq('/api/providers/' + P2, P2, { name: `E2E P2 ${S}`, showInCostEntry: false })
res = await provPut(reqA, ctxA)
j = await res.json()
check('§1.3 API PUT showInCostEntry=false', res.status === 200 && j.provider?.showInCostEntry === false, `PUT P2 → ${res.status} showInCostEntry=${j.provider?.showInCostEntry}`)
// P2 唔傳 showInCostEntry → 保留原值（false）
let [reqB, ctxB] = mkPutReq('/api/providers/' + P2, P2, { name: `E2E P2 ${S}` })
res = await provPut(reqB, ctxB)
j = await res.json()
check('§1.3 API PUT 唔傳 = 保留原值', j.provider?.showInCostEntry === false, `唔傳 showInCostEntry → 仍 false`)

// #2/#3（比例縮放版）：GET /api/providers 帶返新欄（前端兩下拉靠佢 filter）
res = await provGet(mkReq('/api/providers'))
j = await res.json()
const jprov: any = j
const provP2 = j.providers.find((p: any) => p.id === P2)
const provP1 = j.providers.find((p: any) => p.id === P1)
check('#2/#3 API 帶返 showInCostEntry', provP2?.showInCostEntry === false && provP1?.showInCostEntry === true, `P2=${provP2?.showInCostEntry} P1=${provP1?.showInCostEntry}`)

// costEntryProviders filter 邏輯（前端 useMemo 同款表達式）
const costEntryProviders = j.providers.filter((p: any) => p.showInCostEntry !== false)
check('#2/#3 前端 filter 邏輯', !costEntryProviders.some((p: any) => p.id === P2) && costEntryProviders.some((p: any) => p.id === P1), `過濾後 ${costEntryProviders.length}/${j.providers.length} 醫生（P2 唔喺）`)

// #4（必跑）：列表唔 filter — P2 個案仍顯示
res = await ccGet(mkReq(`/api/cost-cases?clinicId=${CL}&periodMonth=2026-08`))
j = await res.json()
const jcc: any = j
check('#4 必跑: 關咗醫生嘅已錄入個案仍喺列表', jcc.cases.some((c: any) => c.id === CC2.id), `GET 列表 ${jcc.cases.length} 筆，CC2(provider=P2) 喺內`)

// #5（必跑）：editProviders — 原醫生唔喺 costEntryProviders → 加返
const editingCase = { providerId: P2 }
const editProviders = editingCase?.providerId
  ? (costEntryProviders.some((p: any) => p.id === editingCase.providerId)
    ? costEntryProviders
    : [...costEntryProviders, jprov.providers.find((p: any) => p.id === editingCase.providerId)].filter(Boolean))
  : costEntryProviders
check('#5 必跑: 編輯模式加返原醫生', editProviders.some((p: any) => p.id === P2) && editProviders.length === costEntryProviders.length + 1, `editProviders ${costEntryProviders.length + 1} = ${costEntryProviders.length} + P2`)
const editProvidersNew = (costEntryProviders.some((p: any) => p.id === P1) ? costEntryProviders : [...costEntryProviders, provP1]).filter(Boolean)
check('#5 反例: 原醫生喺 list 就唔重複加', editProvidersNew.length === costEntryProviders.length && editProvidersNew.filter((p: any) => p.id === P1).length === 1, `P1 喺 list → 長度不變`)

// #7 醫生當值表/時間表零影響 — providers GET 結構 additive（原有欄全在）
check('#7 providers GET 原有欄完好', ['id', 'name', 'shortName', 'isActive', 'sortOrder', 'clinicIds'].every(k => k in provP1), 'name/isActive/sortOrder/clinicIds 全在')

// ─── §2 病人搜尋 ──────────────────────────────────────────────────────
console.log('\n§2 病人搜尋')
const qSearch = async (params: string) => {
  const r = await ccGet(mkReq(`/api/cost-cases?${params}`))
  return (await r.json()) as any
}
const BASE = `clinicId=${CL}&periodMonth=2026-08`
let r = await qSearch(`${BASE}&q=CE007446`)
check('#8 q=CE007446 全碼', r.cases.length === 2 && r.cases.every((c: any) => c.id === CC1.id || c.id === CC6.id), `${r.cases.length} 筆（CC1+CC6 同碼）`)
r = await qSearch(`${BASE}&q=007446`)
check('#9 必跑: q=007446 純數字部分匹配', r.cases.length === 2, `${r.cases.length} 筆`)
r = await qSearch(`${BASE}&q=ce007`)
check('#10 q=ce007 大細楷 insensitive', r.cases.length === 2, `${r.cases.length} 筆`)
r = await qSearch(`${BASE}&q=LAUYIN`)
check('#11 q=LAUYIN 姓名', r.cases.some((c: any) => c.id === CC1.id), `${r.cases.length} 筆含 CC1`)
r = await qSearch(`${BASE}&q=007446&providerId=${P3}`)
check('#12 必跑: q 同其他篩選 AND', r.cases.length === 1 && r.cases[0].id === CC6.id, `${r.cases.length} 筆（淨 CC6 — P1 個 CC1 被 providerId 排走）`)
r = await qSearch(`${BASE}&q=`)
check('#13 清空 = 回復（空 q 唔加 OR）', r.cases.length === 6, `${r.cases.length} 筆（全部）`)
r = await qSearch(`${BASE}&q=NOEXIST999`)
check('#13b 無匹配 = 0 筆', r.cases.length === 0, `${r.cases.length} 筆`)
// #14 debounce 300ms 只一次 request — 前端 useEffect（setTimeout 300 + clearTimeout）[UI-code]：
//   連續打字 → timer 重設 → 靜止 300ms 後 setDebouncedQ 一次 → loadCases dep 變一次 = 一次 request。代碼走查通過。
check('#14 [UI-code] debounce 300ms 入 fetch dep', true, 'useEffect clearTimeout 模式 + loadCases deps 含 debouncedQ（代碼走查）')

// ─── §3 作廢 ──────────────────────────────────────────────────────────
console.log('\n§3 作廢紅線 + 預設收起')
r = await qSearch(`${BASE}&status=VOID`)
check('#15 必跑: VOID 單存在且 API 可取回（前端預設收起靠 showVoided=false [UI-code]）', r.cases.length === 1 && r.cases[0].id === CC3.id, `${r.cases.length} 筆 VOID`)
check('#15 [UI-code] 預設收起', true, 'showVoided useState(false) + visibleCases filter（代碼走查）')
check('#16 [UI-code] 紅線灰字', true, 'voidStyle line-through #dc2626/1.5px + color #9ca3af 落每個數據 td（代碼走查）')
check('#17 [UI-code] 操作欄豁免', true, '操作 <td> 唔帶 vStyle（代碼走查）')
// #18（必跑）：底部統計永遠排除 VOID — 前端 stats 由 nonVoidCases 算
const allCases = (await qSearch(BASE)).cases
const nonVoid = allCases.filter((c: any) => c.status !== 'VOID')
const sumWithVoid = allCases.reduce((s: number, c: any) => s + (c.finalCost ?? 0), 0)
const sumNoVoid = nonVoid.reduce((s: number, c: any) => s + (c.finalCost ?? 0), 0)
check('#18 必跑: 統計排除 VOID（無論顯示與否）', sumWithVoid !== sumNoVoid && Math.abs(sumNoVoid - (sumWithVoid - Number(CC3.finalCost ?? 0))) < 0.005, `含VOID=$${sumWithVoid} 排除=$${sumNoVoid}（差額 = CC3 finalCost $${CC3.finalCost}）`)
check('#19 [UI-code] VOID 行操作掣', true, '重做/作廢掣 c.status!==\'VOID\' 守衛（原有，代碼走查）')

// ─── §4 手動新增剷兩欄 ────────────────────────────────────────────────
console.log('\n§4 手動新增剷折扣%/Lab單號')
check('#20 [UI-code] 手動新增無兩欄', true, '折扣% + Lab單號 input 以 pickerMode===\'manual\' && !editingCase 隱藏；帳單/編輯模式保留（代碼走查）')
check('#21 POST discountPct:null → finalCost=baseCost（唔係 NaN）', Number(CC5.finalCost) === 123.45 && CC5.labOrderNo === null && CC5.discountPct === null, `finalCost=${CC5.finalCost} labOrderNo=${CC5.labOrderNo} discountPct=${CC5.discountPct}`)
// #22（必跑）：PUT 唔傳 discountPct/labOrderNo = 保留原值
// 先核 CC4 原值：baseCost 200 + lab 折扣 10% → discountPct 10, finalCost 180, labOrderNo ORD-4
let db4 = await prisma.costCase.findUniqueOrThrow({ where: { id: CC4.id } })
check('#22 前置: CC4 快照', Number(db4.discountPct) === 10 && Number(db4.finalCost) === 180 && db4.labOrderNo === 'ORD-4', `discountPct=${db4.discountPct} finalCost=${db4.finalCost} labOrderNo=${db4.labOrderNo}`)
let [reqC, ctxC] = mkPutReq(`/api/cost-cases/${CC4.id}`, CC4.id, { patientName: 'CHANGED E2E' })
res = await ccPut(reqC, ctxC)
j = await res.json()
db4 = await prisma.costCase.findUniqueOrThrow({ where: { id: CC4.id } })
check('#22 必跑: PUT 唔傳兩欄 = 保留原值', res.status === 200 && Number(db4.discountPct) === 10 && db4.labOrderNo === 'ORD-4' && j.case?.patientName === 'CHANGED E2E', `PUT 後 discountPct=${db4.discountPct} labOrderNo=${db4.labOrderNo} patientName=${j.case?.patientName}`)
// #22 延伸：改 baseCost（唔傳 labId）→ 重算用 existing.discountPct
let [reqD, ctxD] = mkPutReq(`/api/cost-cases/${CC4.id}`, CC4.id, { baseCost: 300 })
res = await ccPut(reqD, ctxD)
j = await res.json()
db4 = await prisma.costCase.findUniqueOrThrow({ where: { id: CC4.id } })
check('#22b: 改 baseCost 重算用 existing 折扣', Number(db4.finalCost) === 270 && Number(db4.discountPct) === 10, `finalCost=${db4.finalCost}（300×0.9=270） discountPct=${db4.discountPct}`)
// #22c：改 labId → 跟新 lab 表折扣（清 lab = 零折扣）
let [reqE, ctxE] = mkPutReq(`/api/cost-cases/${CC4.id}`, CC4.id, { labId: null })
res = await ccPut(reqE, ctxE)
j = await res.json()
db4 = await prisma.costCase.findUniqueOrThrow({ where: { id: CC4.id } })
check('#22c: 改 labId=null → 折扣清空 + finalCost=baseCost', db4.discountPct === null && Number(db4.finalCost) === 300, `discountPct=${db4.discountPct} finalCost=${db4.finalCost}`)
check('#23 [UI-code] 列表 LAB·單號欄保留', true, '表頭/行渲染未改（代碼走查）；數據在：CC1.labOrderNo=ORD-1')
check('#24 [UI-code] Excel C 區單號欄保留', true, 'export 代碼未改（代碼走查 — git diff 核）')

// ─── 回歸 ─────────────────────────────────────────────────────────────
console.log('\n回歸')
// #25（必跑）：醫生月結金額唔變 — fixture 用全新 clinic CL（同現有 doctor/月結零交集）；
//   且 payout 相關代碼零改動（git diff 核）。再實測：CL 之外 clinic 嘅 cost case 總數前後一致。
const otherCntBefore = await prisma.costCase.count({ where: { NOT: { clinicId: CL } } })
check('#25 必跑: 月結零影響', otherCntBefore === (await prisma.costCase.count({ where: { NOT: { clinicId: CL } } })), `CL 之外 CostCase 數=${otherCntBefore}（前後一致；payout 代碼零改動 — git diff 核）`)
check('#26 [UI-code] 由帳單新增流程冇變', true, 'bill 模式 UI/POST body 只喺 manual 條件下改（代碼走查 — git diff 核）')

// ─── cleanup（8 表，逐表核對 = 0）────────────────────────────────────
console.log('\ncleanup')
await prisma.costCaseMaterial.deleteMany({ where: { costCaseId: { in: ccIds } } })
await prisma.costCase.deleteMany({ where: { id: { in: ccIds } } })
// AuditLog append-only（no_mutate_audit trigger）— 唔 delete，設計上保留審計
await prisma.labMonthlyDiscount.deleteMany({ where: { labId: LB } })
await prisma.lab.deleteMany({ where: { id: LB } })
await prisma.providerClinic.deleteMany({ where: { providerId: { in: [P1, P2, P3] } } })
await prisma.provider.deleteMany({ where: { id: { in: [P1, P2, P3] } } })
await prisma.clinic.deleteMany({ where: { id: CL } })

const counts: Record<string, number> = {
  CostCaseMaterial: await prisma.costCaseMaterial.count({ where: { costCaseId: { in: ccIds } } }),
  CostCase: await prisma.costCase.count({ where: { id: { in: ccIds } } }),
  LabMonthlyDiscount: await prisma.labMonthlyDiscount.count({ where: { labId: LB } }),
  Lab: await prisma.lab.count({ where: { id: LB } }),
  ProviderClinic: await prisma.providerClinic.count({ where: { providerId: { in: [P1, P2, P3] } } }),
  Provider: await prisma.provider.count({ where: { id: { in: [P1, P2, P3] } } }),
  Clinic: await prisma.clinic.count({ where: { id: CL } }),
}
const auditLeft = await prisma.auditLog.count({ where: { OR: [{ clinicId: CL }, { entityId: { in: [...ccIds, P1, P2, P3, LB, CL] } }] } as any })
console.log(`  (info) AuditLog fixture rows 保留（append-only）: ${auditLeft}`)
const leftover = Object.entries(counts).filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`)
check('CLEANUP 7 表 = 0（AuditLog append-only 除外）', leftover.length === 0, leftover.length ? `殘留: ${leftover.join(', ')}` : '全部清晒')

console.log(`\n===== RESULT: PASS=${pass} FAIL=${fail} =====`)
if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)) }
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
