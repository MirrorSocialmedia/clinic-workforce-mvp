/**
 * ★ cw-pa: dev-only — seed 合成 production replica rows 入 dev DB (15532)。
 * 用途：P2 驗收矩陣 / P3 internal API / P4 UI 回归嘅離線 harness。
 * ★ 全部係合成數據（本環境無法讀 production DB — 見 P2 報告）；
 *   apricotId 用 spec 實見值（LAU/YEUNG/TONG/MF Clinic）令 unknown-practitioner
 *   行為同生產一致。
 * 幂等：先刪 syn-* rows 再插。
 *
 * 跑法（dev DB 15532 要已起）：
 *   cd apps/web && set -a && . ./.env.development && set +a
 *   npx tsx scripts/seed-dev-availability.ts base    # 6 clinics + 6 providers + mock APRICOT credential
 *   npx tsx scripts/seed-dev-availability.ts +lau    # base + LAU（補 apricotId 場景）
 *   npx tsx scripts/seed-dev-availability.ts clean   # 刪晒 syn rows + mock credential
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// mock credential：cipherText 唔係真 AES 密文 — 只係讓 P3 驗證 credential lookup 路徑存在。
// 真 token 永遠由生產加密憑證嚟，dev 呢度只用 mock。
const MOCK_CRED = { provider: 'APRICOT', cipherText: 'dev-mock-not-real-credential' } as const

// 六間診所（仿真實 6 間；青衣 = 無 apricotClinicId → §2.2 skip）
const CLINICS = [
  { id: 'syn-clinic-wong', name: '旺角診所', shortName: '旺', apricotClinicId: 'syn-clinic-001' },
  { id: 'syn-clinic-yau', name: '油尖診所', shortName: '仁', apricotClinicId: 'syn-clinic-002' },
  { id: 'syn-clinic-lai', name: '銅鑼灣診所', shortName: '銅', apricotClinicId: 'syn-clinic-003' },
  { id: 'syn-clinic-tsuen', name: '荃灣診所', shortName: '荃', apricotClinicId: 'syn-clinic-004' },
  { id: 'syn-clinic-yuen', name: '元朗診所', shortName: '元', apricotClinicId: 'syn-clinic-005' },
  { id: 'syn-clinic-tsing', name: '青衣診所', shortName: '青', apricotClinicId: null }, // ★ 青衣
]

// 已知六個（memory: HO/MA/TSE/YIU/TONG/AEGIS）— TONG 用 spec 實見 apricotId
const PROVIDERS_BASE = [
  { id: 'syn-prov-ho', name: 'Dr. Ho', shortName: 'HO', apricotId: '69a000000000000000000001', color: '#f44336' },
  { id: 'syn-prov-ma', name: 'Dr. Ma', shortName: 'MA', apricotId: '69a000000000000000000002', color: '#2196f3' },
  { id: 'syn-prov-tse', name: 'Dr. Tse', shortName: 'TSE', apricotId: '69a000000000000000000003', color: '#4caf50' },
  { id: 'syn-prov-yiu', name: 'Dr. Yiu', shortName: 'YIU', apricotId: '69a0000000000000000000004', color: '#ff9800' },
  { id: 'syn-prov-tong', name: 'Dr. Tong', shortName: 'TONG', apricotId: '695ff0c999883d05d0582401', color: '#9c27b0' }, // ★ spec §2.1 實見
  { id: 'syn-prov-aegis', name: 'Dr. Aegis', shortName: 'AEGIS', apricotId: '69a000000000000000000006', color: '#607d8b' },
]

// Run B 先插（§2.1 補 apricotId 場景）— LAU 用 spec 實見 apricotId
const PROVIDER_LAU = { id: 'syn-prov-lau', name: 'Dr. Lau', shortName: 'LAU', apricotId: '695e6e511e430c48022a7690', color: '#00bcd4' }

async function main() {
  const mode = process.argv[2] ?? 'base' // base | +lau | clean

  // clean: 刪晒 syn rows
  await prisma.providerBooking.deleteMany({ where: { clinicId: { startsWith: 'syn-clinic' } } })
  await prisma.providerAvailability.deleteMany({ where: { clinicId: { startsWith: 'syn-clinic' } } })
  await prisma.clinic.deleteMany({ where: { id: { startsWith: 'syn-clinic' } } })
  await prisma.provider.deleteMany({ where: { id: { startsWith: 'syn-prov' } } })

  if (mode === 'clean') {
    // 只刪 mock credential（精確 match cipherText，唔會誤刪 P3 寫入嘅其他 dev credential）
    await prisma.externalCredential.deleteMany({ where: { provider: MOCK_CRED.provider, cipherText: MOCK_CRED.cipherText } })
    console.log('[seed] clean done')
    await prisma.$disconnect()
    return
  }

  for (const c of CLINICS) {
    await prisma.clinic.upsert({ where: { id: c.id }, update: {}, create: c })
  }
  for (const p of PROVIDERS_BASE) {
    await prisma.provider.upsert({
      where: { id: p.id },
      update: {},
      create: { ...p, isActive: true, sortOrder: 0 },
    })
  }
  if (mode === '+lau') {
    await prisma.provider.upsert({
      where: { id: PROVIDER_LAU.id },
      update: {},
      create: { ...PROVIDER_LAU, isActive: true, sortOrder: 9 },
    })
    console.log('[seed] +lau added (LAU apricotId now known)')
  }

  // mock ExternalCredential（base 模式）— P3 credential lookup 路徑回归用
  await prisma.externalCredential.upsert({
    where: { provider: MOCK_CRED.provider },
    update: {},
    create: { provider: MOCK_CRED.provider, cipherText: MOCK_CRED.cipherText },
  })

  const [cl, pr, cr] = await Promise.all([
    prisma.clinic.count({ where: { id: { startsWith: 'syn-clinic' } } }),
    prisma.provider.count({ where: { id: { startsWith: 'syn-prov' } } }),
    prisma.externalCredential.count({ where: { provider: MOCK_CRED.provider } }),
  ])
  console.log(`[seed] mode=${mode} clinics=${cl} providers=${pr} mockCreds=${cr}`)
  await prisma.$disconnect()
}

main().then(() => process.exit(0)).catch((e) => { console.error('[seed] FATAL', e); process.exit(1) })
