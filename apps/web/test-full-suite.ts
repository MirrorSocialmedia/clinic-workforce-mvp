/**
 * ═══════════════════════════════════════════════════════════════
 *  全場景測試套件 test-full-suite.ts
 *  覆蓋 14 個場景，每個自動斷言，最後印總表。
 *
 *  用法（在 apps/web 下）：
 *    DATABASE_URL="postgresql://clinic:devpass@localhost:5432/clinic_test" npx tsx test-full-suite.ts
 *
 *  依賴：clinic_test 已 migrate、有至少一間診所。
 *  測試員工 TESTSUITE（獨立於 TEST0001，不互相污染）。
 *  每個場景先清空該員工全部資料 → 建場景 → 跑引擎 → 斷言。
 * ═══════════════════════════════════════════════════════════════
 */
import { PrismaClient } from '@prisma/client'
import { calculatePayrollWithRules } from './src/lib/payroll-engine'

const prisma = new PrismaClient()
const JULY = new Date('2026-07-01T00:00:00+08:00')
const JUNE = new Date('2026-06-01T00:00:00+08:00')

// ────────────────── 共用 harness ──────────────────
let empId = '', userId = '', clinicId = ''
const results: Array<{ id: string; name: string; pass: boolean; detail: string }> = []

function dt(date: string, time: string) { return new Date(`${date}T${time}:00+08:00`) }

async function setup() {
  const clinic = await prisma.clinic.findFirst()
  if (!clinic) throw new Error('沒有診所，先跑 seed')
  clinicId = clinic.id
  let user = await prisma.user.findFirst({ where: { phone: 'TESTSUITE' } })
  if (!user) user = await prisma.user.create({ data: { name: '套件測試員', phone: 'TESTSUITE', password: 'x', role: 'EMPLOYEE' } })
  userId = user.id
  let emp = await prisma.employee.findFirst({ where: { userId } })
  if (!emp) emp = await prisma.employee.create({ data: { userId, joinDate: new Date('2025-01-01') } })
  empId = emp.id
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: empId, clinicId } },
    update: {}, create: { employeeId: empId, clinicId } }).catch(() => {})
  // 系統假期類型
  for (const t of [
    { systemKey: 'REST_DAY', name: '休息日', isPaid: true, color: '#4a4a4a' },
    { systemKey: 'ANNUAL_LEAVE', name: '年假', isPaid: true, color: '#27ae60' },
    { systemKey: 'OT_LEAVE', name: 'OT補假', isPaid: true, color: '#8e44ad' },
  ]) {
    const ex = await prisma.leaveType.findUnique({ where: { systemKey: t.systemKey } }).catch(() => null)
    if (!ex) await prisma.leaveType.create({ data: t as any })
  }
}

async function clean() {
  await prisma.payrollItem.deleteMany({ where: { employeeId: empId } })
  await prisma.punchVoid.deleteMany({ where: { punchRecord: { employeeId: empId } } }).catch(() => {})
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: empId } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: empId } }).catch(() => {})
  await prisma.leaveBalance.deleteMany({ where: { employeeId: empId } })
  await prisma.leaveRequest.deleteMany({ where: { employeeId: empId } })
  await prisma.punchCorrection.deleteMany({ where: { employeeId: empId } }).catch(() => {})
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: empId } })
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})
  await prisma.shift.deleteMany({ where: { employeeId: empId } })
  await prisma.payRule.deleteMany({ where: { employeeId: empId } })
}

async function shift(date: string, s = '09:00', e = '18:00') {
  return prisma.shift.create({ data: { employeeId: empId, clinicId,
    date: dt(date, '00:00'), startTime: dt(date, s), endTime: dt(date, e),
    status: 'CONFIRMED', createdBy: userId } })
}
async function punch(date: string, type: 'CLOCK_IN' | 'CLOCK_OUT', time: string) {
  return prisma.punchRecord.create({ data: { employeeId: empId, clinicId,
    punchTime: dt(date, time), punchType: type, source: 'QR_DYNAMIC', tokenValid: true } })
}
async function makeup(date: string, minutes: number, targetType: 'LATE' | 'EARLY_LEAVE') {
  return prisma.timeBankEntry.create({ data: { employeeId: empId, type: 'MAKEUP', targetType,
    date: dt(date, '12:00'), minutes: -Math.abs(minutes),
    note: `補鐘：${targetType === 'LATE' ? '遲到' : '早退'} ${minutes}分` } })
}

const MONTHLY_CFG = (salary = 15000) => ({
  base_type: 'monthly', monthly_salary: salary,
  modifiers: {
    attendance_bonus: { amount: 500, cancel_if: {
      late_minutes_exceed: 30, late_is_cumulative: true, any_unplanned_leave: true, any_absence: true } },
    overtime: { mode: 'time_off', hours_per_leave_day: 9 },
    working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
    deduction: { basis: 'statutory' },
    mpf: { enabled: false },
  },
})

async function run(month = JULY, cfg: any = MONTHLY_CFG()) {
  return calculatePayrollWithRules(empId, month, clinicId, cfg)
}
function tb(r: any) { return r?.detail?.timebank || {} }

function assert(id: string, name: string, checks: Array<[string, any, any]>) {
  const fails = checks.filter(([, got, want]) =>
    typeof want === 'number' ? Math.abs((got ?? NaN) - want) > 0.011 : got !== want)
  results.push({ id, name, pass: fails.length === 0,
    detail: fails.length === 0
      ? checks.map(([l, g]) => `${l}=${g}`).join(' ')
      : fails.map(([l, g, w]) => `${l}: got ${g}, want ${w}`).join('; ') })
}

// ────────────────── 場景 ──────────────────

// S1 正常月：全勤 → 勤工保留、帳戶0
async function S1() { await clean()
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:00'); await punch('2026-07-06', 'CLOCK_OUT', '18:00')
  await shift('2026-07-07'); await punch('2026-07-07', 'CLOCK_IN', '08:55'); await punch('2026-07-07', 'CLOCK_OUT', '18:00')
  const r = await run()
  assert('S1', '正常月（含早到不計）', [
    ['勤工取消', r.attendanceBonusCancelled, false],
    ['帳戶', tb(r).timeAccountMinutes, 0],
    ['OT', tb(r).otMinutes, 0],        // 早到5分不算OT
    ['缺勤', r.absentDays, 0],
  ])
}

// S2 遲到未超標：20分 ≤ 30 → 勤工保留、帳戶 −20
async function S2() { await clean()
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:20'); await punch('2026-07-06', 'CLOCK_OUT', '18:00')
  const r = await run()
  assert('S2', '遲到20未超標', [
    ['勤工取消', r.attendanceBonusCancelled, false],
    ['帳戶', tb(r).timeAccountMinutes, -20],
    ['淨遲到', tb(r).netLateMinutes, 20],
  ])
}

// S3 遲到超標：40分 > 30 → 勤工取消、帳戶 −40
async function S3() { await clean()
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:40'); await punch('2026-07-06', 'CLOCK_OUT', '18:00')
  const r = await run()
  assert('S3', '遲到40超標取消勤工', [
    ['勤工取消', r.attendanceBonusCancelled, true],
    ['帳戶', tb(r).timeAccountMinutes, -40],
  ])
}

// S4 純OT：120分 → 帳戶 +120、勤工保留
async function S4() { await clean()
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:00'); await punch('2026-07-06', 'CLOCK_OUT', '20:00')
  const r = await run()
  assert('S4', '純OT 120', [
    ['帳戶', tb(r).timeAccountMinutes, 120],
    ['OT', tb(r).otMinutes, 120],
    ['勤工取消', r.attendanceBonusCancelled, false],
    ['可換假', tb(r).convertibleLeaveDays, 0],   // <540
  ])
}

// S5 OT+遲到+補鐘(遲到)：OT600、遲到20已補 → 帳戶 600−20−0=580、勤工保留
async function S5() { await clean()
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:20'); await punch('2026-07-06', 'CLOCK_OUT', '18:00')
  await shift('2026-07-07'); await punch('2026-07-07', 'CLOCK_IN', '09:00'); await punch('2026-07-07', 'CLOCK_OUT', '23:00') // OT300
  await shift('2026-07-08'); await punch('2026-07-08', 'CLOCK_IN', '09:00'); await punch('2026-07-08', 'CLOCK_OUT', '23:00') // OT300
  await makeup('2026-07-06', 20, 'LATE')
  const r = await run()
  assert('S5', '補鐘消耗OT+護勤工', [
    ['帳戶', tb(r).timeAccountMinutes, 580],   // 600−20(補鐘)−0(淨遲到)
    ['淨遲到', tb(r).netLateMinutes, 0],
    ['勤工取消', r.attendanceBonusCancelled, false],  // 遲到已補→不觸發
    ['可換假', tb(r).convertibleLeaveDays, 1],
  ])
}

// S6 早退+補鐘(早退)：早退30已補、無OT → 帳戶 = −30（補鐘消耗）、淨早退0
async function S6() { await clean()
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:00'); await punch('2026-07-06', 'CLOCK_OUT', '17:30')
  await makeup('2026-07-06', 30, 'EARLY_LEAVE')
  const r = await run()
  assert('S6', '早退補鐘分型', [
    ['淨早退', tb(r).netEarlyMinutes, 0],
    ['帳戶', tb(r).timeAccountMinutes, -30],   // 0−30(補鐘)−0
  ])
}

// S7 缺勤：扣款+取消勤工，帳戶不受影響
async function S7() { await clean()
  await shift('2026-07-06') // 無打卡
  await shift('2026-07-07'); await punch('2026-07-07', 'CLOCK_IN', '09:00'); await punch('2026-07-07', 'CLOCK_OUT', '18:00')
  const r = await run()
  assert('S7', '缺勤扣款不進帳戶', [
    ['缺勤', r.absentDays, 1],
    ['扣款>0', (r.deduction ?? 0) > 0, true],
    ['勤工取消', r.attendanceBonusCancelled, true],
    ['帳戶', tb(r).timeAccountMinutes, 0],
  ])
}

// S8 跨月結轉：6月OT120 → 7月 carriedFrom=120（lazy backfill）
async function S8() { await clean()
  await shift('2026-06-22'); await punch('2026-06-22', 'CLOCK_IN', '09:00'); await punch('2026-06-22', 'CLOCK_OUT', '20:00')
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:00'); await punch('2026-07-06', 'CLOCK_OUT', '18:00')
  const r = await run(JULY)
  assert('S8', '跨月結轉補鏈', [
    ['carriedFrom', tb(r).carriedFrom, 120],
    ['帳戶', tb(r).timeAccountMinutes, 120],
  ])
}

// S9 換假消耗：OT600 + LEAVE_CONVERT −540 → 帳戶60、不可再換
async function S9() { await clean()
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:00'); await punch('2026-07-06', 'CLOCK_OUT', '23:00')
  await shift('2026-07-07'); await punch('2026-07-07', 'CLOCK_IN', '09:00'); await punch('2026-07-07', 'CLOCK_OUT', '23:00')
  await shift('2026-07-08'); await punch('2026-07-08', 'CLOCK_IN', '09:00'); await punch('2026-07-08', 'CLOCK_OUT', '19:00')
  // OT = 300+300+60 = 660... 設 600：改第三天 18:00→無OT
  await prisma.timeBankEntry.create({ data: { employeeId: empId, type: 'LEAVE_CONVERT',
    date: dt('2026-07-10', '12:00'), minutes: -540, note: '測試換假1天' } })
  const r = await run()
  const acct = tb(r).timeAccountMinutes
  assert('S9', '換假扣帳戶', [
    ['帳戶', acct, 660 - 540],       // 120
    ['可換假', tb(r).convertibleLeaveDays, 0],
  ])
}

// S10 兼職：時薪100、早到clamp、61分=101.67
async function S10() { await clean()
  await shift('2026-07-06', '09:00', '18:00')
  await punch('2026-07-06', 'CLOCK_IN', '08:45')   // 早到不計
  await punch('2026-07-06', 'CLOCK_OUT', '10:01')  // 09:00→10:01 = 61分
  const r = await run(JULY, { base_type: 'hourly', hourly_rate: 100 })
  assert('S10', '兼職分鐘計薪', [
    ['實發', r.totalPayable, 101.67],
    ['時間銀行無', (r.detail as any)?.timebank == null, true],
  ])
}

// S11 休息日冪等：跑兩次計糧 → entitled 一樣（2026-07 = 週末8 + 7/1 = 9）
async function S11() { await clean()
  await shift('2026-07-06'); await punch('2026-07-06', 'CLOCK_IN', '09:00'); await punch('2026-07-06', 'CLOCK_OUT', '18:00')
  await run(); await run()   // 重複生成
  const rd = await prisma.leaveType.findUnique({ where: { systemKey: 'REST_DAY' } })
  const bal = await prisma.leaveBalance.findFirst({ where: { employeeId: empId, leaveTypeId: rd!.id, year: 2026 } })
  assert('S11', '休息日發放冪等9天', [
    ['entitled', bal?.entitled, 9],
    ['remaining', bal?.remaining, 9],
  ])
}

// S12 cancelsBonus 請假：取消勤工、不算缺勤
async function S12() { await clean()
  let qj = await prisma.leaveType.findFirst({ where: { name: '套件請假' } })
  if (!qj) qj = await prisma.leaveType.create({ data: { name: '套件請假', isPaid: true, cancelsBonus: true } as any })
  await shift('2026-07-06')
  await prisma.leaveRequest.create({ data: { employeeId: empId, leaveTypeId: qj.id,
    startDate: dt('2026-07-06', '00:00'), endDate: dt('2026-07-06', '23:59'),
    days: 1, status: 'APPROVED' } as any })
  await shift('2026-07-07'); await punch('2026-07-07', 'CLOCK_IN', '09:00'); await punch('2026-07-07', 'CLOCK_OUT', '18:00')
  const r = await run()
  assert('S12', '請假取消勤工不缺勤', [
    ['缺勤', r.absentDays, 0],
    ['勤工取消', r.attendanceBonusCancelled, true],
  ])
}

// S13 修正生效進計算：18:01 修正成 15:53 → 早退127
async function S13() { await clean()
  await shift('2026-07-06')
  await punch('2026-07-06', 'CLOCK_IN', '09:00')
  await punch('2026-07-06', 'CLOCK_OUT', '18:01')
  // 修正落班到 15:53（status 值若不同請對照 schema 調整）
  await prisma.punchCorrection.create({ data: { employeeId: empId, clinicId,
    punchType: 'CLOCK_OUT', correctedTime: dt('2026-07-06', '15:53'),
    reason: '套件測試', status: 'EFFECTIVE' } as any })
  const r = await run()
  assert('S13', '修正套用(OT變早退)', [
    ['早退', tb(r).earlyLeaveMinutes, 127],
    ['OT', tb(r).otMinutes, 0],
  ])
}

// S14 作廢排除：作廢落班卡 → 當天無OT
async function S14() { await clean()
  await shift('2026-07-06')
  await punch('2026-07-06', 'CLOCK_IN', '09:00')
  const out = await punch('2026-07-06', 'CLOCK_OUT', '20:00')   // OT120
  await prisma.punchVoid.create({ data: { punchRecordId: out.id, voidedBy: userId, reason: '套件測試作廢' } })
  const r = await run()
  assert('S14', '作廢打卡排除計算', [
    ['OT', tb(r).otMinutes, 0],
    ['帳戶', tb(r).timeAccountMinutes, 0],
  ])
}

// ────────────────── 執行 ──────────────────
async function main() {
  console.log('\n═══════ 全場景測試套件 ═══════\n')
  await setup()
  const scenarios = [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, S13, S14]
  for (const s of scenarios) {
    try { await s() } catch (e: any) {
      results.push({ id: s.name, name: '(執行錯誤)', pass: false, detail: e.message?.slice(0, 120) })
    }
  }
  await clean()   // 收尾清乾淨

  console.log('┌──────┬────────────────────────────┬──────┐')
  let passCount = 0
  for (const r of results) {
    if (r.pass) passCount++
    console.log(`│ ${r.id.padEnd(4)} │ ${r.name.padEnd(22)} │ ${r.pass ? '✅' : '❌'} │ ${r.detail}`)
  }
  console.log('└──────┴────────────────────────────┴──────┘')
  console.log(`\n結果：${passCount}/${results.length} 通過${passCount === results.length ? ' 🎉 可交付' : ' — 修 ❌ 項後重跑'}\n`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1) })
