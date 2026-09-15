/**
 * ★ cwi-followup-p1-20260915 e2e — 索引管道（夜跑 + 回填 + 8 條 external API + 手動刷新）
 *
 * 跑法: cd apps/web && set -a && . ./.env.development && set +a && npx tsx scripts/e2e-followup-p1-20260915.ts
 *
 * 決定性：CWM dev DB 無 APRICOT credential → 全部用 testdata/mock-apricot-clinical.ts
 * 嘅 in-process stub（x-cron-now 頭控制「今晚幾點」；CLINICAL_INDEX_RATE_MS=5 提速）。
 *
 * 覆蓋：
 *   A  internal 守門（403 ×2）+ 夜跑（4 病人 + 未來 7 日 + 15 call 計數）
 *   B  7 日重掃（隔日補記錄 → hasNote=true）
 *   C  回填（整段 DONE / RATE_LIMITED 續 / maxCalls 續 / maxHours 停）
 *   D  8 條 external API（401/403/404/400 + 形狀 + 過濾 + 零 PII/零電話）
 *   E  手動刷新（200 / 429 倒數 / 503 + lastSyncedAt / audit）
 *   F  收結零殘留
 */
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'

// ─── env（pipeline 喺 call time 讀 — 置頂先）──────────────────────────
process.env.APRICOT_CRON_KEY = 'e2e-cron-key-cwi-p1-0123456789'
process.env.CLINICAL_INDEX_RATE_MS = '5'
const PHONE_KEY = process.env.PHONE_HASH_KEY || 'e2e-phone-key-cwi-p1-fallback'
process.env.PHONE_HASH_KEY = PHONE_KEY

import { phoneHashes } from '../src/lib/phone'
import { runClinicalIndexBackfill } from '../src/lib/clinical-index/backfill'
import { resetClinicalRefreshBuckets } from '../src/lib/clinical-index/refresh'
import { buildClinicalMock, PII_MARKERS, PII_CORE_MARKERS } from '../testdata/mock-apricot-clinical'
import { __setTestCallFn } from '../src/app/api/internal/clinical-index/test-call-fn'
import { POST as nightlyPost } from '../src/app/api/internal/clinical-index-nightly/route'
import { POST as backfillPost } from '../src/app/api/internal/clinical-index-backfill/route'
import { GET as visitsGet } from '../src/app/api/external/v1/patients/visits/route'
import { GET as recallGet } from '../src/app/api/external/v1/patients/recall-due/route'
import { GET as apptsGet } from '../src/app/api/external/v1/appointments/route'
import { GET as patientVisitsGet } from '../src/app/api/external/v1/patients/[patientApricotId]/visits/route'
import { GET as noteGet } from '../src/app/api/external/v1/patients/[patientApricotId]/visits/[visitId]/note/route'
import { GET as balanceGet } from '../src/app/api/external/v1/patients/[patientApricotId]/balance/route'
import { POST as refreshPost } from '../src/app/api/external/v1/patients/[patientApricotId]/refresh/route'

const prisma = new PrismaClient()

// ─── fixture 常數（同 seed-followup-p0.ts）────────────────────────────
const TY = 'fup0tycl0000000000000000001'
const TKW = 'fup0tkwc0000000000000000003'
const DEV_KEY_ID = 'fup0extk0000000000000000001'
const DEV_KEY_PLAINTEXT = 'wfi-dev-9f2c7a1e4b8d3f6a0c5e9b2d7f1a4c8e6b0d3f7a2c5e8b1d4f9a0c3e6b8d2f5a'
const TMP_KEY_ID = 'e2etmpkey000000000000000001'
const TMP_KEY_PLAINTEXT = 'e2e-scope-test-key-cwi-p1'
const NOW1 = new Date('2026-09-15T03:00:00+08:00') // 夜跑一晚（scan 9/14）
const NOW2 = new Date('2026-09-16T03:00:00+08:00') // 夜跑兩晚（重掃 9/14）
const CRON = { 'x-cron-key': process.env.APRICOT_CRON_KEY! }
const H1 = phoneHashes('91234567', PHONE_KEY)[0]
const H2 = phoneHashes('61234567', PHONE_KEY)[0]
const H12 = phoneHashes('91234567/61234567', PHONE_KEY)
const HRAW = ['91234567', '61234567', '85291234567', '99998888'] // 原始電話負斷言
const FIX_PATIENTS = ['cp-std-001', 'cp-tpl-002', 'cp-no-003', 'cp-late-004', 'cp-recall-x', 'cp-unknown-9']

// ─── console tee（log 檢查）──────────────────────────────────────────
const captured: string[] = []
const origErr = console.error, origLog = console.log
function tee(label: string, ...args: any[]) {
  const s = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  captured.push(`[${label}] ${s}`)
}
console.error = (...a: any[]) => { tee('E', ...a); origErr(...a) }
console.log = (...a: any[]) => { tee('L', ...a); origLog(...a) }

// ─── 斷言基建 ─────────────────────────────────────────────────────────
let pass = 0, fail = 0
const failures: string[] = []
function check(id: string, cond: boolean, evidence: string) {
  if (cond) { pass++; origLog(`  ✅ ${id}: ${evidence}`) }
  else { fail++; failures.push(`${id}: ${evidence}`); origLog(`  ❌ ${id}: ${evidence}`) }
}

const allBodies: string[] = [] // 所有 API 回應（零電話/零 PII 總掃描）
function mkReq(path: string, opts: { method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.headers?.['x-api-key'] === undefined && !path.startsWith('/api/internal')) {
    headers['x-api-key'] = DEV_KEY_PLAINTEXT
  }
  return new NextRequest(`http://localhost:3000${path}`, { method: opts.method ?? 'GET', headers })
}
async function call(res: Response, label: string): Promise<any> {
  const body = await res.json().catch(() => null)
  if (body) allBodies.push(JSON.stringify(body))
  return { status: res.status, body, label }
}
function piiScan(scope: string, haystack: string, coreOnly = false) {
  const markers = (coreOnly ? PII_CORE_MARKERS : PII_MARKERS).concat(HRAW)
  const hit = markers.filter((m) => haystack.includes(m))
  check(`PII-${scope}`, hit.length === 0, hit.length ? `LEAKED: ${hit.join('|')}` : 'zero PII/phone marker')
}

const d = (s: string) => new Date(`${s}T00:00:00Z`)
const dateStr = (dt: Date) => dt.toISOString().slice(0, 10)
// Next 15：route handler 第二參 = { params: Promise }（in-process 直調）
const p = (obj: Record<string, string>) => ({ params: Promise.resolve(obj) })

// ─── setup：clean + fixture ───────────────────────────────────────────
async function main() {
origLog('── setup ──')
await prisma.clinicalIndexJob.deleteMany({ where: { kind: { in: ['NIGHTLY', 'BACKFILL'] } } })
await prisma.clinicalRecordIndex.deleteMany({ where: { patientApricotId: { in: FIX_PATIENTS } } })
// AuditLog 係 DB append-only（trigger 禁 DELETE）— 斷言全部用相對 count，唔清理
await prisma.appointmentIndex.deleteMany({ where: { apricotApptId: { in: ['e2e-apt-t1', 'e2e-apt-t2'] } } })
await prisma.externalApiKey.deleteMany({ where: { id: TMP_KEY_ID } })

const savedClinics = await prisma.clinic.findMany({ where: { id: { in: [TY, TKW] } }, select: { id: true, apricotClinicId: true } })
await prisma.clinic.update({ where: { id: TY }, data: { apricotClinicId: 'apr-ty-001' } })
await prisma.clinic.update({ where: { id: TKW }, data: { apricotClinicId: 'apr-tkw-001' } })
const keyRow = await prisma.externalApiKey.findUnique({ where: { id: DEV_KEY_ID } })
const savedScopes = keyRow?.scopes ?? null
await prisma.externalApiKey.update({ where: { id: DEV_KEY_ID }, data: { scopes: ['org', 'bookings', 'patients', 'appointments'], active: true } })

// ─── A. internal 守門 + 夜跑（S2）─────────────────────────────────────
origLog('── A. nightly ──')
{
  let r = await call(await nightlyPost(mkReq('/api/internal/clinical-index-nightly', { method: 'POST' })), 'no-key')
  check('A0a 守門：無 cron key → 403', r.status === 403, `status=${r.status}`)
  r = await call(await nightlyPost(mkReq('/api/internal/clinical-index-nightly', { method: 'POST', headers: { 'x-cron-key': 'wrong' } })), 'wrong-key')
  check('A0b 守門：錯 cron key → 403', r.status === 403, `status=${r.status}`)
}
{
  const mock = buildClinicalMock({ now: NOW1 })
  __setTestCallFn(mock.callFn)
  const r = await call(
    await nightlyPost(mkReq('/api/internal/clinical-index-nightly', { method: 'POST', headers: { ...CRON, 'x-cron-now': NOW1.toISOString() } })),
    'nightly',
  )
  check('A1 夜跑 DONE', r.status === 200 && r.body.status === 'DONE', JSON.stringify({ s: r.body?.status, e: r.body?.lastError }))
  check('A1 病人 4/4', r.body.patientsFound === 4 && r.body.patientsProcessed === 4, `found=${r.body?.patientsFound} proc=${r.body?.patientsProcessed}`)
  check('A1 upserts = 5（4 昨日 + 1 未來 9/22）', r.body.upserts === 5, `upserts=${r.body?.upserts}`)
  check('A1 apiCalls = 15（1 search + 12 三call + 2 重掃 notes）', r.body.apiCalls === 15, `calls=${r.body?.apiCalls}`)
  check('A1 重掃 0（第一晚）', r.body.rescanned === 0, `rescanned=${r.body?.rescanned}`)
  check('A1 零錯誤', r.body.errors === 0, `errors=${r.body?.errors}`)
  __setTestCallFn(null)
}
{
  // DB 斷言
  const rows = await prisma.clinicalRecordIndex.findMany({ where: { patientApricotId: { in: FIX_PATIENTS } }, orderBy: [{ visitDate: 'asc' }, { patientApricotId: 'asc' }] })
  check('A2 索引行 = 5（9/14 ×4 + 9/22 未來）', rows.length === 5, `rows=${rows.length}`)
  const byP = new Map(rows.map(r => [`${r.patientApricotId}|${dateStr(r.visitDate)}`, r]))
  const std = byP.get('cp-std-001|2026-09-14')!
  check('A2 std: STANDARD note + bill 800/300 + hash', std.hasNote && std.noteKind === 'STANDARD' && std.billTtlAmt === 800 && std.billOsAmt === 300 && std.phoneHashes.length === 1 && std.phoneHashes[0] === H1, JSON.stringify({ kind: std.noteKind, ttl: std.billTtlAmt, os: std.billOsAmt }))
  check('A2 std: bookingStatus=4 + reason + provider', std.bookingStatus === 4 && std.visitReasonCodes.includes('FILLING') && std.providerCode === 'DR1', JSON.stringify({ st: std.bookingStatus, r: std.visitReasonCodes }))
  const tpl = byP.get('cp-tpl-002|2026-09-14')!
  check('A2 tpl: TEMPLATE + 多號 2 hash + bill 1500/1500', tpl.noteKind === 'TEMPLATE' && tpl.phoneHashes.length === 2 && tpl.phoneHashes.every(h => H12.includes(h)) && tpl.billTtlAmt === 1500 && tpl.billOsAmt === 1500, JSON.stringify({ kind: tpl.noteKind, hashes: tpl.phoneHashes.length }))
  const tplNote = tpl.noteJson as any
  check('A2 tpl: storedTemplate 內容入（主訴=定期洗牙）', tplNote?.kind === 'TEMPLATE' && tplNote.blocks?.some((b: any) => b.text === '定期洗牙'), JSON.stringify(tplNote?.blocks?.map((b: any) => b.label)))
  check('A2 tpl: 🔴 latestTemplate 內容零洩（LATEST-LEAK 唔喺 noteJson）', !JSON.stringify(tplNote).includes('LATEST-LEAK'), 'no LATEST-LEAK')
  const noshow = byP.get('cp-no-003|2026-09-14')!
  check('A2 no-show: 🔴 bookingStatus=-3 明確 + 無 note/bill', noshow.bookingStatus === -3 && !noshow.hasNote && noshow.billTtlAmt === null, JSON.stringify({ st: noshow.bookingStatus }))
  const late = byP.get('cp-late-004|2026-09-14')!
  check('A2 late: 第一晚 hasNote=false + bill 400/400', !late.hasNote && late.billTtlAmt === 400 && late.billOsAmt === 400, JSON.stringify({ note: late.hasNote, ttl: late.billTtlAmt }))
  const fut = byP.get('cp-std-001|2026-09-22')!
  check('A2 未來行 9/22: hasNote=false + bill null + st=0', fut.hasNote === false && fut.billTtlAmt === null && fut.bookingStatus === 0, JSON.stringify({ st: fut.bookingStatus, note: fut.hasNote }))
  // 零 PII（DB 層）
  const dbDump = JSON.stringify(rows.map(r => ({ note: r.noteJson, hashes: r.phoneHashes, code: r.patientCode })))
  piiScan('A2-db', dbDump)
  check('A2 零原始電話（DB 行）', !dbDump.includes('91234567') && !dbDump.includes('85291234567'), 'no raw phone')
}

// ─── B. 7 日重掃（隔日補記錄）────────────────────────────────────────
origLog('── B. rescan ──')
{
  const mock = buildClinicalMock({ now: NOW2, withLateNote: true })
  __setTestCallFn(mock.callFn)
  const r = await call(
    await nightlyPost(mkReq('/api/internal/clinical-index-nightly', { method: 'POST', headers: { ...CRON, 'x-cron-now': NOW2.toISOString() } })),
    'nightly-2',
  )
  check('B1 第二晚 DONE + 重掃 1', r.body.status === 'DONE' && r.body.rescanned === 1, JSON.stringify({ s: r.body?.status, r: r.body?.rescanned }))
  __setTestCallFn(null)
  const late = await prisma.clinicalRecordIndex.findFirst({ where: { patientApricotId: 'cp-late-004', visitDate: d('2026-09-14') } })
  check('B2 late 補到 hasNote=true（STANDARD）', late!.hasNote && late!.noteKind === 'STANDARD' && (late!.noteJson as any)?.complaints === '拔後傷口不適', JSON.stringify({ note: late!.hasNote, kind: late!.noteKind }))
  const noshow = await prisma.clinicalRecordIndex.findFirst({ where: { patientApricotId: 'cp-no-003', visitDate: d('2026-09-14') } })
  check('B3 no-show 仍然 hasNote=false（無 note 唔會假陽性）', noshow!.hasNote === false, 'still false')
}

// ─── C. 回填（S3）────────────────────────────────────────────────────
origLog('── C. backfill ──')
async function seedBackfillJob(rangeFrom: string, rangeTo: string, cursorDate: string | null = null) {
  await prisma.clinicalIndexJob.deleteMany({ where: { kind: 'BACKFILL' } })
  await prisma.clinicalIndexJob.create({
    data: { kind: 'BACKFILL', rangeFrom: d(rangeFrom), rangeTo: d(rangeTo), cursorDate: cursorDate ? d(cursorDate) : null, status: 'RUNNING', startedAt: new Date() },
  })
}
{
  // C1：整段跑完（4 日範圍，via route — 守門 + 冪等 upsert）
  await seedBackfillJob('2026-09-12', '2026-09-15')
  const mock = buildClinicalMock({ now: NOW2 })
  __setTestCallFn(mock.callFn)
  const r = await call(
    await backfillPost(mkReq('/api/internal/clinical-index-backfill', { method: 'POST', headers: { ...CRON, 'x-cron-now': NOW2.toISOString() } })),
    'backfill-1',
  )
  __setTestCallFn(null)
  check('C1 回填 DONE（整段）', r.body.status === 'DONE' && r.body.cursorDate === null, JSON.stringify({ s: r.body?.status, c: r.body?.cursorDate }))
  check('C1 3 日空 + 9/14 4 病人（冪等重跑）', r.body.processedDays === 4 && r.body.patients === 4, `days=${r.body?.processedDays} p=${r.body?.patients}`)
  check('C1 apiCalls = 16（4 search + 12 三call）', r.body.apiCalls === 16, `calls=${r.body?.apiCalls}`)
  const job = await prisma.clinicalIndexJob.findFirst({ where: { kind: 'BACKFILL' } })
  check('C1 job 行 DONE + cursor null', job!.status === 'DONE' && job!.cursorDate === null, `status=${job!.status}`)
  const cnt = await prisma.clinicalRecordIndex.count({ where: { patientApricotId: { in: FIX_PATIENTS } } })
  check('C1 冪等：行數仍 = 5（無重複）', cnt === 5, `rows=${cnt}`)
}
{
  // C2：APRICOT_RATE_LIMITED → 停當晚，第二晚 cursor 續
  await seedBackfillJob('2026-09-13', '2026-09-14')
  const mockFail = buildClinicalMock({ now: NOW2, failAfterCalls: 5 })
  const r1 = await runClinicalIndexBackfill({ callFn: mockFail.callFn, now: NOW2, daysPerRun: 2 })
  check('C2 RATE_LIMITED 停當晚', r1.status === 'PAUSED_RATE_LIMITED' && r1.cursorDate === '2026-09-14', JSON.stringify({ s: r1.status, c: r1.cursorDate }))
  check('C2 停前 5 call', r1.apiCalls === 5, `calls=${r1.apiCalls}`)
  const job = await prisma.clinicalIndexJob.findFirst({ where: { kind: 'BACKFILL' } })
  check('C2 job 留 RUNNING + cursor=9/14', job!.status === 'RUNNING' && dateStr(job!.cursorDate!) === '2026-09-14', `status=${job!.status} cursor=${job!.cursorDate && dateStr(job!.cursorDate!)}`)
  const mockOk = buildClinicalMock({ now: NOW2 })
  const r2 = await runClinicalIndexBackfill({ callFn: mockOk.callFn, now: NOW2, daysPerRun: 2 })
  check('C2 第二晚續跑 → DONE', r2.status === 'DONE' && r2.cursorDate === null, JSON.stringify({ s: r2.status, c: r2.cursorDate }))
}
{
  // C3：maxCalls 護欄 → 停，續跑完成
  // 口徑：guard 喺「每 patient 前」查 → 最後一個 patient 可超最多 3 call（1 search + 4×3 = 10 确定性）
  await seedBackfillJob('2026-09-14', '2026-09-14')
  const mock = buildClinicalMock({ now: NOW2 })
  const r1 = await runClinicalIndexBackfill({ callFn: mock.callFn, now: NOW2, daysPerRun: 1, maxCalls: 8 })
  check('C3 maxCalls=8 觸發 PAUSED_CALLS（guard 喺 patient 前）', r1.status === 'PAUSED_CALLS' && r1.apiCalls === 10 && r1.cursorDate === '2026-09-14', JSON.stringify({ s: r1.status, c: r1.apiCalls, cur: r1.cursorDate }))
  const r2 = await runClinicalIndexBackfill({ callFn: mock.callFn, now: NOW2, daysPerRun: 1 })
  check('C3 續跑 → DONE（冪等）', r2.status === 'DONE', JSON.stringify({ s: r2.status, p: r2.patients }))
}
{
  // C4：maxHours 護欄（callDelayMs=100 → ~900ms 過 700ms 線）
  await seedBackfillJob('2026-09-14', '2026-09-14')
  const mock = buildClinicalMock({ now: NOW2, callDelayMs: 100 })
  const r1 = await runClinicalIndexBackfill({ callFn: mock.callFn, now: NOW2, daysPerRun: 1, maxHours: 700 / 3_600_000 })
  check('C4 maxHours 觸發 PAUSED_HOURS', r1.status === 'PAUSED_HOURS' && r1.cursorDate === '2026-09-14', JSON.stringify({ s: r1.status, cur: r1.cursorDate, ms: r1.durationMs }))
  const mock2 = buildClinicalMock({ now: NOW2 })
  const r2 = await runClinicalIndexBackfill({ callFn: mock2.callFn, now: NOW2, daysPerRun: 1 })
  check('C4 續跑 → DONE', r2.status === 'DONE', JSON.stringify({ s: r2.status }))
}

// ─── D. external API（S4 + S6 邊界）──────────────────────────────────
origLog('── D. external API ──')
{
  // D0：守門
  let r = await call(await visitsGet(mkReq('/api/external/v1/patients/visits?clinicCode=TY&from=2026-09-14&to=2026-09-14', { headers: { 'x-api-key': '' } })), '401')
  check('D0 無 key → 401', r.status === 401, `status=${r.status}`)
  r = await call(await visitsGet(mkReq('/api/external/v1/patients/visits?clinicCode=TY&from=2026-09-14&to=2026-09-14', { headers: { 'x-api-key': 'wrong-key' } })), '401b')
  check('D0 錯 key → 401', r.status === 401, `status=${r.status}`)
  await prisma.externalApiKey.create({
    data: { id: TMP_KEY_ID, name: 'e2e-scope-test', keyHash: createHash('sha256').update(TMP_KEY_PLAINTEXT, 'utf8').digest('hex'), scopes: ['bookings'], active: true },
  })
  r = await call(await visitsGet(mkReq('/api/external/v1/patients/visits?clinicCode=TY&from=2026-09-14&to=2026-09-14', { headers: { 'x-api-key': TMP_KEY_PLAINTEXT } })), '403')
  check('D0 scope 未授予（bookings）→ 403', r.status === 403, `status=${r.status}`)
}
{
  // D1：#1 patients/visits
  const r = await call(await visitsGet(mkReq('/api/external/v1/patients/visits?clinicCode=TY&from=2026-09-14&to=2026-09-14')), '#1')
  check('D1 #1 TY 9/14 → 3 行', r.status === 200 && r.body.visits.length === 3, `n=${r.body?.visits?.length}`)
  const byP = new Map(r.body.visits.map((v: any) => [v.patientApricotId, v]))
  check('D1 #1 std 行形狀（phoneHashes/visitDate/clinicCode/bill）', byP.get('cp-std-001')?.phoneHashes?.[0] === H1 && byP.get('cp-std-001')?.visitDate === '2026-09-14' && byP.get('cp-std-001')?.clinicCode === 'TY' && byP.get('cp-std-001')?.billTtlAmt === 800, JSON.stringify(byP.get('cp-std-001')))
  check('D1 #1 tpl 多號 2 hash', byP.get('cp-tpl-002')?.phoneHashes?.length === 2, `n=${byP.get('cp-tpl-002')?.phoneHashes?.length}`)
  piiScan('D1-#1', JSON.stringify(r.body))
  // 過濾
  let f = await call(await visitsGet(mkReq('/api/external/v1/patients/visits?clinicCode=TY&from=2026-09-14&to=2026-09-14&reasonCodes=FILLING')), '#1-filter-reason')
  check('D1 #1 reasonCodes=FILLING → 2 行（std+tpl）', f.body.visits.length === 2, `n=${f.body?.visits?.length}`)
  f = await call(await visitsGet(mkReq('/api/external/v1/patients/visits?clinicCode=TKW&from=2026-09-14&to=2026-09-14&bookingStatus=-3')), '#1-filter-noshow')
  check('D1 #1 🔴 TKW bookingStatus=-3 → 1 行（爽約可查）', f.body.visits.length === 1 && f.body.visits[0].bookingStatus === -3, `n=${f.body?.visits?.length}`)
  f = await call(await visitsGet(mkReq('/api/external/v1/patients/visits?clinicCode=TY&from=2026-01-01&to=2027-01-02')), '#1-badrange')
  check('D1 #1 範圍 > 366 日 → 400', f.status === 400, `status=${f.status}`)
  f = await call(await visitsGet(mkReq('/api/external/v1/patients/visits?clinicCode=NOPE&from=2026-09-14&to=2026-09-14')), '#1-noclinic')
  check('D1 #1 clinic 唔存在 → 404', f.status === 404, `status=${f.status}`)
}
{
  // D2：#2 recall-due
  await prisma.clinicalRecordIndex.create({
    data: {
      id: 'e2erecallx00000000000000001', clinicId: TY, patientApricotId: 'cp-recall-x', patientCode: 'PX0001',
      phoneHashes: phoneHashes('99998888', PHONE_KEY), visitDate: d('2026-02-01'), apricotApptId: 'apt-recall-x',
      bookingStatus: 4, visitReasonCodes: ['FILLING'], providerCode: 'DR1', hasNote: false,
      rxCodes: [], billTtlAmt: 0, billOsAmt: 0, syncedAt: new Date(),
    },
  })
  const r = await call(await recallGet(mkReq('/api/external/v1/patients/recall-due?clinicCode=TY&reasonCode=FILLING&months=6')), '#2')
  const ids = r.body.due.map((x: any) => x.patientApricotId)
  check('D2 #2 due 有 cp-recall-x（2/1 > 6 個月）', r.status === 200 && ids.includes('cp-recall-x'), JSON.stringify(ids))
  check('D2 #2 due 冇 cp-std-001（9/14 唔夠 6 個月）', !ids.includes('cp-std-001'), JSON.stringify(ids))
  const recall = r.body.due.find((x: any) => x.patientApricotId === 'cp-recall-x')
  check('D2 #2 recall 行形狀（lastVisitDate + phoneHashes）', recall.lastVisitDate === '2026-02-01' && recall.phoneHashes.length === 1, JSON.stringify(recall))
  piiScan('D2-#2', JSON.stringify(r.body))
  let f = await call(await recallGet(mkReq('/api/external/v1/patients/recall-due?clinicCode=TY&reasonCode=FILLING&months=0')), '#2-badmonths')
  check('D2 #2 months=0 → 400', f.status === 400, `status=${f.status}`)
  f = await call(await recallGet(mkReq('/api/external/v1/patients/recall-due?clinicCode=TY&reasonCode=FILLING&months=25')), '#2-badmonths2')
  check('D2 #2 months=25 → 400', f.status === 400, `status=${f.status}`)
}
{
  // D3：#3 appointments（clinicCode 新模式 + phoneHash 舊模式保留）
  const now = new Date()
  await prisma.appointmentIndex.createMany({
    data: [
      { id: 'e2eai10000000000000000001', apricotApptId: 'e2e-apt-t1', clinicId: TY, providerApricotId: 'p1', providerName: 'Dr E', date: '2026-09-14', startTime: '10:00', endTime: '10:30', bookingStatus: 4, patientApricotId: 'cp-std-001', patientCode: 'P0001', patientName: '陳大文', phoneHash: H1, visitReasons: ['FILLING'], syncedAt: now },
      { id: 'e2eai20000000000000000002', apricotApptId: 'e2e-apt-t2', clinicId: TY, providerApricotId: 'p2', providerName: 'Dr F', date: '2026-09-14', startTime: '11:00', endTime: '11:30', bookingStatus: 4, patientApricotId: 'cp-unknown-9', patientCode: 'P9999', patientName: '林九', phoneHash: 'f'.repeat(64), visitReasons: [], syncedAt: now },
    ],
  })
  const r = await call(await apptsGet(mkReq('/api/external/v1/appointments?clinicCode=TY&from=2026-09-14&to=2026-09-14')), '#3-clinic')
  check('D3 #3 clinic 模式 → 2 行', r.status === 200 && r.body.appointments.length === 2, `n=${r.body?.appointments?.length}`)
  const a1 = r.body.appointments.find((a: any) => a.patientApricotId === 'cp-std-001')
  const a2 = r.body.appointments.find((a: any) => a.patientApricotId === 'cp-unknown-9')
  check('D3 #3 索引有行 → phoneHashes 由 ClinicalRecordIndex', a1?.phoneHashes?.[0] === H1 && a1.phoneHashes.length === 1, JSON.stringify(a1?.phoneHashes))
  check('D3 #3 索引無行 → fallback [legacy phoneHash]', a2?.phoneHashes?.[0] === 'f'.repeat(64), JSON.stringify(a2?.phoneHashes))
  piiScan('D3-#3', JSON.stringify(r.body), true) // #3 依 P0 合約回 patientName — 掃 core（無姓名）
  // phoneHash 舊模式（形狀保留：無 phoneHashes 欄）
  const r2 = await call(await apptsGet(mkReq(`/api/external/v1/appointments?phoneHash=${H1}&from=2026-09-14&to=2026-09-14`)), '#3-hash')
  const b1 = r2.body.appointments?.[0]
  check('D3 #3 phoneHash 模式照舊（1 行、無 phoneHashes 欄）', r2.status === 200 && r2.body.appointments.length === 1 && b1 && !('phoneHashes' in b1), `n=${r2.body?.appointments?.length}`)
  let f = await call(await apptsGet(mkReq(`/api/external/v1/appointments?phoneHash=${H1}&clinicCode=TY&from=2026-09-14&to=2026-09-14`)), '#3-both')
  check('D3 #3 兩模式同傳 → 400', f.status === 400, `status=${f.status}`)
  f = await call(await apptsGet(mkReq('/api/external/v1/appointments?from=2026-09-14&to=2026-09-14')), '#3-neither')
  check('D3 #3 兩個都無 → 400', f.status === 400, `status=${f.status}`)
  f = await call(await apptsGet(mkReq('/api/external/v1/appointments?clinicCode=TY&from=2026-01-01&to=2026-09-14')), '#3-range')
  check('D3 #3 範圍 > 38 日 → 400', f.status === 400, `status=${f.status}`)
}
{
  // D4：#4 病人記錄側欄（結構化 + firstLine；零全文）
  const r2 = await call(await patientVisitsGet(mkReq('/api/external/v1/patients/cp-std-001/visits'), p({ patientApricotId: 'cp-std-001' })), '#4')
  check('D4 #4 → 1 行（past only；9/22 未來唔喺）', r2.status === 200 && r2.body.visits.length === 1 && r2.body.visits[0].visitDate === '2026-09-14', `n=${r2.body?.visits?.length}`)
  check('D4 #4 firstLine ≤60 字（首行 complaints）', r2.body.visits[0].firstLine === '左上後牙咬痛三星期', JSON.stringify(r2.body.visits[0].firstLine))
  check('D4 #4 🔴 零全文（findings/diagnosis 唔喺回應）', !JSON.stringify(r2.body).includes('Caries #36') && !JSON.stringify(r2.body).includes('Deep caries'), 'no full text')
  check('D4 #4 hasNote/noteKind 結構化', r2.body.visits[0].hasNote === true && r2.body.visits[0].noteKind === 'STANDARD', JSON.stringify({ h: r2.body.visits[0].hasNote }))
  piiScan('D4-#4', JSON.stringify(r2.body))
  const f = await call(await patientVisitsGet(mkReq('/api/external/v1/patients/cp-nobody/visits'), p({ patientApricotId: 'cp-nobody' })), '#4-404')
  check('D4 #4 無索引病人 → 404', f.status === 404, `status=${f.status}`)
}
{
  // D5：#5 臨床全文（100% audit）
  const stdRow = await prisma.clinicalRecordIndex.findFirst({ where: { patientApricotId: 'cp-std-001', visitDate: d('2026-09-14') } })
  const noRow = await prisma.clinicalRecordIndex.findFirst({ where: { patientApricotId: 'cp-no-003', visitDate: d('2026-09-14') } })
  const tplRow = await prisma.clinicalRecordIndex.findFirst({ where: { patientApricotId: 'cp-tpl-002', visitDate: d('2026-09-14') } })
  const auditCount = async () => prisma.auditLog.count({ where: { action: 'EXTERNAL_NOTE_VIEWED' } })
  const before = await auditCount()
  let r = await call(await noteGet(mkReq(`/api/external/v1/patients/cp-std-001/visits/${stdRow!.id}/note`, { headers: { 'x-staff-id': 'e2e-staff-1' } }), p({ patientApricotId: 'cp-std-001', visitId: stdRow!.id })), '#5')
  check('D5 #5 全文 200 + STANDARD 內容', r.status === 200 && r.body.note?.complaints === '左上後牙咬痛三星期' && r.body.noteKind === 'STANDARD', `status=${r.status}`)
  const after1 = await auditCount()
  check('D5 #5 🔴 audit 落咗（+1）', after1 === before + 1, `${before}→${after1}`)
  const audit = await prisma.auditLog.findFirst({ where: { action: 'EXTERNAL_NOTE_VIEWED' }, orderBy: { createdAt: 'desc' } })
  const notesStr = audit!.notes ?? ''
  check('D5 #5 audit 記 staffId + visitId', notesStr.includes('e2e-staff-1') && notesStr.includes(stdRow!.id), notesStr)
  check('D5 #5 🔴 audit 零內容', !notesStr.includes('咬痛') && !notesStr.includes('Caries'), 'no content in audit')
  // 再 call 一次 → 再 audit（100%）
  await call(await noteGet(mkReq(`/api/external/v1/patients/cp-std-001/visits/${stdRow!.id}/note`, { headers: { 'x-staff-id': 'e2e-staff-2' } }), p({ patientApricotId: 'cp-std-001', visitId: stdRow!.id })), '#5-2')
  const after2 = await auditCount()
  check('D5 #5 第二次 call 都 audit（100%）', after2 === after1 + 1, `${after1}→${after2}`)
  // 無 note → 404（唔 audit）
  const f = await call(await noteGet(mkReq(`/api/external/v1/patients/cp-no-003/visits/${noRow!.id}/note`), p({ patientApricotId: 'cp-no-003', visitId: noRow!.id })), '#5-nonote')
  check('D5 #5 無 note → 404 NOTE_NOT_FOUND', f.status === 404 && f.body.code === 'NOTE_NOT_FOUND', `status=${f.status} code=${f.body?.code}`)
  check('D5 #5 404 唔 audit', (await auditCount()) === after2, 'count unchanged')
  // 病人/visit 錯配 → 404
  const g = await call(await noteGet(mkReq(`/api/external/v1/patients/cp-tpl-002/visits/${stdRow!.id}/note`), p({ patientApricotId: 'cp-tpl-002', visitId: stdRow!.id })), '#5-mismatch')
  check('D5 #5 病人錯配 → 404 VISIT_NOT_FOUND', g.status === 404 && g.body.code === 'VISIT_NOT_FOUND', `status=${g.status}`)
  // TEMPLATE 全文（blocks）
  const h = await call(await noteGet(mkReq(`/api/external/v1/patients/cp-tpl-002/visits/${tplRow!.id}/note`), p({ patientApricotId: 'cp-tpl-002', visitId: tplRow!.id })), '#5-tpl')
  check('D5 #5 TEMPLATE 全文（blocks）', h.status === 200 && h.body.note?.kind === 'TEMPLATE' && h.body.note.blocks.length >= 2, `blocks=${h.body?.note?.blocks?.length}`)
}
{
  // D6：#6 balance
  const r = await call(await balanceGet(mkReq('/api/external/v1/patients/cp-std-001/balance'), p({ patientApricotId: 'cp-std-001' })), '#6')
  check('D6 #6 balance 800/300 + asOf', r.status === 200 && r.body.balance?.ttlAmt === 800 && r.body.balance?.osAmt === 300 && r.body.asOf === '2026-09-14', JSON.stringify(r.body))
  const f = await call(await balanceGet(mkReq('/api/external/v1/patients/cp-nobody/balance'), p({ patientApricotId: 'cp-nobody' })), '#6-404')
  check('D6 #6 無行 → 404', f.status === 404, `status=${f.status}`)
}

// ─── E. 手動刷新（S5）────────────────────────────────────────────────
origLog('── E. refresh ──')
{
  resetClinicalRefreshBuckets()
  const mock = buildClinicalMock({ now: NOW1 })
  __setTestCallFn(mock.callFn)
  const audBefore = await prisma.auditLog.count({ where: { action: 'PATIENT_RECORD_REFRESHED' } })
  const r = await call(await refreshPost(mkReq('/api/external/v1/patients/cp-std-001/refresh', { method: 'POST', headers: { 'x-staff-id': 'e2e-staff-1' } }), p({ patientApricotId: 'cp-std-001' })), '#8')
  check('E1 刷新 200 + balance', r.status === 200 && r.body.visits === 1 && r.body.balance?.ttlAmt === 800 && r.body.balance?.osAmt === 300 && r.body.syncedAt, JSON.stringify(r.body))
  check('E1 刷新 3 call（appointments+notes+bills）', mock.callLog.length === 3, `calls=${mock.callLog.length}`)
  const aud = await prisma.auditLog.findFirst({ where: { action: 'PATIENT_RECORD_REFRESHED' }, orderBy: { createdAt: 'desc' } })
  check('E1 audit PATIENT_RECORD_REFRESHED（staffId+cpId+ok）', (await prisma.auditLog.count({ where: { action: 'PATIENT_RECORD_REFRESHED' } })) === audBefore + 1 && aud!.notes!.includes('e2e-staff-1') && aud!.notes!.includes('cp-std-001') && aud!.notes!.includes('"result":"ok"'), aud!.notes ?? '')
  check('E1 audit 零病人內容', !aud!.notes!.includes('P0001'), aud!.notes ?? '')
  // 429：同病人 60 秒內第二次
  const r2 = await call(await refreshPost(mkReq('/api/external/v1/patients/cp-std-001/refresh', { method: 'POST' }), p({ patientApricotId: 'cp-std-001' })), '#8-429')
  check('E2 同病人第二次 → 429 + retryAfterSec', r2.status === 429 && r2.body.retryAfterSec >= 1 && r2.body.retryAfterSec <= 60, JSON.stringify(r2.body))
  // 503：Apricot 斷（failAfterCalls=1）
  resetClinicalRefreshBuckets()
  __setTestCallFn(buildClinicalMock({ now: NOW1, failAfterCalls: 1 }).callFn)
  const audBefore2 = await prisma.auditLog.count({ where: { action: 'PATIENT_RECORD_REFRESHED' } })
  const r3 = await call(await refreshPost(mkReq('/api/external/v1/patients/cp-tpl-002/refresh', { method: 'POST' }), p({ patientApricotId: 'cp-tpl-002' })), '#8-503')
  check('E3 Apricot 斷 → 503 APRICOT_UNAVAILABLE + lastSyncedAt', r3.status === 503 && r3.body.error === 'APRICOT_UNAVAILABLE' && r3.body.lastSyncedAt, JSON.stringify(r3.body))
  const aud2 = await prisma.auditLog.findFirst({ where: { action: 'PATIENT_RECORD_REFRESHED' }, orderBy: { createdAt: 'desc' } })
  check('E3 503 都 audit（result=apricot_unavailable）', (await prisma.auditLog.count({ where: { action: 'PATIENT_RECORD_REFRESHED' } })) === audBefore2 + 1 && aud2!.notes!.includes('apricot_unavailable'), aud2!.notes ?? '')
  __setTestCallFn(null)
}

// ─── F. 總體零 PII 掃描 + 零殘留 ──────────────────────────────────────
origLog('── F. 總體掃描 + cleanup ──')
{
  const allDump = allBodies.join('\n')
  // #3 依 P0 合約回 patientName（白名單欄位）→ 總體掃 core（phone + 醫療/地址/HKID，零容忍）
  piiScan('F-all-responses', allDump, true)
  const logDump = captured.join('\n')
  piiScan('F-logs', logDump)

  await prisma.clinicalRecordIndex.deleteMany({ where: { patientApricotId: { in: FIX_PATIENTS } } })
  await prisma.clinicalIndexJob.deleteMany({ where: { kind: { in: ['NIGHTLY', 'BACKFILL'] } } })
  // AuditLog append-only — 唔清理（e2e 行留低係正常審計痕跡，零病人內容）
  await prisma.appointmentIndex.deleteMany({ where: { apricotApptId: { in: ['e2e-apt-t1', 'e2e-apt-t2'] } } })
  await prisma.externalApiKey.deleteMany({ where: { id: TMP_KEY_ID } })
  for (const c of savedClinics) await prisma.clinic.update({ where: { id: c.id }, data: { apricotClinicId: c.apricotClinicId } })
  if (savedScopes) await prisma.externalApiKey.update({ where: { id: DEV_KEY_ID }, data: { scopes: savedScopes } })
  __setTestCallFn(null)

  const left1 = await prisma.clinicalRecordIndex.count({ where: { patientApricotId: { in: FIX_PATIENTS } } })
  const left2 = await prisma.clinicalIndexJob.count({ where: { kind: { in: ['NIGHTLY', 'BACKFILL'] } } })
  const left3 = await prisma.appointmentIndex.count({ where: { apricotApptId: { in: ['e2e-apt-t1', 'e2e-apt-t2'] } } })
  check('F 零殘留（audit 除外 — append-only 設計）', left1 + left2 + left3 === 0, `cri=${left1} job=${left2} ai=${left3}`)
}

origLog(`\n══ 結果：PASS=${pass} FAIL=${fail} ══`)
if (failures.length) {
  origLog('失敗項：')
  for (const f of failures) origLog(`  - ${f}`)
}
await prisma.$disconnect()
process.exit(fail ? 1 : 0)
}

main().catch((e) => { origLog('FATAL', e); process.exit(1) })
