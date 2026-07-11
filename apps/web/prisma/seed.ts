// Prisma Seed Script — 6 clinics + 4 test users
import { PrismaClient, UserRole, UserStatus, EmployeeStatus, PayType } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const DEMO_CLINICS = [
  { name: '仁愛診所', address: '九龍觀塘道188號' },
  { name: '旺角診所', address: '九龍旺角彌敦道603號' },
  { name: '銅鑼灣診所', address: '香港銅鑼灣謝菲頓街22號' },
  { name: '荃灣診所', address: '新界荃灣大河道115號' },
  { name: '沙田診所', address: '新界沙田正街3號' },
  { name: '元朗診所', address: '新界元朗安寧路148號' },
]

async function main() {
  console.log('🌱 Seeding database...')

  // Clean existing data (order matters due to FK constraints)
  // Note: AuditLog is append-only, skip delete
  await prisma.notification.deleteMany()
  await prisma.leaveRequest.deleteMany()
  await prisma.leaveBalance.deleteMany()
  await prisma.leaveType.deleteMany()
  await prisma.hKPublicHoliday.deleteMany()
  // Note: PunchRecord is append-only, skip delete
  await prisma.punchCorrection.deleteMany()
  await prisma.shiftChangeRequest.deleteMany()
  await prisma.payrollItem.deleteMany()
  await prisma.payrollRun.deleteMany()
  await prisma.consultationRevenue.deleteMany()
  await prisma.timeBank.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.qRToken.deleteMany()
  await prisma.dailyHash.deleteMany()
  await prisma.payRule.deleteMany()
  await prisma.employeeClinic.deleteMany()
  await prisma.userClinic.deleteMany()
  await prisma.employee.deleteMany()
  await prisma.user.deleteMany()
  await prisma.shiftTemplate.deleteMany()
  await prisma.clinic.deleteMany()

  // Create clinics
  console.log('🏥 Creating 6 demo clinics...')
  const clinics = await Promise.all(
    DEMO_CLINICS.map(clinic =>
      prisma.clinic.create({
        data: { name: clinic.name, address: clinic.address },
      })
    )
  )
  console.log(`  ✅ Created ${clinics.length} clinics`)

  // Create shift templates
  console.log('🕐 Creating shift templates...')
  const templates = await Promise.all([
    prisma.shiftTemplate.create({
      data: { name: '早更', startHour: 9, startMinute: 0, endHour: 14, endMinute: 0, isDefault: true, isNightShift: false },
    }),
    prisma.shiftTemplate.create({
      data: { name: '午更', startHour: 14, startMinute: 0, endHour: 18, endMinute: 0, isDefault: true, isNightShift: false },
    }),
    prisma.shiftTemplate.create({
      data: { name: '全日', startHour: 9, startMinute: 0, endHour: 18, endMinute: 0, isDefault: true, isNightShift: false },
    }),
    prisma.shiftTemplate.create({
      data: { name: '夜更', startHour: 22, startMinute: 0, endHour: 6, endMinute: 0, isDefault: false, isNightShift: true },
    }),
  ])
  console.log(`  ✅ Created ${templates.length} shift templates`)

  // Hash password
  const hashedPassword = await bcrypt.hash('demo1234', 12)

  // Create 4 test users (one per role)
  const testUsers = [
    { name: '陳醫生 (Owner)', phone: '91000001', role: UserRole.OWNER, email: 'owner@clinic.demo' },
    { name: '李經理', phone: '91000002', role: UserRole.MANAGER, email: 'manager@clinic.demo' },
    { name: '張會計', phone: '91000003', role: UserRole.ACCOUNTANT, email: 'accountant@clinic.demo' },
    { name: '王護士', phone: '91000004', role: UserRole.EMPLOYEE, email: 'employee@clinic.demo' },
  ]

  console.log('👤 Creating 4 test users...')

  // Owner — access to all clinics
  const owner = await prisma.user.create({
    data: {
      ...testUsers[0],
      password: hashedPassword,
      status: UserStatus.ACTIVE,
      clinics: {
        create: clinics.map((c, i) => ({
          clinic: { connect: { id: c.id } },
          isPrimary: i === 0,
        })),
      },
    },
  })

  // Create Owner's Employee record
  await prisma.employee.create({
    data: {
      userId: owner.id,
      joinDate: new Date('2020-01-01'),
      status: EmployeeStatus.ACTIVE,
      notes: '診所創辦人',
    },
  })

  // Manager — access to clinic 1 (仁愛)
  const manager = await prisma.user.create({
    data: {
      ...testUsers[1],
      password: hashedPassword,
      status: UserStatus.ACTIVE,
      clinics: {
        create: [
          { clinic: { connect: { id: clinics[0].id } }, isPrimary: true },
        ],
      },
    },
  })

  await prisma.employee.create({
    data: {
      userId: manager.id,
      joinDate: new Date('2021-03-15'),
      status: EmployeeStatus.ACTIVE,
      notes: '仁愛診所經理',
    },
  })

  // Accountant — access to all clinics (read payroll)
  const accountant = await prisma.user.create({
    data: {
      ...testUsers[2],
      password: hashedPassword,
      status: UserStatus.ACTIVE,
      clinics: {
        create: clinics.map((c, i) => ({
          clinic: { connect: { id: c.id } },
          isPrimary: i === 0,
        })),
      },
    },
  })

  await prisma.employee.create({
    data: {
      userId: accountant.id,
      joinDate: new Date('2021-06-01'),
      status: EmployeeStatus.ACTIVE,
      notes: '總會計',
    },
  })

  // Employee — access to clinic 2 (旺角)
  const employee = await prisma.user.create({
    data: {
      ...testUsers[3],
      password: hashedPassword,
      status: UserStatus.ACTIVE,
      clinics: {
        create: [
          { clinic: { connect: { id: clinics[1].id } }, isPrimary: true },
        ],
      },
    },
  })

  await prisma.employee.create({
    data: {
      userId: employee.id,
      joinDate: new Date('2023-09-01'),
      status: EmployeeStatus.ACTIVE,
      notes: '旺角診所護士',
    },
  })

  console.log('  ✅ Created 4 users:')
  console.log(`    OWNER:       91000001 / demo1234`)
  console.log(`    MANAGER:     91000002 / demo1234 (仁愛診所)`)
  console.log(`    ACCOUNTANT:  91000003 / demo1234 (全部)`)
  console.log(`    EMPLOYEE:    91000004 / demo1234 (旺角診所)`)

  // Fetch all employees (needed for bindings, pay rules, leave balances)
  const allEmps = await prisma.employee.findMany({ include: { user: true } })

  // Employee-Clinic bindings (each employee assigned to primary clinic only)
  console.log('🔗 Creating employee-clinic bindings...')
  const employeeClinicMap = [
    { name: '陳醫生 (Owner)', clinicIndex: 0 },   // 仁愛診所
    { name: '李經理', clinicIndex: 0 },             // 仁愛診所
    { name: '張會計', clinicIndex: 2 },             // 銅鑼灣診所
    { name: '王護士', clinicIndex: 1 },             // 旺角診所
  ]
  const bindings = []
  for (const mapping of employeeClinicMap) {
    const emp = allEmps.find(e => e.user.name === mapping.name)
    if (emp) {
      bindings.push(prisma.employeeClinic.create({
        data: { employeeId: emp.id, clinicId: clinics[mapping.clinicIndex].id, isPrimary: true },
      }))
    }
  }
  await Promise.all(bindings)
  console.log(`  ✅ Created ${bindings.length} employee-clinic bindings`)

  // Pay rules (新格式 configJson)
  console.log('💰 Creating pay rules...')
  const ownerUserId = allEmps.find(e => e.user.role === 'OWNER')?.id

  const payRuleConfigs = {
    // 陳醫生 — 醫生薪酬（含拆帳）
    '陳醫生 (Owner)': {
      payType: 'SPLIT',
      baseAmount: 8000,
      configJson: JSON.stringify({
        base_type: 'split',
        base_salary: 8000,
        split_ratio: 0.3,
        modifiers: {
          working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
          mpf: { enabled: true, rate: 0.05, min: 7100, max: 50000 },
        },
      }),
    },
    // 李經理 — 月薪制
    '李經理': {
      payType: 'MONTHLY',
      baseAmount: 20000,
      configJson: JSON.stringify({
        base_type: 'monthly',
        monthly_salary: 20000,
        modifiers: {
          attendance_bonus: {
            amount: 800,
            cancel_if: {
              late_minutes_exceed: 30,
              late_is_cumulative: true,
              any_unplanned_leave: true,
              any_absence: true,
            },
          },
          working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
          mpf: { enabled: true, rate: 0.05, min: 7100, max: 50000 },
        },
      }),
    },
    // 張會計 — 月薪制
    '張會計': {
      payType: 'MONTHLY',
      baseAmount: 18000,
      configJson: JSON.stringify({
        base_type: 'monthly',
        monthly_salary: 18000,
        modifiers: {
          attendance_bonus: {
            amount: 600,
            cancel_if: {
              late_minutes_exceed: 30,
              late_is_cumulative: true,
              any_unplanned_leave: true,
              any_absence: true,
            },
          },
          working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
          mpf: { enabled: true, rate: 0.05, min: 7100, max: 50000 },
        },
      }),
    },
    // 王護士 — 完整规则（月薪制）
    '王護士': {
      payType: 'MONTHLY',
      baseAmount: 15000,
      configJson: JSON.stringify({
        base_type: 'monthly',
        monthly_salary: 15000,
        modifiers: {
          attendance_bonus: {
            amount: 500,
            cancel_if: {
              late_minutes_exceed: 30,
              late_is_cumulative: true,
              any_unplanned_leave: true,
              any_absence: true,
            },
          },
          overtime: { mode: 'time_off', hours_per_leave_day: 8 },
          working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
          deduction: { basis: 'statutory' },
          mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 },
        },
      }),
    },
  }

  for (const emp of allEmps) {
    const configName = emp.user.name
    const config = payRuleConfigs[configName as keyof typeof payRuleConfigs]
    if (!config) continue

    await prisma.payRule.create({
      data: {
        employeeId: emp.id,
        payType: config.payType as PayType,
        baseAmount: config.baseAmount,
        configJson: config.configJson,
        effectiveFrom: new Date('2026-07-01'),
        isActive: true,
        createdBy: ownerUserId || allEmps[0].id,
      },
    })
  }
  console.log(`  ✅ Created pay rules for ${Object.keys(payRuleConfigs).length} employees`)

  // Create leave types
  console.log('🏖️ Creating leave types...')
  // System leave types (REST_DAY, ANNUAL_LEAVE, OT_LEAVE) — locked, cannot be deleted
  const systemLeaveTypes = await Promise.all([
    prisma.leaveType.upsert({
      where: { systemKey: 'REST_DAY' },
      update: {},
      create: { name: '休息日', systemKey: 'REST_DAY', isPaid: true, color: '#4a4a4a' },
    }),
    prisma.leaveType.upsert({
      where: { systemKey: 'ANNUAL_LEAVE' },
      update: {},
      create: { name: '年假', systemKey: 'ANNUAL_LEAVE', isPaid: true, annualQuota: 12, color: '#27ae60' },
    }),
    prisma.leaveType.upsert({
      where: { systemKey: 'OT_LEAVE' },
      update: {},
      create: { name: 'OT補假', systemKey: 'OT_LEAVE', isPaid: true, color: '#8e44ad' },
    }),
  ])

  const leaveTypes = await Promise.all([
    // 病假 (user-managed)
    prisma.leaveType.create({
      data: { name: '病假', isPaid: true, annualQuota: 12, color: '#2196F3' },
    }),
    prisma.leaveType.create({
      data: { name: '事假', isPaid: false, annualQuota: null, color: '#FF9800' },
    }),
    prisma.leaveType.create({
      data: { name: '無薪假', isPaid: false, annualQuota: null, color: '#9E9E9E' },
    }),
    prisma.leaveType.create({
      data: { name: '產假', isPaid: true, annualQuota: 10, color: '#E91E63' },
    }),
    prisma.leaveType.create({
      data: { name: '侍產假', isPaid: true, annualQuota: 5, color: '#9C27B0' },
    }),
  ])
  console.log(`  ✅ Created ${systemLeaveTypes.length} system + ${leaveTypes.length} user leave types`)

  // Map for balance creation: systemLeaveTypes[1] = ANNUAL_LEAVE, systemLeaveTypes[0] = REST_DAY
  const restDayTypeId = systemLeaveTypes[0].id
  const annualLeaveTypeId = systemLeaveTypes[1].id
  const otLeaveTypeId = systemLeaveTypes[2].id
  console.log(`  ✅ Created ${leaveTypes.length} leave types`)

  // Create leave balances for test employees
  const currentYear = new Date().getFullYear()
  for (const emp of allEmps) {
    // Annual leave balance (using system ANNUAL_LEAVE type)
    await prisma.leaveBalance.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: annualLeaveTypeId,
        year: currentYear,
        entitled: 12,
        used: 0,
        remaining: 12,
      },
    })
    // Sick leave balance (using user-managed sick leave type)
    await prisma.leaveBalance.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: leaveTypes[0].id,
        year: currentYear,
        entitled: 12,
        used: 0,
        remaining: 12,
      },
    })
  }
  console.log(`  ✅ Created leave balances for ${allEmps.length} employees`)

  // Create HK public holidays (2026-2028)
  console.log('🇭🇰 Creating HK public holidays...')
  const hkHolidays = [
    // 2026 香港公眾假期（政府公佈）
    { date: new Date('2026-01-01T00:00:00+08:00'), name: 'New Year\'s Day' },
    { date: new Date('2026-01-26T00:00:00+08:00'), name: 'Lunar New Year (Day 1 of Chinese New Year)' },
    { date: new Date('2026-01-27T00:00:00+08:00'), name: 'Lunar New Year (Day 2 of Chinese New Year)' },
    { date: new Date('2026-01-28T00:00:00+08:00'), name: 'Lunar New Year (Day 3 of Chinese New Year)' },
    { date: new Date('2026-04-06T00:00:00+08:00'), name: 'Good Friday' },
    { date: new Date('2026-04-20T00:00:00+08:00'), name: 'Tomb Sweeping Day' },
    { date: new Date('2026-05-01T00:00:00+08:00'), name: 'Labour Day' },
    { date: new Date('2026-05-18T00:00:00+08:00'), name: 'Buddha\'s Birthday' },
    { date: new Date('2026-06-08T00:00:00+08:00'), name: 'Tuen Ng Festival' },
    { date: new Date('2026-07-01T00:00:00+08:00'), name: 'Birthday of Mr. Tung Chee Hwa' },
    { date: new Date('2026-09-20T00:00:00+08:00'), name: 'Mid-Autumn Festival (Day after)' },
    { date: new Date('2026-10-01T00:00:00+08:00'), name: 'National Day' },
    { date: new Date('2026-11-01T00:00:00+08:00'), name: 'Ching Ming Festival' },
    { date: new Date('2026-12-25T00:00:00+08:00'), name: 'Christmas Day' },
    { date: new Date('2026-12-26T00:00:00+08:00'), name: 'Christmas Day (Day after)' },
    // 2027
    { date: new Date('2027-01-01'), name: '元旦' },
    { date: new Date('2027-02-06'), name: '農曆新年（正月初一）' },
    { date: new Date('2027-02-07'), name: '農曆新年（正月初二）' },
    { date: new Date('2027-02-08'), name: '農曆新年（正月初三）' },
    { date: new Date('2027-04-02'), name: '耶穌受難節' },
    { date: new Date('2027-04-05'), name: '復活節後首日星期一' },
    { date: new Date('2027-04-30'), name: '勞工節' },
    { date: new Date('2027-05-18'), name: '佛誕' },
    { date: new Date('2027-06-10'), name: '端午節' },
    { date: new Date('2027-07-01'), name: '香港特別行政區成立紀念日' },
    { date: new Date('2027-08-26'), name: '中秋節後一日' },
    { date: new Date('2027-10-01'), name: '國慶日' },
    { date: new Date('2027-11-02'), name: '重陽節' },
    { date: new Date('2027-12-25'), name: '聖誕節' },
    { date: new Date('2027-12-26'), name: '聖誕節後一日' },
    // 2028
    { date: new Date('2028-01-01'), name: '元旦' },
    { date: new Date('2028-01-26'), name: '農曆新年（正月初一）' },
    { date: new Date('2028-01-27'), name: '農曆新年（正月初二）' },
    { date: new Date('2028-01-28'), name: '農曆新年（正月初三）' },
    { date: new Date('2028-03-30'), name: '耶穌受難節' },
    { date: new Date('2028-04-02'), name: '復活節後首日星期一' },
    { date: new Date('2028-04-30'), name: '勞工節' },
    { date: new Date('2028-05-07'), name: '佛誕' },
    { date: new Date('2028-06-28'), name: '端午節' },
    { date: new Date('2028-07-01'), name: '香港特別行政區成立紀念日' },
    { date: new Date('2028-09-15'), name: '中秋節後一日' },
    { date: new Date('2028-10-01'), name: '國慶日' },
    { date: new Date('2028-10-21'), name: '重陽節' },
    { date: new Date('2028-12-25'), name: '聖誕節' },
    { date: new Date('2028-12-26'), name: '聖誕節後一日' },
  ]

  // Deduplicate by date
  const uniqueHolidays = new Map<string, typeof hkHolidays[0]>()
  for (const h of hkHolidays) {
    const key = h.date.toISOString().split('T')[0]
    if (!uniqueHolidays.has(key)) {
      uniqueHolidays.set(key, h)
    }
  }

  for (const h of uniqueHolidays.values()) {
    await prisma.hKPublicHoliday.upsert({
      where: { date: h.date },
      create: h,
      update: {},
    })
  }
  console.log(`  ✅ Created ${uniqueHolidays.size} HK public holidays`)

  // Create audit log entry to prove it works
  await prisma.auditLog.create({
    data: {
      actorId: owner.id,
      action: 'CREATE',
      entity: 'System',
      entityId: 'seed',
      notes: 'Database seeded with demo data',
    },
  })

  console.log('✅ Seed complete!')
}

main()
  .catch(e => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
