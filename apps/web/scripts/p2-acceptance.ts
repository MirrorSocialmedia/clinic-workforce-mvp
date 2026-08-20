/**
 * ★ cw-pa P2 驗收矩陣（P3/P4 回归用 — commit 保留）。
 * 離線驗 sync 引擎 vs mock Apricot API（testdata/mock-apricot.ts）。
 *
 * 前置：dev DB 已 seed base（6 間 syn 診所 + 6 已知 provider）：
 *   npx tsx scripts/seed-dev-availability.ts base
 *
 * 跑法: cd apps/web && set -a && . ./.env.development && set +a && npx tsx scripts/p2-acceptance.ts
 *
 * 跑完自清理：刪晒 syn-* rows（dev DB 還原乾淨；seed 腳本可隨時重 seed）。
 * 預期：PASS=33 FAIL=0。
 */
import { PrismaClient } from '@prisma/client'
import { runAvailabilitySync, syncAvailability } from '../src/lib/apricot/sync-availability'
import { mockCall, addDays } from '../testdata/mock-apricot'

const prisma = new PrismaClient()
const SYN = 'syn-clinic'
const LOCK_KEY = 776001

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

async function totals() {
  const [avail, book] = await Promise.all([
    prisma.providerAvailability.count(),
    prisma.providerBooking.count(),
  ])
  return { avail, book }
}
async function perClinic() {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT c.name,
        (SELECT count(*)::int FROM "ProviderAvailability" a WHERE a."clinicId" = c.id) AS avail,
        (SELECT count(*)::int FROM "ProviderBooking" b WHERE b."clinicId" = c.id) AS book
     FROM "Clinic" c WHERE c.id LIKE 'syn-clinic%' ORDER BY c.name`
  )
  return rows
}

// ─── PII 欄位檢查 ─────────────────────────────────────────────────────
const EXPECT_AVAIL_COLS = ['id', 'clinicId', 'providerId', 'date', 'startTime', 'endTime', 'syncedAt']
const EXPECT_BOOK_COLS = ['id', 'clinicId', 'providerId', 'date', 'startMin', 'endMin', 'status', 'syncedAt']
const PII_MARKERS = ['A123456(7)', '陳大文', '91234567', 'after mos & implant pain', 'PAIN', 'Chan Tai Man', 'high blood', '高血壓', 'JOAN NURSE', 'APT0']

async function piiColumnCheck() {
  const aRows: any[] = await prisma.$queryRawUnsafe(`SELECT * FROM "ProviderAvailability" LIMIT 20`)
  const bRows: any[] = await prisma.$queryRawUnsafe(`SELECT * FROM "ProviderBooking" LIMIT 20`)
  const aCols = aRows.length ? Object.keys(aRows[0]).sort() : []
  const bCols = bRows.length ? Object.keys(bRows[0]).sort() : []
  check('PII-avail-cols', JSON.stringify(aCols) === JSON.stringify([...EXPECT_AVAIL_COLS].sort()), `cols=${aCols.join(',')}`)
  check('PII-book-cols', JSON.stringify(bCols) === JSON.stringify([...EXPECT_BOOK_COLS].sort()), `cols=${bCols.join(',')}`)
}
function piiLogCheck(stage: string) {
  const hit = PII_MARKERS.filter((m) => captured.some((l) => l.includes(m)))
  check(`PII-log-${stage}`, hit.length === 0, hit.length ? `LEAKED: ${hit.join('|')}` : 'no PII marker in captured console output')
}

// ─── hard timeout ──────────────────────────────────────────────────────
setTimeout(() => { console.error('TIMEOUT 4min — 強制結束'); process.exit(2) }, 4 * 60 * 1000).unref()

const today = (() => { const d = new Date(Date.now() + 8 * 3600 * 1000); return d.toISOString().slice(0, 10) })()
const d2 = addDays(today, 2)

async function main() {
  console.log(`\n========== RUN A（6 已知 provider，LAU/YEUNG/MF Clinic = unknown）==========`)
  const ctxA: any = { calledClinics: [] }
  const resA = await runAvailabilitySync({ callFn: (p: string) => mockCall(p, ctxA) })
  check('A-shape', resA.ok === true, `ok=true start=${resA.ok && resA.start} end=${resA.ok && resA.end}`)
  if (resA.ok) {
    check('#5-skippedClinics', resA.skippedClinics === 1, `skippedClinics=${resA.skippedClinics}（青衣）`)
    check('#5-five-results', resA.results.length === 5, `results=${resA.results.length}`)
    const withRows = resA.results.filter((r: any) => !('error' in r) && r.open > 0).length
    check('#5-five-clinics-rows', withRows === 5, `有 row 嘅 clinic=${withRows}/5`)
    check('#5-all-unknown-3', resA.results.every((r: any) => !('error' in r) && r.unknown === 3),
      JSON.stringify(resA.results.map((r: any) => [r.clinic, r.unknown])))
  }
  check('#5-tsingyi-never-called', ctxA.calledClinics.every((c: string) => c !== null) && new Set(ctxA.calledClinics).size === 5,
    `calledClinicIds=${JSON.stringify([...new Set(ctxA.calledClinics)])}（5 間各一次，青衣無 id）`)

  const tA1 = await totals()
  const pcA1 = await perClinic()
  const tsingyiRow = pcA1.find((r: any) => r.name === '青衣診所')
  check('#5-db-per-clinic', pcA1.filter((r: any) => r.name !== '青衣診所').every((r: any) => r.avail === 22 && r.book === 6) && tsingyiRow.avail === 0 && tsingyiRow.book === 0,
    JSON.stringify(pcA1) + ` totals=${JSON.stringify(tA1)}（預期 22/6 ×5 → 110/30）`)

  // #8 unknown warning 內容
  const warnLine = captured.find((l) => l.includes('未對應 Provider')) ?? ''
  check('#8-warning-LAU', warnLine.includes('695e6e511e430c48022a7690:LAU×7'), warnLine.slice(0, 220))
  check('#8-warning-YEUNG', warnLine.includes('695ff0c999883d05d0582402:YEUNG×2'), '(同上 line)')
  check('#8-warning-MF', warnLine.includes('696604810fb31f000937a8c4:002×7'), '(同上 line)')

  // #6 連續兩次
  await runAvailabilitySync({ callFn: (p: string) => mockCall(p, ctxA) })
  const tA2 = await totals()
  check('#6-no-doubling', tA2.avail === tA1.avail && tA2.book === tA1.book, `1st=${JSON.stringify(tA1)} 2nd=${JSON.stringify(tA2)}`)

  // #7 只 sync 一間（旺角）→ 其餘唔變
  const pcBefore = await perClinic()
  await syncAvailability({ id: 'syn-clinic-wong', name: '旺角診所', apricotClinicId: 'syn-clinic-001' }, (p: string) => mockCall(p, ctxA))
  const pcAfter = await perClinic()
  const wongB = pcBefore.find((r: any) => r.name === '旺角診所')!
  const wongA = pcAfter.find((r: any) => r.name === '旺角診所')!
  const othersSame = pcBefore.filter((r: any) => r.name !== '旺角診所')
    .every((r: any, i: number) => {
      const o = pcAfter.filter((x: any) => x.name !== '旺角診所')[i]
      return o.avail === r.avail && o.book === r.book
    })
  check('#7-single-clinic', wongA.avail === wongB.avail && wongA.book === wongB.book && othersSame,
    `旺角 ${wongB.avail}/${wongB.book} → ${wongA.avail}/${wongA.book}；其餘四間 unchanged=${othersSame}`)

  // #17 一間失敗其餘照做（銅鑼灣 mock 500）
  const pcF17 = await perClinic()
  const ctxF17: any = { calledClinics: [], failClinic: 'syn-clinic-003', failMessage: 'APRICOT_HTTP_500: mock injected failure' }
  const resF17 = await runAvailabilitySync({ callFn: (p: string) => mockCall(p, ctxF17) })
  if (resF17.ok) {
    const err = resF17.results.find((r: any) => 'error' in r)
    const okCount = resF17.results.filter((r: any) => !('error' in r)).length
    check('#17-one-fails-rest-ok', !!err && 'error' in err && err.clinic === '銅鑼灣診所' && okCount === 4,
      `error=${err && 'error' in err ? err.error.slice(0, 60) : 'none'} okClinics=${okCount}/5`)
  } else {
    check('#17-one-fails-rest-ok', false, `unexpected skipped: ${resF17.skipped}`)
  }
  const pcF17b = await perClinic()
  check('#17-db-untouched', pcF17.every((r: any, i: number) => pcF17b[i].avail === r.avail && pcF17b[i].book === r.book),
    '失敗 clinic 及其餘 clinic rows 全部 unchanged')

  // #18c 攞唔到 lock → skipped 唔 crash
  const lockPrisma = new PrismaClient()
  const [{ locked }] = await lockPrisma.$queryRawUnsafe<{ locked: boolean }[]>(
    `SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`
  )
  try {
    check('#18c-lock-held', locked === true, 'second connection holds advisory lock')
    const res18c = await runAvailabilitySync({ callFn: (p: string) => mockCall(p, ctxA) })
    check('#18c-skipped-no-crash', res18c.ok === false && res18c.skipped === 'another apricot call in progress',
      JSON.stringify(res18c))
  } finally {
    await lockPrisma.$queryRawUnsafe(`SELECT pg_advisory_unlock(${LOCK_KEY})`)
    await lockPrisma.$disconnect()
  }

  await piiColumnCheck()
  piiLogCheck('runA')

  // ═══════════════ RUN B（+LAU provider：補 apricotId 場景）═══════════════
  console.log(`\n========== RUN B（+LAU provider → 驗 #10/#12/#13/#15/#16）==========`)
  await prisma.provider.upsert({
    where: { id: 'syn-prov-lau' },
    update: {},
    create: { id: 'syn-prov-lau', name: 'Dr. Lau', shortName: 'LAU', apricotId: '695e6e511e430c48022a7690', color: '#00bcd4', isActive: true, sortOrder: 9 },
  })
  const ctxB: any = { calledClinics: [] }
  const resB = await runAvailabilitySync({ callFn: (p: string) => mockCall(p, ctxB) })
  if (resB.ok) {
    check('B-per-clinic', resB.results.every((r: any) => !('error' in r) && r.open === 29 && r.bookings === 13 && r.unknown === 2),
      JSON.stringify(resB.results.map((r: any) => [r.clinic, r.open, r.bookings, r.unknown])))
    check('#8-warning-runB-2unknown', resB.results.every((r: any) => !('error' in r) && r.unknown === 2), 'unknown = YEUNG + MF Clinic only')
  } else {
    check('B-per-clinic', false, `skipped: ${resB.skipped}`)
  }

  const tB = await totals()
  check('B-totals', tB.avail === 145 && tB.book === 65, `totals=${JSON.stringify(tB)}（預期 145/65）`)

  // #10 LAU 第一筆 570/600
  const lau570: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "ProviderBooking" b JOIN "Provider" p ON p.id = b."providerId"
     WHERE p."apricotId" = '695e6e511e430c48022a7690' AND b.date = $1 AND b."startMin" = 570 AND b."endMin" = 600`, today
  )
  check('#10-lau-first-570-600', lau570[0].n === 5, `rows(570-600 on ${today})=${lau570[0].n}（5 間各 1 筆）— 註：window 已唔包含 8/19，改驗今日同型斷言`)

  // #12 重疊 4 筆
  const lauOverlap: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "ProviderBooking" b JOIN "Provider" p ON p.id = b."providerId"
     WHERE p."apricotId" = '695e6e511e430c48022a7690' AND b.date = $1 AND b."startMin" = 675 AND b."endMin" = 705`, today
  )
  check('#12-overlap-4-rows', lauOverlap[0].n === 20, `rows(675-705 on ${today})=${lauOverlap[0].n}（4 筆 × 5 間，獨立 row 無 dedupe）`)

  // #13 TONG day0 零行
  const tongDay0: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "ProviderBooking" b JOIN "Provider" p ON p.id = b."providerId"
     WHERE p."apricotId" = '695ff0c999883d05d0582401' AND b.date = $1`, today
  )
  check('#13-tong-zero-day0', tongDay0[0].n === 0, `TONG bookings on ${today}=${tongDay0[0].n}（跨日筆已排除）`)

  // #9 2000 → 20:00
  const ho20: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "ProviderAvailability" a JOIN "Provider" p ON p.id = a."providerId"
     WHERE p."apricotId" = '69a000000000000000000001' AND a.date = $1 AND a."startTime" = '20:00' AND a."endTime" = '22:00'`, today
  )
  check('#9-hhmm-2000', ho20[0].n === 5, `HO 20:00-22:00 slots=${ho20[0].n}（5 間各 1）`)

  // #15 isRemoved 唔入庫
  const lauDay0All: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "ProviderBooking" b JOIN "Provider" p ON p.id = b."providerId"
     WHERE p."apricotId" = '695e6e511e430c48022a7690' AND b.date = $1`, today
  )
  check('#15-isremoved-excluded', lauDay0All[0].n === 30, `LAU day0 total=${lauDay0All[0].n}（6 筆/間 × 5；mock 送 7 筆/間含 1 isRemoved）`)

  // #16 status 分布
  const st: any[] = await prisma.$queryRawUnsafe(`SELECT "status", count(*)::int AS n FROM "ProviderBooking" GROUP BY "status" ORDER BY "status"`)
  const stMap = Object.fromEntries(st.map((r: any) => [String(r.status), Number(r.n)]))
  check('#16-status-dist', stMap['0'] === 50 && stMap['4'] === 15, `distribution=${JSON.stringify(stMap)}（預期 0×50, 4×15 — 有值唔係 -1）`)

  // 跨日遲夜筆入庫（TONG d2 00:30-01:00）
  const tongLate: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "ProviderBooking" b JOIN "Provider" p ON p.id = b."providerId"
     WHERE p."apricotId" = '695ff0c999883d05d0582401' AND b.date = $1 AND b."startMin" = 30 AND b."endMin" = 60`, d2
  )
  check('#14b-latehk-kept', tongLate[0].n === 5, `TONG ${d2} 00:30-01:00 rows=${tongLate[0].n}（UTC 落前一日但 HK 日對）`)

  // 全部 date 喺窗口內（meta key 已 filter）
  const dates: any[] = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT date FROM "ProviderBooking" UNION SELECT DISTINCT date FROM "ProviderAvailability"`
  )
  const inWindow = dates.every((r: any) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date >= today && r.date <= addDays(today, 6))
  check('window-dates-only', inWindow, `distinctDates=${dates.length}（預期 7，全部喺 ${today}..${addDays(today, 6)}）`)

  await piiColumnCheck()
  piiLogCheck('runB')

  // ─── 總結 + 清理 ───────────────────────────────────────────────────
  console.log(`\n========== SUMMARY ==========`)
  console.log(`PASS=${pass} FAIL=${fail}`)
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  -', f)) }

  // 清理：還原 dev DB（P3 接手時乾淨）
  await prisma.providerBooking.deleteMany({ where: { clinicId: { startsWith: SYN } } })
  await prisma.providerAvailability.deleteMany({ where: { clinicId: { startsWith: SYN } } })
  await prisma.clinic.deleteMany({ where: { id: { startsWith: SYN } } })
  await prisma.provider.deleteMany({ where: { id: { startsWith: 'syn-prov' } } })
  const tClean = await totals()
  console.log(`cleanup done, remaining rows: ${JSON.stringify(tClean)}`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
