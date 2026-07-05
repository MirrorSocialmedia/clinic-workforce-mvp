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
