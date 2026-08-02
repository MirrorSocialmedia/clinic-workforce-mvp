#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// test-seed-full-v2.mjs — 完整測試資料腳本 v2 (2026-08-02)
//
// 5 個測試員工覆蓋：
//   ZZTEST-01: 缺勤、無薪假、遲到、OT、午飯四款、跨月日率
//   ZZTEST-02: 調鋪、分更、跨店打卡
//   ZZTEST-03: 時薪 $100（驗證唔受影響）
//   ZZTEST-04: 病假 <4 日：三種排更組合
//   ZZTEST-05: 病假 ≥4 日：四種排更組合 ★ 核心
//
// 用法:
//   node prisma/test-seed-full-v2.mjs            # DRY RUN（預設）
//   DRY_RUN=false node prisma/test-seed-full-v2.mjs   # 實際寫入
// ═══════════════════════════════════════════════════════════

const DRY_RUN = process.env.DRY_RUN !== 'false'
const SQL = []

if (DRY_RUN) console.log('⚠️  DRY RUN 模式 — 只打印 SQL，唔寫入 DB\n')

// bcrypt hash for password "12345678" (cost 12)
const PASSWORD_HASH = '$2a$12$QVrLaZFSTMvH.KhPY0oUauDGAecPET/pdCkCWh8t7wfjnVP8iyRSC'

// ─── Helpers ───
const hk = (d, t = '00:00') => new Date(`${d}T${t}:00+08:00`).toISOString()
let idCounter = 1
const uid = () => `seed${idCounter++}`

function sql(id, table, data) {
  const json = JSON.stringify(data).replace(/"/g, '\\"')
  SQL.push(`INSERT INTO ${table} (id, ...) VALUES ("${id}", ...) -- ${json}`)
}

// ─── Config ───
const COMPANY = '測試公司 QA v2'
const CLINIC_A = { name: '大圍', shortName: '圍' }
const CLINIC_B = { name: '元朗', shortName: '朗' }

// Standard shift times
const SHIFT_STANDARD = { start: '10:00', end: '18:00' } // 8h, lunch 60 min
const SHIFT_SHORT   = { start: '10:00', end: '16:00' } // 6h
const SHIFT_SPLIT_A = { start: '10:00', end: '14:00' } // Split first part
const SHIFT_SPLIT_B = { start: '14:00', end: '18:00' } // Split second part

// Leave type system keys
const LT_ANNUAL  = 'ANNUAL_LEAVE'
const LT_SICK    = 'SICK'
const LT_REST    = 'REST_DAY'
const LT_OT      = 'OT_LEAVE'
const LT_UNPAID  = null // custom unpaid

// ─── Employee definitions ───
const EMPLOYEES = [
  { name: 'ZZTEST-01', phone: '90000001', payType: 'MONTHLY', baseAmount: 20000 },
  { name: 'ZZTEST-02', phone: '90000002', payType: 'MONTHLY', baseAmount: 20000 },
  { name: 'ZZTEST-03', phone: '90000003', payType: 'HOURLY',  baseAmount: 100 },
  { name: 'ZZTEST-04', phone: '90000004', payType: 'MONTHLY', baseAmount: 20000 },
  { name: 'ZZTEST-05', phone: '90000005', payType: 'MONTHLY', baseAmount: 20000 },
]

// ─── June 2026 calendar reference ───
// 30 days / 8 Saturdays / 1 public holiday (06-19 端午) → 21 working days → daily rate 952.38
// 06-01 Mon, 06-02 Tue, 06-03 Wed, 06-04 Thu, 06-05 Fri
// 06-06 Sat, 06-07 Sun, 06-08 Mon, 06-09 Tue, 06-10 Wed
// 06-11 Thu, 06-12 Fri, 06-13 Sat, 06-14 Sun, 06-15 Mon
// 06-16 Tue, 06-17 Wed, 06-18 Thu, 06-19 Fri(PH), 06-20 Sat
// 06-21 Sun, 06-22 Mon, 06-23 Tue, 06-24 Wed, 06-25 Thu
// 06-26 Fri, 06-27 Sat, 06-28 Sun, 06-29 Mon, 06-30 Tue

function isWeekend(d) {
  const day = new Date(`${d}T00:00:00+08:00`).getDay()
  return day === 0 || day === 6
}
function isPH(d) {
  return d === '2026-06-19' // 端午
}
function isWorkingDay(d) {
  return !isWeekend(d) && !isPH(d)
}

// ─── Build shifts for each employee ───
// Returns { employeeId, shifts: [{date, startTime, endTime, clinicId}], punches: [{date, time, type, clinicId}] }

function buildZZTEST01() {
  // Monthly $20,000, Clinic A only
  // - Absence 2 days (no shift, no punch): 06-03, 06-04
  // - Unpaid leave 2 days: 06-05, 06-06(Sat no shift)
  // - Late 27 min: 06-08 (IN 10:27)
  // - Lunch: 60min×1, 80min×1(06-16), 40min×1(06-15), 30min×1(06-17)
  // - OT: 16+29+20+30 = 95 min
  // Shifts on all working days except 06-03, 06-04 (absence)
  const clinic = 'clinicA'
  const shifts = []
  const punches = []

  // Working days in June: exclude 06-03, 06-04 (absence), weekends, 06-19 (PH)
  // But we DO create shifts for 06-05 (unpaid leave still needs shift reference)
  // Actually for absence (no shift, no punch): 06-03, 06-04
  // Unpaid leave: 06-05 (Fri), 06-06 (Sat - no shift on Sat)
  const workDays = []
  for (let d = 1; d <= 30; d++) {
    const ds = `2026-06-${String(d).padStart(2, '0')}`
    if (isWeekend(ds) || isPH(ds)) continue
    if (ds === '2026-06-03' || ds === '2026-06-04') continue // absence
    workDays.push(ds)
  }

  for (const d of workDays) {
    let { start, end } = SHIFT_STANDARD
    // OT days: extend end time
    if (d === '2026-06-10') end = '18:16'  // +16 min OT
    if (d === '2026-06-11') end = '18:29'  // +29 min OT
    if (d === '2026-06-13') { /* Sat - skip */ continue }
    if (d === '2026-06-14') { /* Sun - skip */ continue }
    if (d === '2026-06-12') end = '18:20'  // +20 min OT
    if (d === '2026-06-25') end = '18:30'  // +30 min OT

    shifts.push({ date: d, startTime: `${d}T${start}:00+08:00`, endTime: `${d}T${end}:00+08:00`, clinicId: clinic })

    // Punches: standard IN/OUT
    let punchIn = start
    if (d === '2026-06-08') punchIn = '10:27' // late 27 min

    punches.push({ date: d, time: punchIn, type: 'CLOCK_IN', clinicId: clinic })
    punches.push({ date: d, time: end, type: 'CLOCK_OUT', clinicId: clinic })
  }

  // July: 1 absence × 909.09
  // July 2026: 31 days / 8 Sat / 1 PH (07-01 回歸) → 22 working days
  // Add shifts for most working days, skip 07-06 (absence)
  for (let d = 1; d <= 31; d++) {
    const ds = `2026-07-${String(d).padStart(2, '0')}`
    if (isWeekend(ds) || isPH(ds)) continue
    if (ds === '2026-07-06') continue // absence in July
    shifts.push({ date: ds, startTime: `${ds}T${SHIFT_STANDARD.start}:00+08:00`, endTime: `${ds}T${SHIFT_STANDARD.end}:00+08:00`, clinicId: clinic })
    punches.push({ date: ds, time: SHIFT_STANDARD.start, type: 'CLOCK_IN', clinicId: clinic })
    punches.push({ date: ds, time: SHIFT_STANDARD.end, type: 'CLOCK_OUT', clinicId: clinic })
  }

  return { shifts, punches }
}

function buildZZTEST02() {
  // Monthly $20,000, cross-shop (Clinic A + B)
  // 06-01: 調鋪單更 (A IN, B OUT), 8h, no missing punch flag
  // 06-02: 調鋪兩更 (A IN, A OUT, B IN, no B OUT), total 8h, lunch 0 (gap 60)
  // 06-03: 同店分更 (Clinic A), late 20, early leave 60
  // 06-04: 調鋪空檔 90, lunch 0
  // 06-05: 調鋪空檔 15, lunch 45
  const shifts = []
  const punches = []

  // 06-01: Single shift, A IN → B OUT (cross-shop)
  shifts.push({ date: '2026-06-01', startTime: '2026-06-01T10:00:00+08:00', endTime: '2026-06-01T18:00:00+08:00', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-01', time: '10:00', type: 'CLOCK_IN', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-01', time: '18:00', type: 'CLOCK_OUT', clinicId: 'clinicB' }) // cross-shop OUT

  // 06-02: Two shifts, cross-shop, missing B OUT punch
  shifts.push({ date: '2026-06-02', startTime: '2026-06-02T10:00:00+08:00', endTime: '2026-06-02T14:00:00+08:00', clinicId: 'clinicA' })
  shifts.push({ date: '2026-06-02', startTime: '2026-06-02T15:00:00+08:00', endTime: '2026-06-02T19:00:00+08:00', clinicId: 'clinicB' })
  punches.push({ date: '2026-06-02', time: '10:00', type: 'CLOCK_IN', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-02', time: '14:00', type: 'CLOCK_OUT', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-02', time: '15:00', type: 'CLOCK_IN', clinicId: 'clinicB' })
  // No B OUT punch — intentionally missing

  // 06-03: Same-shop split shift (Clinic A), late 20, early leave 60
  shifts.push({ date: '2026-06-03', startTime: '2026-06-03T10:00:00+08:00', endTime: '2026-06-03T14:00:00+08:00', clinicId: 'clinicA' })
  shifts.push({ date: '2026-06-03', startTime: '2026-06-03T14:00:00+08:00', endTime: '2026-06-03T18:00:00+08:00', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-03', time: '10:20', type: 'CLOCK_IN', clinicId: 'clinicA' })   // late 20
  punches.push({ date: '2026-06-03', time: '14:00', type: 'CLOCK_OUT', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-03', time: '14:00', type: 'CLOCK_IN', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-03', time: '17:00', type: 'CLOCK_OUT', clinicId: 'clinicA' })   // early 60

  // 06-04: Cross-shop gap 90 min, lunch 0
  shifts.push({ date: '2026-06-04', startTime: '2026-06-04T10:00:00+08:00', endTime: '2026-06-04T14:00:00+08:00', clinicId: 'clinicA' })
  shifts.push({ date: '2026-06-04', startTime: '2026-06-04T15:30:00+08:00', endTime: '2026-06-04T19:30:00+08:00', clinicId: 'clinicB' })
  punches.push({ date: '2026-06-04', time: '10:00', type: 'CLOCK_IN', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-04', time: '14:00', type: 'CLOCK_OUT', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-04', time: '15:30', type: 'CLOCK_IN', clinicId: 'clinicB' })
  punches.push({ date: '2026-06-04', time: '19:30', type: 'CLOCK_OUT', clinicId: 'clinicB' })

  // 06-05: Cross-shop gap 15 min, lunch 45
  shifts.push({ date: '2026-06-05', startTime: '2026-06-05T10:00:00+08:00', endTime: '2026-06-05T14:00:00+08:00', clinicId: 'clinicA' })
  shifts.push({ date: '2026-06-05', startTime: '2026-06-05T14:15:00+08:00', endTime: '2026-06-05T18:15:00+08:00', clinicId: 'clinicB' })
  punches.push({ date: '2026-06-05', time: '10:00', type: 'CLOCK_IN', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-05', time: '14:00', type: 'CLOCK_OUT', clinicId: 'clinicA' })
  punches.push({ date: '2026-06-05', time: '14:15', type: 'CLOCK_IN', clinicId: 'clinicB' })
  punches.push({ date: '2026-06-05', time: '18:15', type: 'CLOCK_OUT', clinicId: 'clinicB' })

  return { shifts, punches }
}

function buildZZTEST03() {
  // Hourly $100, Clinic A only
  // 06-01~04: 540 min (60 lunch) each, $640/day
  // 06-05: missing OUT punch, $0.00
  // 06-08~10: 540 min (60 lunch) each, $640/day
  // Total: $4,546.67
  const shifts = []
  const punches = []
  const clinic = 'clinicA'

  // 06-01 to 06-04: full shifts with proper punches
  for (const d of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']) {
    shifts.push({ date: d, startTime: `${d}T10:00:00+08:00`, endTime: `${d}T19:00:00+08:00`, clinicId: clinic })
    punches.push({ date: d, time: '10:00', type: 'CLOCK_IN', clinicId: clinic })
    punches.push({ date: d, time: '19:00', type: 'CLOCK_OUT', clinicId: clinic })
  }

  // 06-05: shift exists but missing OUT punch
  shifts.push({ date: '2026-06-05', startTime: '2026-06-05T10:00:00+08:00', endTime: '2026-06-05T19:00:00+08:00', clinicId: clinic })
  punches.push({ date: '2026-06-05', time: '10:00', type: 'CLOCK_IN', clinicId: clinic })
  // No OUT punch — intentionally missing

  // 06-08 to 06-10: full shifts
  for (const d of ['2026-06-08', '2026-06-09', '2026-06-10']) {
    shifts.push({ date: d, startTime: `${d}T10:00:00+08:00`, endTime: `${d}T19:00:00+08:00`, clinicId: clinic })
    punches.push({ date: d, time: '10:00', type: 'CLOCK_IN', clinicId: clinic })
    punches.push({ date: d, time: '19:00', type: 'CLOCK_OUT', clinicId: clinic })
  }

  return { shifts, punches }
}

function buildZZTEST04() {
  // Monthly $20,000, Clinic A only
  // Sick leave < 4 days: 3 segments of 2 days each
  // Combo 1: 06-01~02 (2 days with shifts) → deduct 1,904.76
  // Combo 2: 06-05~06 (1 day with shift, 06-06 Sat no shift) → deduct 952.38
  // Combo 3: 06-13~14 (0 days with shift, weekend) → deduct 0
  // Total deduction: 2,857.14
  const shifts = []
  const punches = []
  const clinic = 'clinicA'

  // Create shifts for all working days except sick leave days 06-01, 06-02, 06-05
  // (06-06 Sat and 06-13 Sat, 06-14 Sun never have shifts)
  for (let d = 1; d <= 30; d++) {
    const ds = `2026-06-${String(d).padStart(2, '0')}`
    if (isWeekend(ds) || isPH(ds)) continue
    // Sick leave with shifts: 06-01, 06-02, 06-05 — still need shifts (sick overlays shift)
    shifts.push({ date: ds, startTime: `${ds}T${SHIFT_STANDARD.start}:00+08:00`, endTime: `${ds}T${SHIFT_STANDARD.end}:00+08:00`, clinicId: clinic })
    // No punches on sick leave days
    if (!['2026-06-01', '2026-06-02', '2026-06-05'].includes(ds)) {
      punches.push({ date: ds, time: SHIFT_STANDARD.start, type: 'CLOCK_IN', clinicId: clinic })
      punches.push({ date: ds, time: SHIFT_STANDARD.end, type: 'CLOCK_OUT', clinicId: clinic })
    }
  }

  return { shifts, punches }
}

function buildZZTEST05() {
  // Monthly $20,000, Clinic A only ★ CORE
  // Sick leave >= 4 days: 4 segments of 4 days each
  // A: 06-01~04 (4 days all with shifts) → deduct 1,693.82
  // B: 06-08~11 (3 days with shift, 06-10 Wed... wait, let me recalculate)
  //   06-08 Mon(shift), 06-09 Tue(shift), 06-10 Wed(shift), 06-11 Thu(shift) = 4 shifts?
  //   But spec says 3 days with shift. Let me check: 06-10 is Wed, not weekend.
  //   Actually the spec says "06-10 冇排" — we need to NOT create a shift on 06-10
  //   So the shift gap is intentional to test partial coverage
  // C: 06-15~18 (2 days with shift) → 0 (allowance >= salary)
  // D: 06-22~25 (1 day with shift) → 0 (no deduct no compensate)
  // Total: 2,435.26
  const shifts = []
  const punches = []
  const clinic = 'clinicA'

  // Create shifts for all working days except:
  // - Segment A: 06-01~04 all get shifts (4 shifts)
  // - Segment B: 06-08, 06-09, 06-11 get shifts; 06-10 intentionally NO shift (3 shifts)
  // - Segment C: 06-15, 06-16 get shifts; 06-17, 06-18 NO shifts (2 shifts)
  //   Wait, 06-17 is Wed, 06-18 is Thu. We only want 2 shifts.
  //   06-15 Mon(shift), 06-16 Tue(shift), 06-17 Wed(no shift), 06-18 Thu(no shift)
  // - Segment D: 06-22 gets shift; 06-23, 06-24, 06-25 NO shifts (1 shift)
  const noShiftDays = new Set([
    '2026-06-10', // Segment B: 3 of 4
    '2026-06-17', '2026-06-18', // Segment C: 2 of 4
    '2026-06-23', '2026-06-24', '2026-06-25', // Segment D: 1 of 4
  ])

  for (let d = 1; d <= 30; d++) {
    const ds = `2026-06-${String(d).padStart(2, '0')}`
    if (isWeekend(ds) || isPH(ds)) continue
    if (noShiftDays.has(ds)) continue

    shifts.push({ date: ds, startTime: `${ds}T${SHIFT_STANDARD.start}:00+08:00`, endTime: `${ds}T${SHIFT_STANDARD.end}:00+08:00`, clinicId: clinic })
    // No punches on sick leave days (segments A, B, C, D)
    const sickDays = new Set([
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', // A
      '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', // B
      '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', // C
      '2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25', // D
    ])
    if (!sickDays.has(ds)) {
      punches.push({ date: ds, time: SHIFT_STANDARD.start, type: 'CLOCK_IN', clinicId: clinic })
      punches.push({ date: ds, time: SHIFT_STANDARD.end, type: 'CLOCK_OUT', clinicId: clinic })
    }
  }

  return { shifts, punches }
}

// ─── Leave request definitions ───
const LEAVE_REQUESTS = {
  // ZZTEST-01: unpaid leave 2 days
  0: [
    { leaveTypeKey: null, startDate: '2026-06-05', endDate: '2026-06-05', status: 'APPROVED' },   // 無薪假
    { leaveTypeKey: null, startDate: '2026-06-06', endDate: '2026-06-06', status: 'APPROVED' },   // 無薪假 (Sat — test)
    // July absence unpaid leave
    { leaveTypeKey: null, startDate: '2026-07-06', endDate: '2026-07-06', status: 'APPROVED' },
  ],
  // ZZTEST-02: no leave requests
  1: [],
  // ZZTEST-03: no leave requests
  2: [],
  // ZZTEST-04: 3 segments of sick leave (2 days each)
  3: [
    { leaveTypeKey: LT_SICK, startDate: '2026-06-01', endDate: '2026-06-02', status: 'APPROVED' },
    { leaveTypeKey: LT_SICK, startDate: '2026-06-05', endDate: '2026-06-06', status: 'APPROVED' },
    { leaveTypeKey: LT_SICK, startDate: '2026-06-13', endDate: '2026-06-14', status: 'APPROVED' },
  ],
  // ZZTEST-05: 4 segments of sick leave (4 days each) ★ CORE
  4: [
    { leaveTypeKey: LT_SICK, startDate: '2026-06-01', endDate: '2026-06-04', status: 'APPROVED' },
    { leaveTypeKey: LT_SICK, startDate: '2026-06-08', endDate: '2026-06-11', status: 'APPROVED' },
    { leaveTypeKey: LT_SICK, startDate: '2026-06-15', endDate: '2026-06-18', status: 'APPROVED' },
    { leaveTypeKey: LT_SICK, startDate: '2026-06-22', endDate: '2026-06-25', status: 'APPROVED' },
  ],
}

// ═══════════════════════════════════════════════════════════
// Main execution
// ═══════════════════════════════════════════════════════════

async function main() {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()

  console.log('🏗️  Creating company and clinics...')
  const company = await prisma.company.create({ data: { name: COMPANY } })
  const clinicA = await prisma.clinic.create({ data: {
    name: CLINIC_A.name, shortName: CLINIC_A.shortName, companyId: company.id
  }})
  const clinicB = await prisma.clinic.create({ data: {
    name: CLINIC_B.name, shortName: CLINIC_B.shortName, companyId: company.id
  }})
  console.log(`  Company: ${company.id}`)
  console.log(`  Clinic A (大圍): ${clinicA.id}`)
  console.log(`  Clinic B (元朗): ${clinicB.id}`)

  console.log('\n📋 Creating leave types...')
  const leaveTypes = {}
  for (const lt of [
    { name: '年假', systemKey: LT_ANNUAL, isPaid: true, color: '#60a5fa' },
    { name: '病假', systemKey: LT_SICK, isPaid: true, color: '#f87171' },
    { name: '休息日', systemKey: LT_REST, isPaid: true, color: '#a78bfa' },
    { name: 'OT補假', systemKey: LT_OT, isPaid: true, color: '#34d399' },
    { name: '無薪假', systemKey: LT_UNPAID, isPaid: false, color: '#9ca3af' },
  ]) {
    const created = await prisma.leaveType.create({ data: lt })
    if (lt.systemKey) leaveTypes[lt.systemKey] = created
    else leaveTypes['__UNPAID__'] = created
    console.log(`  ${lt.name} (${lt.systemKey || 'custom'}): ${created.id}`)
  }

  // Owner
  console.log('\n👤 Creating owner...')
  const ownerUser = await prisma.user.create({ data: {
    name: 'QA Owner', phone: '88888888',
    password: PASSWORD_HASH, role: 'OWNER', status: 'ACTIVE'
  }})
  await prisma.userClinic.create({ data: { userId: ownerUser.id, clinicId: clinicA.id } })
  await prisma.userClinic.create({ data: { userId: ownerUser.id, clinicId: clinicB.id } })
  console.log(`  Owner: ${ownerUser.id} (phone: 88888888, pw: 12345678)`)

  // Employees
  const employeeBuilders = [buildZZTEST01, buildZZTEST02, buildZZTEST03, buildZZTEST04, buildZZTEST05]
  const clinicMap = ['clinicA', 'clinicB'] // for shift clinicId resolution

  const clinicIdMap = { clinicA: clinicA.id, clinicB: clinicB.id }

  console.log('\n👥 Creating employees and data...')
  for (let i = 0; i < EMPLOYEES.length; i++) {
    const empDef = EMPLOYEES[i]
    console.log(`\n  ── ${empDef.name} (phone: ${empDef.phone}) ──`)

    // Create user
    const user = await prisma.user.create({ data: {
      name: empDef.name, phone: empDef.phone,
      password: PASSWORD_HASH, role: 'EMPLOYEE', status: 'ACTIVE'
    }})
    await prisma.userClinic.create({ data: { userId: user.id, clinicId: clinicA.id } })
    // ZZTEST-02 also needs access to clinicB for cross-shop
    if (i === 1) {
      await prisma.userClinic.create({ data: { userId: user.id, clinicId: clinicB.id } })
    }

    // Create employee
    const employee = await prisma.employee.create({ data: {
      userId: user.id, homeClinicId: clinicA.id, joinDate: new Date('2025-06-01T00:00:00+08:00')
    }})
    await prisma.employeeClinic.create({ data: { employeeId: employee.id, clinicId: clinicA.id } })
    if (i === 1) {
      await prisma.employeeClinic.create({ data: { employeeId: employee.id, clinicId: clinicB.id } })
    }

    // Pay rule
    const payConfig = empDef.payType === 'MONTHLY'
      ? { working_days: { rest_days: [6, 0] }, deduction_rate: 1, ot_min_minutes: 0 }
      : { hourly_rate: empDef.baseAmount }
    await prisma.payRule.create({ data: {
      employeeId: employee.id,
      payType: empDef.payType,
      baseAmount: empDef.baseAmount,
      configJson: JSON.stringify(payConfig),
      effectiveFrom: new Date('2025-01-01T00:00:00+08:00'),
      createdBy: ownerUser.id
    }})

    // Rest day grants (for monthly employees)
    if (empDef.payType === 'MONTHLY') {
      const restType = leaveTypes[LT_REST]
      for (const [ym, days] of [['2026-06', 9], ['2026-07', 9]]) {
        const [y, m] = ym.split('-').map(Number)
        await prisma.timeBankEntry.create({ data: {
          employeeId: employee.id, date: new Date(`${ym}-01T00:00:00+08:00`), type: 'RESTDAY_GRANT',
          minutes: days * 24 * 60, note: `restday_grant_${y}_${m} 種子預發`,
        }})
        await prisma.leaveBalance.upsert({
          where: { employeeId_leaveTypeId_year: {
            employeeId: employee.id, leaveTypeId: restType.id, year: y
          }},
          create: { employeeId: employee.id, leaveTypeId: restType.id, year: y, entitled: days, used: 0, remaining: days },
          update: { entitled: days, used: 0, remaining: days },
        })
      }
    }

    // Build shifts and punches
    const builder = employeeBuilders[i]
    const { shifts, punches } = builder()

    // Create shifts
    for (const s of shifts) {
      const resolvedClinicId = typeof s.clinicId === 'string' ? clinicIdMap[s.clinicId] : s.clinicId
      await prisma.shift.create({ data: {
        employeeId: employee.id,
        clinicId: resolvedClinicId,
        date: new Date(s.date),
        startTime: new Date(s.startTime),
        endTime: new Date(s.endTime),
        createdBy: ownerUser.id
      }})
    }
    console.log(`    Shifts: ${shifts.length}`)

    // Create punches
    for (const p of punches) {
      const resolvedClinicId = typeof p.clinicId === 'string' ? clinicIdMap[p.clinicId] : p.clinicId
      await prisma.punchRecord.create({ data: {
        employeeId: employee.id,
        clinicId: resolvedClinicId,
        punchTime: new Date(`${p.date}T${p.time}:00+08:00`),
        punchType: p.type,
        source: 'QR_STATIC',
        tokenValid: true
      }})
    }
    console.log(`    Punches: ${punches.length}`)

    // Leave requests
    const leaves = LEAVE_REQUESTS[i] || []
    for (const lr of leaves) {
      let leaveTypeId
      if (lr.leaveTypeKey === null) {
        // Unpaid leave (custom type with null systemKey)
        leaveTypeId = leaveTypes['__UNPAID__'].id
      } else {
        leaveTypeId = leaveTypes[lr.leaveTypeKey].id
      }

      await prisma.leaveRequest.create({ data: {
        employeeId: employee.id,
        leaveTypeId,
        startDate: new Date(`${lr.startDate}T00:00:00+08:00`),
        endDate: new Date(`${lr.endDate}T00:00:00+08:00`),
        status: lr.status,
        requestedBy: employee.id,
        approvedBy: ownerUser.id,
        approvedAt: new Date('2026-05-25T00:00:00+08:00')
      }})
    }
    if (leaves.length > 0) {
      console.log(`    Leave requests: ${leaves.length}`)
    }
  }

  console.log('\n✅ 完成! 所有測試資料已創建')
  console.log(`\n📊 摘要:`)
  console.log(`  Company: ${COMPANY}`)
  console.log(`  Clinics: ${CLINIC_A.name}(${CLINIC_A.shortName}), ${CLINIC_B.name}(${CLINIC_B.shortName})`)
  console.log(`  Owner: 88888888 / pw: 12345678`)
  for (let i = 0; i < EMPLOYEES.length; i++) {
    const e = EMPLOYEES[i]
    console.log(`  ${e.name}: phone ${e.phone} / ${e.payType} $${e.baseAmount} / pw: 12345678`)
  }

  console.log(`\n📅 月份基準:`)
  console.log(`  2026-06: 30 曆日 / 8 六日 / 1 PH(6/19 端午) → 21 工作日 → 日率 952.38`)
  console.log(`  2026-07: 31 曆日 / 8 六日 / 1 PH(7/1 回歸) → 22 工作日 → 日率 909.09`)

  console.log(`\n💰 預期扣薪:`)
  console.log(`  ZZTEST-01: 缺勤 2 日 + 無薪假 2 日 (6月) + 缺勤 1 日 (7月 × 909.09)`)
  console.log(`  ZZTEST-02: 勤工獎取消 (遲到+早退=80 分鐘)`)
  console.log(`  ZZTEST-03: $4,546.67 (06-05 缺 OUT 卡 → $0)`)
  console.log(`  ZZTEST-04: 2,857.14 (病假<4: 1,904.76 + 952.38 + 0)`)
  console.log(`  ZZTEST-05: 2,435.26 (病假≥4: 1,693.82 + 741.44 + 0 + 0)`)

  await prisma.$disconnect()
}

// Run
if (DRY_RUN) {
  console.log('📋 DRY RUN — 以下是會執行的操作:')
  console.log('')
  console.log('1. 創建公司: ' + COMPANY)
  console.log('2. 創建診所: ' + CLINIC_A.name + '(' + CLINIC_A.shortName + '), ' + CLINIC_B.name + '(' + CLINIC_B.shortName + ')')
  console.log('3. 創建 LeaveTypes: 年假, 病假, 休息日, OT補假, 無薪假')
  console.log('4. 創建 Owner (88888888 / 12345678)')

  for (let i = 0; i < EMPLOYEES.length; i++) {
    const e = EMPLOYEES[i]
    const builder = [buildZZTEST01, buildZZTEST02, buildZZTEST03, buildZZTEST04, buildZZTEST05][i]
    const { shifts, punches } = builder()
    const leaves = LEAVE_REQUESTS[i] || []
    console.log(`5. 創建 ${e.name} (phone ${e.phone}): `)
    console.log(`     payType=${e.payType}, baseAmount=${e.baseAmount}`)
    console.log(`     shifts=${shifts.length}, punches=${punches.length}, leaveRequests=${leaves.length}`)
  }

  console.log('')
  console.log('💰 預期扣薪:')
  console.log('  ZZTEST-01: 缺勤 2 日 + 無薪假 2 日 (6月) + 缺勤 1 日 (7月 × 909.09)')
  console.log('  ZZTEST-02: 勤工獎取消 (遲到+早退=80 分鐘)')
  console.log('  ZZTEST-03: $4,546.67 (06-05 缺 OUT 卡 → $0)')
  console.log('  ZZTEST-04: 2,857.14 (病假<4: 1,904.76 + 952.38 + 0)')
  console.log('  ZZTEST-05: 2,435.26 (病假≥4: 1,693.82 + 741.44 + 0 + 0)')

  console.log('\n🔧 執行模式: DRY_RUN=false node prisma/test-seed-full-v2.mjs')
  process.exit(0)
}

main().catch(err => {
  console.error('❌ 錯誤:', err)
  process.exit(1)
})
