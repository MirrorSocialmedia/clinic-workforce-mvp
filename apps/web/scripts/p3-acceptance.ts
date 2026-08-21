/**
 * ★ cw-pa P3 驗收矩陣（commit 保留 — P4 回归用）。
 * 離線驗 internal sync API + GET /api/provider-availability（mock Apricot callFn）。
 *
 * 自包含：開始時 clean + seed base（同 seed-dev-availability.ts base 同批合成數據）
 *        + 建 4 個測試 user；結束時清晒測試 user + syn rows，重新 seed base
 *        （dev DB 15532 還原「seed base 留低」狀態俾 P4）。
 *
 * 跑法: cd apps/web && set -a && . ./.env.development && set +a && npx tsx scripts/p3-acceptance.ts
 * 預期：PASS=30 FAIL=0（28 項 check + 2 項 PII 掃描）。
 * ★ 2026-08-21（cw-lanes-20260821-a2 拍板⑤）：booked 改逐筆回（status）—— 剷咗舊掃描線合併 unit（連 lib 一齊刪）。
 */
import { execSync } from 'child_process'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { POST as internalPost } from '../src/app/api/internal/sync-availability/route'
// ★ P4: __setTestCallFn 移去 ./test-call-fn（route.ts 唔准 export 非 HTTP symbol，next build 會 fail）
import { __setTestCallFn } from '../src/app/api/internal/sync-availability/test-call-fn'
import { GET as paGet } from '../src/app/api/provider-availability/route'
import { mockCall, addDays } from '../testdata/mock-apricot'

const prisma = new PrismaClient()
const SYN = 'syn-clinic'
const MOCK_TOKEN = 'dev-p3-mock-token-0123456789' // ★ dev 測試用 mock 值（唔係真 secret）

const WONG = 'syn-clinic-wong'
const YAU = 'syn-clinic-yau'

// ─── console tee（PII log 檢查）────────────────────────────────────────
const captured: string[] = []
const origWarn = console.warn, origErr = console.error, origLog = console.log
function tee(label: string, ...args: any[]) {
  const s = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  captured.push(`[${label}] ${s}`)
}
console.warn = (...a: any[]) => { tee('W', ...a); origWarn(...a) }
console.error = (...a: any[]) => { tee('E', ...a); origErr(...a) }
console.log = (...a: any[]) => { tee('L', ...a); origLog(...a) }

// ─── 斷言基建 ──────────────────────────────────────────────────────────
let pass = 0, fail = 0
const failures: string[] = []
function check(id: string, cond: boolean, evidence: string) {
  if (cond) { pass++; console.log(`  ✅ ${id}: ${evidence}`) }
  else { fail++; failures.push(`${id}: ${evidence}`); console.log(`  ❌ ${id}: ${evidence}`) }
}

// ─── request helper ────────────────────────────────────────────────────
function mkReq(path: string, opts: { method?: string; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.token) headers.cookie = `session=${opts.token}`
  return new NextRequest(`http://localhost:3000${path}`, { method: opts.method ?? 'GET', headers })
}

// ─── PII 檢查 ──────────────────────────────────────────────────────────
const PII_MARKERS = ['A123456(7)', '陳大文', '91234567', 'after mos & implant pain', 'PAIN', 'Chan Tai Man', 'high blood', '高血壓', 'JOAN NURSE', 'APT0']
function piiCheck(scope: string, haystack: string) {
  const hit = PII_MARKERS.filter((m) => haystack.includes(m))
  check(`PII-${scope}`, hit.length === 0, hit.length ? `LEAKED: ${hit.join('|')}` : 'zero PII marker')
}

// ─── hard timeout ──────────────────────────────────────────────────────
setTimeout(() => { console.error('TIMEOUT 5min — 強制結束'); process.exit(2) }, 5 * 60 * 1000).unref()

const today = (() => { const d = new Date(Date.now() + 8 * 3600 * 1000); return d.toISOString().slice(0, 10) })()

// ─── seed / clean ──────────────────────────────────────────────────────
const seedBase = () => {
  execSync('npx tsx scripts/seed-dev-availability.ts base', { cwd: process.cwd(), stdio: 'pipe' })
}
async function cleanAll() {
  await prisma.providerBooking.deleteMany({ where: { clinicId: { startsWith: SYN } } })
  await prisma.providerAvailability.deleteMany({ where: { clinicId: { startsWith: SYN } } })
  await prisma.clinic.deleteMany({ where: { id: { startsWith: SYN } } })
  await prisma.provider.deleteMany({ where: { id: { startsWith: 'syn-prov' } } })
  await prisma.employee.deleteMany({ where: { userId: { startsWith: 'syn-user-' } } })
  await prisma.userClinic.deleteMany({ where: { userId: { startsWith: 'syn-user-' } } })
  await prisma.user.deleteMany({ where: { id: { startsWith: 'syn-user-' } } })
}

async function mkUser(id: string, role: string, opts: { grants?: string[]; homeClinicId?: string | null; clinics?: string[] } = {}) {
  const roleC = role as 'OWNER' | 'MANAGER' | 'EMPLOYEE'
  await prisma.user.create({
    data: {
      id,
      name: `Syn ${role}`,
      phone: `syn-${id.slice(-6)}@test.local`,
      password: 'x',
      role: roleC,
      status: 'ACTIVE',
      tokenVersion: 0,
      permissionsJson: opts.grants ? JSON.stringify({ grant: opts.grants, deny: [] }) : null,
    },
  })
  for (const c of opts.clinics ?? []) {
    await prisma.userClinic.create({ data: { userId: id, clinicId: c, isPrimary: true } })
  }
  if (role !== 'OWNER') {
    await prisma.employee.create({
      data: { userId: id, homeClinicId: opts.homeClinicId ?? null, joinDate: new Date('2024-01-01') },
    })
  }
  const token = createToken(
    { userId: id, role: roleC, clinics: opts.clinics ?? [], tokenVersion: 0 },
    1,
  )
  return token
}

async function totals() {
  const [avail, book] = await Promise.all([
    prisma.providerAvailability.count(),
    prisma.providerBooking.count(),
  ])
  return { avail, book }
}

async function main() {
  console.log(`\n========== SETUP（clean + seed base + 測試 users）==========`)
  await cleanAll()
  seedBase()
  const tOwner = await mkUser('syn-user-owner', 'OWNER')
  const tMgr = await mkUser('syn-user-mgr', 'MANAGER', { homeClinicId: WONG, clinics: [WONG, YAU] })
  const tEmp = await mkUser('syn-user-emp', 'EMPLOYEE', { homeClinicId: WONG, clinics: [WONG] })
  const tEmpSched = await mkUser('syn-user-emp-sched', 'EMPLOYEE', { grants: ['scheduling'], homeClinicId: WONG, clinics: [WONG] })
  console.log('  setup done')

  const ctxA: any = { calledClinics: [] }
  const mockFn = (p: string) => mockCall(p, ctxA)

  // ═══════════════ A. Internal sync API ═══════════════
  console.log(`\n========== A. POST /api/internal/sync-availability ══════════`)

  // ★ cw-pta（2026-08-21）：改用以 APRICOT_CRON_KEY + x-cron-key（同 /api/apricot/sync/cron 同一個 key）。
  // 先攞原本環境值，最後還原（唔好污染 dev shell 嘅 .env 已載入值）。
  const prevCronKey = process.env.APRICOT_CRON_KEY

  // A1: key 未設 → 503
  delete process.env.APRICOT_CRON_KEY
  const r503 = await internalPost(mkReq('/api/internal/sync-availability', { method: 'POST', headers: { 'x-cron-key': 'whatever' } }))
  const b503 = await r503.json()
  check('I-503', r503.status === 503 && b503.error === 'cron key not configured', `status=${r503.status} body=${JSON.stringify(b503)}`)

  // A2: 錯 token（同長）→ 403
  process.env.APRICOT_CRON_KEY = MOCK_TOKEN
  const r403a = await internalPost(mkReq('/api/internal/sync-availability', { method: 'POST', headers: { 'x-cron-key': 'dev-p3-mock-token-0123456788' } }))
  check('I-403-wrong', r403a.status === 403, `status=${r403a.status}`)

  // A3: 長短唔同 → 403（timingSafeEqual length mismatch = fail）
  const r403b = await internalPost(mkReq('/api/internal/sync-availability', { method: 'POST', headers: { 'x-cron-key': 'short' } }))
  check('I-403-len', r403b.status === 403, `status=${r403b.status}`)

  // A4: 冇 header → 403
  const r403c = await internalPost(mkReq('/api/internal/sync-availability', { method: 'POST' }))
  check('I-403-noheader', r403c.status === 403, `status=${r403c.status}`)

  // A5: 啱 token + mock callFn → 200 + sync 真執行
  __setTestCallFn(mockFn)
  const r200 = await internalPost(mkReq('/api/internal/sync-availability', { method: 'POST', headers: { 'x-cron-key': MOCK_TOKEN } }))
  const b200 = await r200.json()
  check('I-200', r200.status === 200 && b200.ok === true && b200.skippedClinics === 1 && b200.results.length === 5
    && b200.results.every((r: any) => !('error' in r) && typeof r.open === 'number' && typeof r.bookings === 'number' && typeof r.unknown === 'number')
    && typeof b200.durationMs === 'number',
    `status=${r200.status} ok=${b200.ok} skipped=${b200.skippedClinics} results=${b200.results?.length} durationMs=${b200.durationMs}（${b200.start}..${b200.end}）`)

  // A6: DB 真寫入（mock sync 真執行）
  const tA = await totals()
  check('I-200-db', tA.avail === 110 && tA.book === 30, `avail=${tA.avail} book=${tA.book}（22/6 × 5 間接通）`)

  piiCheck('sync-logs', captured.join('\n'))

  // ═══════════════ B. GET /api/provider-availability — auth & scope ═══════════════
  console.log(`\n========== B. GET auth & scope ══════════`)

  const r401 = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`))
  check('G-401', r401.status === 401, `status=${r401.status}`)

  const r403p = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tEmp }))
  check('G-403-noperm', r403p.status === 403, `status=${r403p.status}（EMPLOYEE 無 scheduling）`)

  const r404 = await paGet(mkReq(`/api/provider-availability?clinicId=syn-clinic-nope`, { token: tOwner }))
  check('G-404', r404.status === 404, `status=${r404.status}`)

  const r400a = await paGet(mkReq('/api/provider-availability', { token: tOwner }))
  check('G-400-noclinic', r400a.status === 400, `status=${r400a.status}`)

  const r400b = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}&from=2026/08/20`, { token: tOwner }))
  check('G-400-badfrom', r400b.status === 400, `status=${r400b.status}`)

  // ★★★ MANAGER 跨 clinic → 403
  const rMgrCross = await paGet(mkReq(`/api/provider-availability?clinicId=${YAU}`, { token: tMgr }))
  check('G-403-mgr-cross', rMgrCross.status === 403, `status=${rMgrCross.status}（MANAGER home=旺角 → 油尖）`)

  const rMgrHome = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tMgr }))
  check('G-200-mgr-home', rMgrHome.status === 200, `status=${rMgrHome.status}（MANAGER home clinic）`)

  // EMPLOYEE + scheduling grant → 主屬店 200
  const rEmpSched = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tEmpSched }))
  check('G-200-emp-sched', rEmpSched.status === 200, `status=${rEmpSched.status}（EMPLOYEE+scheduling, home clinic）`)

  // ═══════════════ C. GET shape（OWNER）═══════════════
  console.log(`\n========== C. GET shape ══════════`)
  const r200g = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tOwner }))
  const b200g: any = await r200g.json()
  const to = addDays(today, 6)
  check('G-200-owner', r200g.status === 200 && b200g.clinic?.id === WONG && typeof b200g.clinic?.name === 'string'
    && b200g.from === today && b200g.to === to
    && Array.isArray(b200g.providers) && b200g.providers.length === 6
    && b200g.providers.every((p: any) => typeof p.id === 'string' && typeof p.name === 'string'
      && Array.isArray(p.openSch) && Array.isArray(p.booked)
      && p.openSch.every((o: any) => o.date >= today && o.date <= to && /^\d{2}:\d{2}$/.test(o.start) && /^\d{2}:\d{2}$/.test(o.end))
      && p.booked.every((bk: any) => bk.date >= today && bk.date <= to && /^\d{2}:\d{2}$/.test(bk.start) && /^\d{2}:\d{2}$/.test(bk.end) && typeof bk.status === 'number')),
    `status=${r200g.status} clinic=${JSON.stringify(b200g.clinic)} from=${b200g.from} to=${b200g.to} providers=${b200g.providers?.length}（6 base providers 全列出）`)

  piiCheck('get-response', JSON.stringify(b200g))

  // default from = 今日（HK）
  const rDef = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tOwner }))
  const bDef: any = await rDef.json()
  check('G-200-defaultfrom', rDef.status === 200 && bDef.from === today && bDef.to === to, `from=${bDef.from} to=${bDef.to}`)

  // ═══════════════ E. 逐筆回 e2e（+LAU resync → GET）═══════════════
  console.log(`\n========== E. 逐筆回 e2e（+LAU resync）════════════`)
  await prisma.provider.upsert({
    where: { id: 'syn-prov-lau' },
    update: {},
    create: { id: 'syn-prov-lau', name: 'Dr. Lau', shortName: 'LAU', apricotId: '695e6e511e430c48022a7690', color: '#00bcd4', isActive: true, sortOrder: 9 },
  })
  const r200e = await internalPost(mkReq('/api/internal/sync-availability', { method: 'POST', headers: { 'x-cron-key': MOCK_TOKEN } }))
  const b200e = await r200e.json()
  const tE = await totals()
  check('E-resync', r200e.status === 200 && b200e.ok === true && tE.avail === 145 && tE.book === 65,
    `status=${r200e.status} avail=${tE.avail} book=${tE.book}（預期 145/65 — LAU 由 unknown 變 known）`)

  const rE = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tOwner }))
  const bE: any = await rE.json()
  const lau = bE.providers.find((p: any) => p.id === 'syn-prov-lau')
  const lauDay0 = (lau?.booked ?? []).filter((bk: any) => bk.date === today)
  // ★ 2026-08-21 拍板⑤：逐筆回 —— 11:15–11:45 四筆原樣逐筆出（唔再合併），sort 由 startMin
  check('E-lau-booked', JSON.stringify(lauDay0) === JSON.stringify([
    { date: today, start: '09:30', end: '10:00', status: 0 },
    { date: today, start: '11:15', end: '11:45', status: 0 },
    { date: today, start: '11:15', end: '11:45', status: 0 },
    { date: today, start: '11:15', end: '11:45', status: 0 },
    { date: today, start: '11:15', end: '11:45', status: 0 },
    { date: today, start: '15:00', end: '15:30', status: 4 },
  ]), JSON.stringify(lauDay0))

  // ★ 2026-08-21 拍板②：weekBookings = 該週（from..to 窗口）預約總筆數（LAU：day0 6 筆 + day1 1 筆）
  check('E-lau-weekbookings', lau?.weekBookings === 7, `weekBookings=${lau?.weekBookings}（預期 7）`)

  const lauOpen = (lau?.openSch ?? []).filter((o: any) => o.date === today)
  const ho = bE.providers.find((p: any) => p.id === 'syn-prov-ho')
  const hoDay0 = (ho?.openSch ?? []).filter((o: any) => o.date === today)
  check('E-opensch', lau?.openSch?.length === 7
    && JSON.stringify(lauOpen) === JSON.stringify([{ date: today, start: '09:00', end: '18:00' }])
    && JSON.stringify(hoDay0) === JSON.stringify([
      { date: today, start: '09:00', end: '12:00' },
      { date: today, start: '20:00', end: '22:00' },
    ]),
    `LAU 7 日=${lau?.openSch?.length} day0=${JSON.stringify(lauOpen)}; HO day0=${JSON.stringify(hoDay0)}（2000→20:00）`)

  // 無 row 嘅 provider 都列出：刪 AEGIS 所有 row → openSch/booked = []
  await prisma.providerAvailability.deleteMany({ where: { clinicId: WONG, providerId: 'syn-prov-aegis' } })
  await prisma.providerBooking.deleteMany({ where: { clinicId: WONG, providerId: 'syn-prov-aegis' } })
  const rN = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tOwner }))
  const bN: any = await rN.json()
  const aegis = bN.providers.find((p: any) => p.id === 'syn-prov-aegis')
  check('E-norow-listed', !!aegis && aegis.openSch.length === 0 && aegis.booked.length === 0 && bN.providers.length === 7,
    `AEGIS 列出 openSch=${aegis?.openSch?.length} booked=${aegis?.booked?.length}; providers=${bN.providers.length}`)

  // ═══════════════ F. lastSyncAt + stale 邊界 ═══════════════
  console.log(`\n========== F. sync 新鮮度 ══════════`)

  const rF0 = await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tOwner }))
  const bF0: any = await rF0.json()
  const ageMs = bF0.sync?.lastSyncAt ? Date.now() - new Date(bF0.sync.lastSyncAt).getTime() : -1
  check('S-fresh', bF0.sync?.lastSyncAt !== null && bF0.sync?.stale === false && ageMs >= 0 && ageMs < 5 * 60 * 1000,
    `lastSyncAt=${bF0.sync?.lastSyncAt} ageMs=${ageMs} stale=${bF0.sync?.stale}`)

  // 31 分鐘前 → stale
  const m31 = new Date(Date.now() - 31 * 60 * 1000)
  await prisma.providerAvailability.updateMany({ where: { clinicId: WONG }, data: { syncedAt: m31 } })
  await prisma.providerBooking.updateMany({ where: { clinicId: WONG }, data: { syncedAt: m31 } })
  const bF1: any = await (await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tOwner }))).json()
  check('S-stale-31min', bF1.sync?.stale === true && new Date(bF1.sync?.lastSyncAt).getTime() > Date.now() - 32 * 60 * 1000,
    `lastSyncAt=${bF1.sync?.lastSyncAt} stale=${bF1.sync?.stale}`)

  // 29 分鐘前 → fresh
  const m29 = new Date(Date.now() - 29 * 60 * 1000)
  await prisma.providerAvailability.updateMany({ where: { clinicId: WONG }, data: { syncedAt: m29 } })
  await prisma.providerBooking.updateMany({ where: { clinicId: WONG }, data: { syncedAt: m29 } })
  const bF2: any = await (await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tOwner }))).json()
  check('S-fresh-29min', bF2.sync?.stale === false, `lastSyncAt=${bF2.sync?.lastSyncAt} stale=${bF2.sync?.stale}`)

  // 無 row → lastSyncAt=null, stale=true
  await prisma.providerAvailability.deleteMany({ where: { clinicId: WONG } })
  await prisma.providerBooking.deleteMany({ where: { clinicId: WONG } })
  const bF3: any = await (await paGet(mkReq(`/api/provider-availability?clinicId=${WONG}`, { token: tOwner }))).json()
  check('S-null', bF3.sync?.lastSyncAt === null && bF3.sync?.stale === true, `sync=${JSON.stringify(bF3.sync)}`)

  // ═══════════════ G. RBAC matrix 兼容 ═══════════════
  console.log(`\n========== G. RBAC matrix ══════════`)
  let rbacTsOk = false
  try {
    execSync('npx tsx scripts/check-rbac.ts', { cwd: process.cwd(), stdio: 'pipe' })
    rbacTsOk = true
  } catch (e: any) {
    console.error('check-rbac.ts failed:', e.stderr?.toString() ?? e.message)
  }
  check('R-check-rbac-ts', rbacTsOk, 'npx tsx scripts/check-rbac.ts 通過（internal 豁免 + GET 登記）')

  let rbacShOk = false
  try {
    execSync('bash scripts/check-rbac-matrix.sh', { cwd: process.cwd().replace(/\/apps\/web$/, ''), stdio: 'pipe' })
    rbacShOk = true
  } catch (e: any) {
    console.error('check-rbac-matrix.sh failed:', e.stderr?.toString() ?? e.message)
  }
  check('R-check-rbac-sh', rbacShOk, 'bash scripts/check-rbac-matrix.sh 通過')

  // ─── 總結 + 清理 ───────────────────────────────────────────────────
  console.log(`\n========== SUMMARY ==========`)
  console.log(`PASS=${pass} FAIL=${fail}`)
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  -', f)) }

  // 還原：清測試痕跡 + 重新 seed base（P4 接手狀態）
  __setTestCallFn(null)
  if (prevCronKey === undefined) delete process.env.APRICOT_CRON_KEY
  else process.env.APRICOT_CRON_KEY = prevCronKey
  await cleanAll()
  seedBase()
  const tClean = await totals()
  const [cl, pr] = await Promise.all([
    prisma.clinic.count({ where: { id: { startsWith: SYN } } }),
    prisma.provider.count({ where: { id: { startsWith: 'syn-prov' } } }),
  ])
  check('C-final-state', cl === 6 && pr === 6 && tClean.avail === 0 && tClean.book === 0,
    `dev DB 還原: clinics=${cl} providers=${pr} avail=${tClean.avail} book=${tClean.book}（base seed 留低俾 P4）`)

  console.log(`\nFINAL PASS=${pass} FAIL=${fail}`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
