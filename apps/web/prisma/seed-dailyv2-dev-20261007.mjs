// ★ cwm-dailyv2-20261007 — DEV-ONLY fixture（唔跑喺正式機）
//
// 每日大數五項驗收用嘅最小數據：
//   - 診所 TW（apricotClinicId='TW'）+ TW2（403 跨店測試用，冇數據）
//   - 醫生 謝德輝／何嘉俊 + Apricot PROVIDER 帳號
//   - 2026-05-10 收款：謝德輝 Master $4,000（2% 費）＋ Cash $500；何嘉俊 Master $3,980（2% 費）
//     → Master 合 $7,980、費 $159.60、淨 $7,820.40（MD ⑤ 驗收數）
//   - 帳號：
//       OWNER  95000000 / owner-dv-2026   （clinics: TW, TW2）
//       KIOSK  95000001 / kiosk-tw-2026   （clinics: TW — 店舖帳號）
//       EMPLOYEE 95000002 / nurse-tw-2026（clinics: TW，護士核對 nurse 選項）
//
// 跑法: npx tsx prisma/seed-dailyv2-dev-20261007.mjs（冪等，upsert）
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const HK = 'Asia/Hong_Kong'
const ts = (s) => new Date(`${s}T12:00:00+08:00`)

async function main() {
  // ── 診所 ─────────────────────────────────────────────────────
  const tw = await prisma.clinic.upsert({
    where: { id: 'dailyv2tw000000000000000001' },
    update: { name: 'TW 診所', shortName: 'TW', apricotClinicId: 'TW' },
    create: { id: 'dailyv2tw000000000000000001', name: 'TW 診所', shortName: 'TW', apricotClinicId: 'TW' },
  })
  const tw2 = await prisma.clinic.upsert({
    where: { id: 'dailyv2tw2000000000000000002' },
    update: { name: 'TW2 診所（跨店測試）', shortName: 'TW2', apricotClinicId: 'TW2' },
    create: { id: 'dailyv2tw2000000000000000002', name: 'TW2 診所（跨店測試）', shortName: 'TW2', apricotClinicId: 'TW2' },
  })

  // ── 醫生 + Apricot 帳號 ──────────────────────────────────────
  const xdh = await prisma.provider.upsert({
    where: { id: 'dailyv2dh0000000000000000001' },
    update: { name: '謝德輝', nameZh: 'Xie Dehui' },
    create: { id: 'dailyv2dh0000000000000000001', name: '謝德輝', nameZh: 'Xie Dehui' },
  })
  const hjj = await prisma.provider.upsert({
    where: { id: 'dailyv2hj0000000000000000001' },
    update: { name: '何嘉俊', nameZh: 'He Kahun' },
    create: { id: 'dailyv2hj0000000000000000001', name: '何嘉俊', nameZh: 'He Kahun' },
  })
  await prisma.apricotPractitioner.upsert({
    where: { apricotId: 'tw-xdh-001' },
    update: { name: 'Xie Dehui', kind: 'PROVIDER', providerId: xdh.id },
    create: { apricotId: 'tw-xdh-001', name: 'Xie Dehui', kind: 'PROVIDER', providerId: xdh.id },
  })
  await prisma.apricotPractitioner.upsert({
    where: { apricotId: 'tw-hjj-001' },
    update: { name: 'He Kahun', kind: 'PROVIDER', providerId: hjj.id },
    create: { apricotId: 'tw-hjj-001', name: 'He Kahun', kind: 'PROVIDER', providerId: hjj.id },
  })

  // ── 2026-05-10 收款（HK 日）──────────────────────────────────
  // MD ⑤ 驗收：Master $7,980 → 手續費 $159.60（2%）、淨額 $7,820.40
  // MD ④ 驗收：謝德輝 Master $4,000、何嘉俊 Master $3,980
  const paidAt = ts('2026-05-10')
  const allocs = [
    { paymentExtId: 'dv-p-0510-1', billExtId: 'dv-b-0510-1', providerExtId: 'tw-xdh-001', methodNorm: 'Master', amount: 4000, fee: 2, net: 3920 },
    { paymentExtId: 'dv-p-0510-2', billExtId: 'dv-b-0510-2', providerExtId: 'tw-hjj-001', methodNorm: 'Master', amount: 3980, fee: 2, net: 3900.4 },
    { paymentExtId: 'dv-p-0510-3', billExtId: 'dv-b-0510-3', providerExtId: 'tw-xdh-001', methodNorm: 'Cash', amount: 500, fee: 0, net: 500 },
  ]
  for (const a of allocs) {
    await prisma.paymentAllocation.upsert({
      where: { paymentExtId_billExtId_methodNorm: { paymentExtId: a.paymentExtId, billExtId: a.billExtId, methodNorm: a.methodNorm } },
      update: {},
      create: {
        paymentExtId: a.paymentExtId, billExtId: a.billExtId, providerExtId: a.providerExtId, methodNorm: a.methodNorm,
        amount: a.amount, netAmount: a.net, feePercentUsed: a.fee,
        clinicExtId: 'TW',
        paidAt,
        periodMonth: '2026-05',
        countAsIncome: true,
        allocationMode: 'DIRECT',
      },
    })
  }

  // ── 帳號 ─────────────────────────────────────────────────────
  const mkUser = async (id, phone, name, password, role, clinicIds) => {
    const u = await prisma.user.upsert({
      where: { phone },
      update: { name, role, password: await bcrypt.hash(password, 10) },
      create: { id, phone, name, password: await bcrypt.hash(password, 10), role, status: 'ACTIVE' },
    })
    for (const cid of clinicIds) {
      await prisma.userClinic.upsert({
        where: { userId_clinicId: { userId: u.id, clinicId: cid } },
        update: {},
        create: { userId: u.id, clinicId: cid },
      })
    }
    return u
  }
  const owner = await mkUser('dailyv2ow00000000000000001', '95000000', 'Dev Owner (dailyv2)', 'owner-dv-2026', 'OWNER', [tw.id, tw2.id])
  const kiosk = await mkUser('dailyv2ki00000000000000001', '95000001', 'TW 店舖帳號', 'kiosk-tw-2026', 'KIOSK', [tw.id])

  // 護士（nurse 選項 + 核對護士）
  const nurseUser = await mkUser('dailyv2ns00000000000000001', '95000002', 'TW 護士王', 'nurse-tw-2026', 'EMPLOYEE', [tw.id])
  await prisma.employee.upsert({
    where: { userId: nurseUser.id },
    update: { homeClinicId: tw.id },
    create: {
      userId: nurseUser.id, homeClinicId: tw.id, joinDate: ts('2026-01-01'),
      clinics: { create: { clinicId: tw.id } },
    },
  })

  console.log('✅ cwm-dailyv2 dev fixture ready')
  console.log(`   clinic TW   = ${tw.id}`)
  console.log(`   clinic TW2  = ${tw2.id}`)
  console.log('   login: OWNER 95000000/owner-dv-2026 | KIOSK 95000001/kiosk-tw-2026 | EMPLOYEE 95000002/nurse-tw-2026')
}

main().then(async () => { await prisma.$disconnect() }).catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
