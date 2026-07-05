// Prisma Seed Script — 6 clinics + 4 test users
import { PrismaClient, UserRole, UserStatus, EmployeeStatus } from '@prisma/client'
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

  // Clean existing data
  await prisma.auditLog.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.leaveRequest.deleteMany()
  await prisma.leaveBalance.deleteMany()
  await prisma.leaveType.deleteMany()
  await prisma.hKPublicHoliday.deleteMany()
  await prisma.punchRecord.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.payRule.deleteMany()
  await prisma.employeeClinic.deleteMany()
  await prisma.userClinic.deleteMany()
  await prisma.employee.deleteMany()
  await prisma.user.deleteMany()
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

  // Create leave types
  console.log('🏖️ Creating leave types...')
  const leaveTypes = await Promise.all([
    prisma.leaveType.create({
      data: { name: '年假', isPaid: true, annualQuota: 12, color: '#4CAF50' },
    }),
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
  console.log(`  ✅ Created ${leaveTypes.length} leave types`)

  // Create leave balances for test employees
  const allEmployees = await prisma.employee.findMany()
  const currentYear = new Date().getFullYear()
  for (const emp of allEmployees) {
    // Annual leave balance
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
    // Sick leave balance
    await prisma.leaveBalance.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: leaveTypes[1].id,
        year: currentYear,
        entitled: 12,
        used: 0,
        remaining: 12,
      },
    })
  }
  console.log(`  ✅ Created leave balances for ${allEmployees.length} employees`)

  // Create HK public holidays (2026-2028)
  console.log('🇭🇰 Creating HK public holidays...')
  const hkHolidays = [
    // 2026
    { date: new Date('2026-01-01'), name: '元旦' },
    { date: new Date('2026-02-17'), name: '農曆新年（正月初一）' },
    { date: new Date('2026-02-18'), name: '農曆新年（正月初二）' },
    { date: new Date('2026-02-19'), name: '農曆新年（正月初三）' },
    { date: new Date('2026-04-06'), name: '耶穌受難節' },
    { date: new Date('2026-04-07'), name: '耶穌受難節（星期一）' },
    { date: new Date('2026-04-20'), name: '復活節後首日星期一' },
    { date: new Date('2026-04-30'), name: '勞工節' },
    { date: new Date('2026-05-29'), name: '佛誕' },
    { date: new Date('2026-06-19'), name: '端午節' },
    { date: new Date('2026-07-01'), name: '香港特別行政區成立紀念日' },
    { date: new Date('2026-09-08'), name: '中秋節後一日' },
    { date: new Date('2026-10-01'), name: '國慶日' },
    { date: new Date('2026-10-14'), name: '重陽節' },
    { date: new Date('2026-12-25'), name: '聖誕節' },
    { date: new Date('2026-12-26'), name: '聖誕節後一日' },
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
