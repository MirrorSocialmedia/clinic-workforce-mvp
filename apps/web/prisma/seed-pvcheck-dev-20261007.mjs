// ★ cwm-pvcheck-20261007 — DEV-ONLY fixture（唔跑喺正式機）
//
// 醫生月結預視「就地核對」＋每日大數帶醫生 驗收用最小數據：
//   - 診所 TW（apricotClinicId='6655…cc01'）+ HC（'6655…cc09'，冇數據）
//   - 醫生 謝德輝／何嘉俊 + Apricot PROVIDER 帳號
//   - 2026-09 收款（TW）：
//       09-02～09-08：謝德輝 Master $4,000 ＋ 何嘉俊 Master $3,000 → 全店 $7,000／日（7 日 UNCHECKED）
//       09-09：謝德輝 Cash $1,000 ＋ 何嘉俊 FREE_SP $500 → 全店 $1,000（UNCHECKED）
//       09-10：謝德輝 FREE_SP $800（countAsIncome=false）→ 全店 $0 → 預視該日 status=NONE（無核對掣）
//   - 2026-10 收款（TW，驗「未來日期無掣」）：
//       10-01～10-06：謝德輝 Master $3,500／日（過咗，有掣）
//       10-08、10-09：謝德輝 Master $3,500／日（未到，無掣）
//   - 帳號：
//       OWNER    95000000 / owner-pv-2026  （clinics: TW, HC）
//       KIOSK    95000001 / kiosk-pv-2026  （clinics: TW — 店舖帳號）
//       EMPLOYEE 95000002 / nurse-pv-2026  （clinics: TW，護士核對 nurse 選項）
//
// 跑法: npx tsx prisma/seed-pvcheck-dev-20261007.mjs（冪等，upsert）
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const ts = (s) => new Date(`${s}T12:00:00+08:00`)

async function main() {
  // ── 診所 ─────────────────────────────────────────────────────
  const tw = await prisma.clinic.upsert({
    where: { id: 'pvchk tw0000000000000000001' },
    update: { name: 'TW 診所', shortName: 'TW', apricotClinicId: '66554433221100ffeeddcc01' },
    create: { id: 'pvchk tw0000000000000000001', name: 'TW 診所', shortName: 'TW', apricotClinicId: '66554433221100ffeeddcc01' },
  })
  const hc = await prisma.clinic.upsert({
    where: { id: 'pvchk hc0000000000000000001' },
    update: { name: 'HC 診所（第二間）', shortName: 'HC', apricotClinicId: '66554433221100ffeeddcc09' },
    create: { id: 'pvchk hc0000000000000000001', name: 'HC 診所（第二間）', shortName: 'HC', apricotClinicId: '66554433221100ffeeddcc09' },
  })

  // ── 醫生 + Apricot 帳號 ──────────────────────────────────────
  const xdh = await prisma.provider.upsert({
    where: { id: 'pvchk dh0000000000000000001' },
    update: { name: '謝德輝', nameZh: 'Xie Dehui' },
    create: { id: 'pvchk dh0000000000000000001', name: '謝德輝', nameZh: 'Xie Dehui' },
  })
  const hjj = await prisma.provider.upsert({
    where: { id: 'pvchk hj0000000000000000001' },
    update: { name: '何嘉俊', nameZh: 'He Kahun' },
    create: { id: 'pvchk hj0000000000000000001', name: '何嘉俊', nameZh: 'He Kahun' },
  })
  await prisma.apricotPractitioner.upsert({
    where: { apricotId: 'pv-xdh-001' },
    update: { name: 'Xie Dehui', kind: 'PROVIDER', providerId: xdh.id },
    create: { apricotId: 'pv-xdh-001', name: 'Xie Dehui', kind: 'PROVIDER', providerId: xdh.id },
  })
  await prisma.apricotPractitioner.upsert({
    where: { apricotId: 'pv-hjj-001' },
    update: { name: 'He Kahun', kind: 'PROVIDER', providerId: hjj.id },
    create: { apricotId: 'pv-hjj-001', name: 'He Kahun', kind: 'PROVIDER', providerId: hjj.id },
  })

  // ── 收款（PaymentAllocation DIRECT；HK 日 paidAt）──────────────
  await prisma.paymentAllocation.deleteMany({ where: { clinicExtId: '66554433221100ffeeddcc01' } }) // 冪等
  const TW_EXT = '66554433221100ffeeddcc01'
  const M = (amount) => ({ fee: 2, net: Math.round(amount * 0.98 * 100) / 100 })
  const A = (paymentExtId, billExtId, providerExtId, method, amount, paidAt, periodMonth, countAsIncome = true) => {
    const f = method === 'Master' ? M(amount) : { fee: 0, net: amount }
    return prisma.paymentAllocation.upsert({
      where: { paymentExtId_billExtId_methodNorm: { paymentExtId, billExtId, methodNorm: method } },
      update: {},
      create: {
        paymentExtId, billExtId, providerExtId, methodNorm: method,
        amount, netAmount: f.net, feePercentUsed: f.fee,
        clinicExtId: TW_EXT, paidAt: ts(paidAt), periodMonth, countAsIncome, allocationMode: 'DIRECT',
      },
    })
  }
  const allocs = []
  for (let d = 2; d <= 8; d++) { // 09-02～09-08：全店 $7,000／日
    const s = `09-${String(d).padStart(2, '0')}`
    allocs.push(A(`pv-p-${s}-1`, `pv-b-${s}-1`, 'pv-xdh-001', 'Master', 4000, `2026-${s}`, '2026-09'))
    allocs.push(A(`pv-p-${s}-2`, `pv-b-${s}-2`, 'pv-hjj-001', 'Master', 3000, `2026-${s}`, '2026-09'))
  }
  // 09-09：全店 $1,000（FREE_SP 唔計入全店）
  allocs.push(A('pv-p-09-09-1', 'pv-b-09-09-1', 'pv-xdh-001', 'Cash', 1000, '2026-09-09', '2026-09'))
  allocs.push(A('pv-p-09-09-2', 'pv-b-09-09-2', 'pv-hjj-001', 'FREE_SP', 500, '2026-09-09', '2026-09', false))
  // 09-10：全店 $0（只有 FREE_SP）→ 預視該日 NONE
  allocs.push(A('pv-p-09-10-1', 'pv-b-09-10-1', 'pv-xdh-001', 'FREE_SP', 800, '2026-09-10', '2026-09', false))
  // 2026-10：10-01～10-06 過咗；10-08、10-09 未到（驗「未來日期無掣」）
  for (const d of ['01', '02', '03', '04', '05', '06', '08', '09']) {
    allocs.push(A(`pv-p-10-${d}-1`, `pv-b-10-${d}-1`, 'pv-xdh-001', 'Master', 3500, `2026-10-${d}`, '2026-10'))
  }
  await Promise.all(allocs)

  // ── 拆帳 %（預視必需：冇 Commission → PAYOUT_NO_COMMISSION 400）──────
  await prisma.providerCommission.deleteMany({ where: { providerId: { in: [xdh.id, hjj.id] } } }) // 冪等
  for (const p of [xdh, hjj]) {
    await prisma.providerCommission.create({
      data: {
        providerId: p.id, clinicId: tw.id, percent: 40, basis: 'GROSS',
        effectiveFrom: ts('2026-01-01'), isActive: true, createdBy: 'pvchk ow0000000000000000001',
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
  await mkUser('pvchk ow0000000000000000001', '95000000', 'PV Owner', 'owner-pv-2026', 'OWNER', [tw.id, hc.id])
  await mkUser('pvchk ki0000000000000000001', '95000001', 'TW 店舖帳號', 'kiosk-pv-2026', 'KIOSK', [tw.id])
  const nurse = await mkUser('pvchk ns0000000000000000001', '95000002', 'TW 護士陳', 'nurse-pv-2026', 'EMPLOYEE', [tw.id])
  await prisma.employee.upsert({
    where: { userId: nurse.id },
    update: { homeClinicId: tw.id },
    create: {
      userId: nurse.id, homeClinicId: tw.id, joinDate: ts('2026-01-01'),
      clinics: { create: { clinicId: tw.id } },
    },
  })

  console.log('✅ cwm-pvcheck dev fixture ready')
  console.log(`   clinic TW = ${tw.id} | clinic HC = ${hc.id}`)
  console.log(`   provider 謝德輝 = ${xdh.id} | 何嘉俊 = ${hjj.id}`)
  console.log('   login: OWNER 95000000/owner-pv-2026 | KIOSK 95000001/kiosk-pv-2026 | EMPLOYEE 95000002/nurse-pv-2026')
  console.log('   2026-09: 09-02~08 全店$7,000/日 · 09-09 $1,000 · 09-10 NONE(FREE_SP only)')
  console.log('   2026-10: 10-01~06 有數（過咗）· 10-08/09 有數（未到）')
}

main().then(async () => { await prisma.$disconnect() }).catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
