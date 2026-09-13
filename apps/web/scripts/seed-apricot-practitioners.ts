/**
 * ★ cwm-apricotacct-20260913：把現有 Provider.apricotId 搬入 ApricotPractitioner，
 *   再補七個已查實但從未入表嘅帳號。
 *
 * 用法（先 dry-run）：
 *   docker compose -p clinic -f docker-compose.yml exec app \
 *     npx tsx scripts/seed-apricot-practitioners.ts --dry-run
 *   docker compose -p clinic -f docker-compose.yml exec app \
 *     npx tsx scripts/seed-apricot-practitioners.ts
 *
 * ★ 可以重複跑（upsert by apricotId）。
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')

// ★ 用【實際 id】唔用 name —— 對名差一個空格就會靜靜插入孤兒。
//   以下 id 由 2026-09-13 生產 SELECT 抄出，落刀前請再對一次。
const P_HO_KA_CHUN = 'cmsqaw678005lpo01ft8vpkrl'   // 何嘉俊醫生
const C_TAI_WAI    = 'cmrt63o2q000pqz01543wflo9'   // 大圍
const C_YMT        = 'cmrt62vci000lqz01rgzifpyt'   // 油麻地
const C_MF         = 'cmrt61dy8000hqz01wml1grlv'   // 美孚

const EXTRA: Array<{
  apricotId: string; name: string
  kind: 'PROVIDER' | 'CLINIC' | 'UNKNOWN'
  providerId?: string; clinicId?: string; note?: string
}> = [
  { apricotId: '695e722546903e64fc2c3ae0', name: '何嘉俊醫生', kind: 'PROVIDER',
    providerId: P_HO_KA_CHUN, note: '第二 Apricot 帳號（元朗用）' },
  { apricotId: '696783e206aa7500097b2e64', name: 'TW Clinic',  kind: 'CLINIC', clinicId: C_TAI_WAI },
  { apricotId: '695ff0c999883d05d05823ff', name: 'YMT Clinic', kind: 'CLINIC', clinicId: C_YMT },
  { apricotId: '696604810fb31f000937a8c4', name: 'MF Clinic',  kind: 'CLINIC', clinicId: C_MF },
  // ★★★ 通用 Clinic：clinicId 一定要 undefined（存 null）
  { apricotId: '695e6e511e430c48022a768b', name: 'Clinic', kind: 'CLINIC',
    note: '通用診所帳號 —— 每間店同一個 ID，實際診所跟 allocation 嘅 clinicExtId' },
  { apricotId: '695fe70d96788729a818cc02', name: '(未知)', kind: 'UNKNOWN',
    note: '2026-09-13：Apricot 下拉揾唔到，老細確認係員工失誤' },
]

async function main() {
  // ① 由現有 Provider.apricotId 搬（何柏晞會自動包括在內）
  const providers = await prisma.provider.findMany({
    where: { apricotId: { not: null } },
    select: { id: true, name: true, apricotId: true },
  })
  console.log(`① 由 Provider 搬 ${providers.length} 個帳號`)
  for (const p of providers) {
    console.log(`   ${p.apricotId}  ${p.name}`)
    if (!DRY) {
      await prisma.apricotPractitioner.upsert({
        where: { apricotId: p.apricotId! },
        create: { apricotId: p.apricotId!, name: p.name, kind: 'PROVIDER', providerId: p.id },
        update: { name: p.name, kind: 'PROVIDER', providerId: p.id },
      })
    }
  }

  // ② 補七個已查實帳號 —— 先驗 provider/clinic 真係存在
  console.log(`\n② 補 ${EXTRA.length} 個已查實帳號`)
  for (const e of EXTRA) {
    if (e.providerId) {
      const ok = await prisma.provider.findUnique({ where: { id: e.providerId }, select: { name: true } })
      if (!ok) { console.error(`   ❌ providerId ${e.providerId} 唔存在 — 中止`); process.exit(1) }
      console.log(`   ${e.apricotId}  ${e.name}  → 醫生 ${ok.name}`)
    } else if (e.clinicId) {
      const ok = await prisma.clinic.findUnique({ where: { id: e.clinicId }, select: { name: true } })
      if (!ok) { console.error(`   ❌ clinicId ${e.clinicId} 唔存在 — 中止`); process.exit(1) }
      console.log(`   ${e.apricotId}  ${e.name}  → 診所 ${ok.name}`)
    } else {
      console.log(`   ${e.apricotId}  ${e.name}  → ${e.kind}（唔綁）`)
    }
    if (!DRY) {
      await prisma.apricotPractitioner.upsert({
        where: { apricotId: e.apricotId },
        create: { apricotId: e.apricotId, name: e.name, kind: e.kind,
                  providerId: e.providerId ?? null, clinicId: e.clinicId ?? null, note: e.note ?? null },
        update: { name: e.name, kind: e.kind,
                  providerId: e.providerId ?? null, clinicId: e.clinicId ?? null, note: e.note ?? null },
      })
    }
  }

  // ③ 有冇 allocation 嘅 providerExtId 落空
  const orphans = await prisma.$queryRaw<Array<{ providerExtId: string }>>`
    SELECT DISTINCT pa."providerExtId"
    FROM "PaymentAllocation" pa
    WHERE pa."isVoid" = false AND pa."isSuperseded" = false
      AND NOT EXISTS (SELECT 1 FROM "ApricotPractitioner" ap WHERE ap."apricotId" = pa."providerExtId")
  `
  console.log(`\n③ 未綁 providerExtId：${orphans.length} 個`)
  orphans.forEach(o => console.log(`   ⚠️ ${o.providerExtId}`))

  console.log(DRY ? '\n🔸 DRY RUN — 乜都冇寫' : '\n✅ 完成')
}
main().finally(() => prisma.$disconnect())
