#!/usr/bin/env node
/**
 * cwm-earlyin-20260831 — E2E Kathy-Replica synthetic fixture seed（零 PII，全合成）
 *
 * 數字照 MD §0（Kathy 2026-08 HK 實測 replica）：
 *   TimeBankEntry: INIT_ADJUST +1878 / RESTDAY_GRANT +14400（2026-07-31T16:00Z = HK 8/1 00:00）
 *                  / MAKEUP −400（7 筆，全 targetType LATE）/ EARLY_IN_OT +77（HK 8/7）
 *   TimeBank 快照: July balance 0 / August balance 2316（舊版本 → v6 重算要出 2445）
 *   shifts/punches 設計（逐分鐘可控）：
 *     收工 OT = 28 日×24 + 2 日×7 = 686；午飯 OT = 6 日×30 + 1 日×26 = 206 → otMinutes 892
 *     08-07：收工 24 + 午飯 30 + EARLY_IN_OT 77（同 merge 測試行）
 *     08-10：17:58 收工（shift 18:00 止）→ netEarly 2（配 makeup 400 → netOtThisMonth 567）
 *     8 月 balance = 0 + 567 + 1878 = 2445
 *     roster: 30 日 08:30–18:15（淨 525）+ 08-10 08:30–18:00（淨 510）= 16260
 *             expected = 31×540 = 16740 → diffMinutes −480
 *
 * 慣例（同 app 一致）：Shift.date/startTime/endTime = HK wall-clock（naive）；
 * PunchRecord.punchTime = UTC wall-clock（naive，app 寫 new Date() → Prisma 存 UTC wall-clock）；
 * TimeBankEntry.date = UTC wall-clock；TimeBank.periodMonth = 月初 HK 00:00（= 上月末 16:00Z）。
 *
 * 冪等：全部固定前綴 id + ON CONFLICT DO UPDATE。sweep：LIKE 'e2ekathy%'。
 * user role = MANAGER（同一個 user 同時做員工端 dashboard + manager 端 payroll/overview 驗收）。
 * 含 9 月 30 個 shift（無 punch）— 令 live「本月預測」直式有 roster diff 可顯示。
 */
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1) }

const ID = {
  user: 'e2ekathyuser202608310001',
  clinic: 'e2ekathyclinic20260831001',
  employee: 'e2ekathyemp202608310001',
  payRule: 'e2ekathyrule202608310001',
}
const NAME = 'E2E Kathy-Replica'
const PHONE = '89990001'

const client = new pg.Client({ connectionString: DATABASE_URL })
await client.connect()

const upsertSql = (table, cols, idCol = 'id') => {
  const updateCols = cols.filter(c => c !== idCol)
  const set = updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')
  const ph = cols.map((_, i) => `$${i + 1}`).join(',')
  return `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')})
          VALUES (${ph})
          ON CONFLICT (${idCol}) DO UPDATE SET ${set}`
}
const run = async (table, cols, vals, idCol = 'id') =>
  client.query(upsertSql(table, cols, idCol), vals)

await client.query('BEGIN')

// ── Clinic ─────────────────────────────────────────────────────────
await run('Clinic', ['id', 'name', 'shortName', 'createdAt', 'updatedAt'],
  [ID.clinic, `${NAME} Clinic`, 'E2E', '2026-07-01 00:00:00', '2026-07-01 00:00:00'])

// ── User ───────────────────────────────────────────────────────────
await run('User', ['id', 'name', 'phone', 'password', 'role', 'status', 'tokenVersion', 'createdAt', 'updatedAt'],
  [ID.user, NAME, PHONE, 'e2e-placeholder-not-used', 'MANAGER', 'ACTIVE', 0, '2026-07-01 00:00:00', '2026-07-01 00:00:00'])

// ── UserClinic / Employee / EmployeeClinic ─────────────────────────
await run('UserClinic', ['id', 'userId', 'clinicId', 'isPrimary', 'createdAt'],
  ['e2ekathyuc202608310000001', ID.user, ID.clinic, true, '2026-07-01 00:00:00'])

await run('Employee', ['id', 'userId', 'homeClinicId', 'joinDate', 'status', 'payConfidential', 'createdAt', 'updatedAt'],
  [ID.employee, ID.user, ID.clinic, '2026-07-01 00:00:00', 'ACTIVE', false, '2026-07-01 00:00:00', '2026-07-01 00:00:00'])

await run('EmployeeClinic', ['id', 'employeeId', 'clinicId', 'isPrimary', 'joinedAt'],
  ['e2ekathyec202608310000001', ID.employee, ID.clinic, true, '2026-07-01 00:00:00'])

// ── PayRule（MONTHLY；OT 門檻 0 / 午飯 60min 門檻 30）─────────────
const configJson = JSON.stringify({
  monthly_salary: 18000,
  ot_threshold: 0, // 0 = 純時間銀行（OT 全入 timebank，唔有現金 OT pay）
  ot_multiplier: 1.5,
  modifiers: {
    overtime: { ot_min_minutes: 0, ot_round_minutes: 0 },
    lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 },
  },
  negative_carry: 'next_month',
})
await run('PayRule', ['id', 'employeeId', 'payType', 'baseAmount', 'configJson', 'effectiveFrom', 'isActive', 'createdBy', 'createdAt', 'updatedAt'],
  [ID.payRule, ID.employee, 'MONTHLY', 18000, configJson, '2026-07-01 00:00:00', true, ID.user, '2026-07-01 00:00:00', '2026-07-01 00:00:00'])

// ── Shifts（31 日）＋ Punches ──────────────────────────────────────
// 收工 OT：08-01/08-02 = 7min；其餘 28 日（除 08-10）= 24min → Σ686
// 午飯 OT：08-07/08/12/15/19/23 = 30min；08-27 = 26min → Σ206
// 08-10：17:58 收工（早退 2）
const LUNCH_OT_30 = new Set([7, 8, 12, 15, 19, 23])
const LUNCH_OT_26 = 27

const shifts = []
const punches = []
for (let d = 1; d <= 31; d++) {
  const ds = String(d).padStart(2, '0')
  const date = `2026-08-${ds}`
  // ★ shift 三欄 = UTC wall-clock（同 app 一致：buildShiftTimes 建 real instant → Prisma 存 UTC wall-clock）
  //   date = HK 午夜 instant = (d-1) 日 16:00Z；start 08:30 HK = 00:30Z 同日；end 18:15 HK = 10:15Z 同日
  const shiftDateUTC = d === 1 ? '2026-07-31 16:00:00' : `2026-08-${String(d - 1).padStart(2, '0')} 16:00:00`
  const endUtc = d === 10 ? `2026-08-${ds} 10:00:00` : `2026-08-${ds} 10:15:00`
  shifts.push([`e2ekathyshf20260831${ds}`, ID.employee, ID.clinic, shiftDateUTC, `${date} 00:30:00`, endUtc, 'CONFIRMED', ID.user, '2026-07-15 00:00:00', '2026-07-15 00:00:00'])

  // punch = UTC wall-clock = HK − 8h（全部 punch 喺 08:00 HK 之後 → UTC 同一日）
  const inUtc = `${date} 00:30:00` // 08:30 HK
  let outUtc
  if (d === 10) {
    outUtc = `${date} 09:58:00` // 17:58 HK → 早退 2（shift 止 18:00 HK）
  } else if (d === 1 || d === 2) {
    outUtc = `${date} 10:22:00` // 18:22 HK = 18:15+7
  } else {
    outUtc = `${date} 10:39:00` // 18:39 HK = 18:15+24
  }
  punches.push([`e2ekathyinc20260831${ds}`, ID.employee, ID.clinic, inUtc, 'CLOCK_IN', 'SYSTEM', '2026-08-31 00:00:00'])
  punches.push([`e2ekathyout20260831${ds}`, ID.employee, ID.clinic, outUtc, 'CLOCK_OUT', 'SYSTEM', '2026-08-31 00:00:00'])
  if (LUNCH_OT_30.has(d) || d === LUNCH_OT_26) {
    const endL = d === LUNCH_OT_26 ? '04:34:00' : '04:30:00' // 12:34 / 12:30 HK
    punches.push([`e2ekathylns20260831${ds}`, ID.employee, ID.clinic, `${date} 04:00:00`, 'LUNCH_START', 'SYSTEM', '2026-08-31 00:00:00'])
    punches.push([`e2ekathylnE20260831${ds}`, ID.employee, ID.clinic, `${date} ${endL}`, 'LUNCH_END', 'SYSTEM', '2026-08-31 00:00:00'])
  }
}

for (const s of shifts) {
  await run('Shift', ['id', 'employeeId', 'clinicId', 'date', 'startTime', 'endTime', 'status', 'createdBy', 'createdAt', 'updatedAt'], s)
}
for (const p of punches) {
  await run('PunchRecord', ['id', 'employeeId', 'clinicId', 'punchTime', 'punchType', 'source', 'createdAt'], p)
}

// ── TimeBankEntry（10 筆，date = UTC wall-clock）──────────────────
const tbe = [
  ['e2ekathytb01', 'INIT_ADJUST', 1878, '2026-07-31 16:00:00', null, 'E2E replica: 初始調整（照 MD §0）'],
  ['e2ekathytb02', 'RESTDAY_GRANT', 14400, '2026-07-31 16:00:00', null, 'E2E replica: 休息日發放（唔計 convertedMinutes）'],
  ['e2ekathytb03', 'EARLY_IN_OT', 77, '2026-08-06 16:00:00', null, 'E2E replica: 早返 OT（HK 08-07）'],
  ['e2ekathytb04', 'MAKEUP', -100, '2026-08-04 16:00:00', 'LATE', 'E2E replica makeup 1/7'],
  ['e2ekathytb05', 'MAKEUP', -70, '2026-08-06 16:00:00', 'LATE', 'E2E replica makeup 2/7'],
  ['e2ekathytb06', 'MAKEUP', -60, '2026-08-09 16:00:00', 'LATE', 'E2E replica makeup 3/7'],
  ['e2ekathytb07', 'MAKEUP', -50, '2026-08-11 16:00:00', 'LATE', 'E2E replica makeup 4/7'],
  ['e2ekathytb08', 'MAKEUP', -50, '2026-08-16 16:00:00', 'LATE', 'E2E replica makeup 5/7'],
  ['e2ekathytb09', 'MAKEUP', -40, '2026-08-18 16:00:00', 'LATE', 'E2E replica makeup 6/7'],
  ['e2ekathytb10', 'MAKEUP', -30, '2026-08-20 16:00:00', 'LATE', 'E2E replica makeup 7/7'],
]
for (const [id, type, minutes, date, targetType, note] of tbe) {
  await run('TimeBankEntry', ['id', 'employeeId', 'date', 'type', 'minutes', 'note', 'targetType', 'createdBy', 'createdAt'],
    [id, ID.employee, date, type, minutes, note, targetType, ID.user, '2026-08-31 00:00:00'])
}

// ── TimeBank 快照（舊版本 balance，cacheKey NULL → v6 會重算）──────
const tbSnap = [
  ['e2ekathytbj20260831000001', '2026-06-30 16:00:00', 0, 0, '2026-07-15 00:00:00'],
  ['e2ekathytba20260831000001', '2026-07-31 16:00:00', 2316, 0, '2026-08-31 00:00:00'],
]
for (const [id, periodMonth, balance, carriedFrom, updatedAt] of tbSnap) {
  await run('TimeBank', ['id', 'employeeId', 'periodMonth', 'otMinutes', 'lateMinutes', 'earlyLeaveMinutes', 'makeupMinutes', 'balance', 'carriedFrom', 'cacheKey', 'updatedAt'],
    [id, ID.employee, periodMonth, 0, 0, 0, 0, balance, carriedFrom, null, updatedAt])
}

// ── 9 月 shifts（30 日，無 punch）— 本月預測 demo ───────────────────────
// 同 8 月 pattern：30 日 08:30–18:15（淨 525），9-10 08:30–18:00（淨 510）
for (let d = 1; d <= 30; d++) {
  const ds = String(d).padStart(2, '0')
  const date = `2026-09-${ds}`
  const shiftDateUTC = d === 1 ? '2026-08-31 16:00:00' : `2026-09-${String(d - 1).padStart(2, '0')} 16:00:00`
  const endUtc = d === 10 ? `2026-09-${ds} 10:00:00` : `2026-09-${ds} 10:15:00`
  await run('Shift', ['id', 'employeeId', 'clinicId', 'date', 'startTime', 'endTime', 'status', 'createdBy', 'createdAt', 'updatedAt'],
    [`e2ekathyshf202609${ds}`, ID.employee, ID.clinic, shiftDateUTC, `${date} 00:30:00`, endUtc, 'CONFIRMED', ID.user, '2026-09-01 00:00:00', '2026-09-01 00:00:00'])
}

await client.query('COMMIT')

// ── 驗證 ───────────────────────────────────────────────────────────
const v1 = await client.query(`SELECT count(*)::int n FROM "Shift" WHERE "employeeId" = $1`, [ID.employee])
const v2 = await client.query(`SELECT count(*)::int n FROM "PunchRecord" WHERE "employeeId" = $1`, [ID.employee])
const v3 = await client.query(`SELECT type, sum("minutes") s, count(*) n FROM "TimeBankEntry" WHERE "employeeId" = $1 GROUP BY 1 ORDER BY 1`, [ID.employee])
const v4 = await client.query(`SELECT "periodMonth"::date d, "balance", "carriedFrom", "cacheKey" IS NULL nokey FROM "TimeBank" WHERE "employeeId" = $1 ORDER BY 1`, [ID.employee])
const v5 = await client.query(`SELECT "punchType", count(*) n FROM "PunchRecord" WHERE "employeeId" = $1 GROUP BY 1 ORDER BY 1`, [ID.employee])
console.log(JSON.stringify({
  shifts: v1.rows[0].n,
  punches: v2.rows[0].n,
  punchTypes: v5.rows,
  entries: v3.rows,
  snapshots: v4.rows,
}, null, 2))
console.log('SEED_OK', JSON.stringify(ID), 'name=', NAME)
await client.end()
