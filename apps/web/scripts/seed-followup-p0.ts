/**
 * ★ cwi-followup-p0-20260915（S0）：dev fixture — 3 公司 + Clinic 映射 + VISIT_REASON 字典 + dev external key
 *
 * 背景：wa-clinic-inbox-followup-v2 §1（P0 資料層對齊）。CWM dev DB 原本只 1 條
 * E2E26 fixture company；本單要「公司同步」e2e 有真數據：
 *   - 3 公司（菁薈/臻善/匯樂 — 同 W dev Part A fixture name 一字一樣，S5 data migration 按 name 對應）
 *   - Clinic 映射（對齊 W Part A dev fixture：TY=菁薈 / YMT,TW,MF=臻善 / TKW,YL,WTC=匯樂；WTC dev-only）
 *   - VISIT_REASON 字典 10 條（MD §0.4 實測 code；dev 無 APRICOT credential，seed 代替 nightly sync）
 *   - ExternalApiKey dev 行（wa-inbox-dev，scopes: org+bookings）— dev 無 APRICOT credential，
 *     真机 e2e（S2 contract 以外嘅 cross-repo 驗證）要過關。key 係固定 dev 值（127.0.0.1 専用）。
 *
 * 用法（idempotent — 可重複跑，upsert by fixed id / apricotId）：
 *   env DATABASE_URL=postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce \
 *     npx tsx scripts/seed-followup-p0.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'

const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')

// ── 固定 id（cuid 形 25 lowercase alnum — 同 repo 其他 fixture 慣例）──────────
const COMP = {
  A: 'fup0cmpa0000000000000000001', // 菁薈
  B: 'fup0cmpb0000000000000000002', // 臻善
  C: 'fup0cmpc0000000000000000003', // 匯樂
}
const CLN = {
  TY: 'fup0tycl0000000000000000001',
  YMT: 'fup0ymtc0000000000000000002',
  TKW: 'fup0tkwc0000000000000000003',
  YL: 'fup0ylcl0000000000000000004',
  WTC: 'fup0wtcl0000000000000000005',
  // 現有 dev clinic（e2erecon fixture）— 只 update companyId，唔造新行
  MF: 'e2ereconclmf00000000002',
  TW: 'e2ereconcltw00000000001',
}

const COMPANIES = [
  { id: COMP.A, name: '菁薈', clinics: ['TY'] },
  { id: COMP.B, name: '臻善', clinics: ['YMT', 'TW', 'MF'] },
  { id: COMP.C, name: '匯樂', clinics: ['TKW', 'YL', 'WTC'] },
]

// MD §0.4 實測十個 code（dev 無 APRICOT credential — seed 代替 nightly sync）
const VISIT_REASONS: { code: string; des: string }[] = [
  { code: '0008', des: 'SP' },
  { code: '0009', des: 'INV RV' },
  { code: '0010', des: 'CHECK UP' },
  { code: '0012', des: 'FILLING' },
  { code: '0013', des: 'IMPLANT RV' },
  { code: '0017', des: 'EXTRACTION' },
  { code: '0021', des: 'CONSULTATION' },
  { code: '0042', des: 'RETAINTER DELIVER' },
  { code: '0045', des: 'INV REFINEMENT(1)' },
  { code: '0056', des: 'DEBOND' },
]

// ── dev external key（固定值 — 127.0.0.1 dev 専用，唔係生產 secret；
//    W dev .env WORKFORCE_API_KEY 用同一條 plaintext）──────────────────────
const DEV_KEY_PLAINTEXT = 'wfi-dev-9f2c7a1e4b8d3f6a0c5e9b2d7f1a4c8e6b0d3f7a2c5e8b1d4f9a0c3e6b8d2f5a'
const DEV_KEY_ROW = {
  id: 'fup0extk0000000000000000001',
  name: 'wa-inbox-dev',
  keyHash: createHash('sha256').update(DEV_KEY_PLAINTEXT, 'utf8').digest('hex'),
  scopes: ['org', 'bookings'],
  active: true,
}

/** DRY-RUN 守衛：dry 時只 log 唔寫 DB（冪等 upsert — dry-run 後真跑結果相同） */
async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  if (DRY) {
    console.log(`  [dry] ${label}`)
    return
  }
  await fn()
  console.log(`  ${label}`)
}

async function main() {
  console.log(`[seed-followup-p0] ${DRY ? 'DRY-RUN' : 'APPLY'}`)

  // 1) 公司（upsert by id — name 同步刷，防手改過舊名）
  for (const c of COMPANIES) {
    await run(`company ${c.name} (${c.id})`, () =>
      prisma.company.upsert({
        where: { id: c.id },
        update: { name: c.name },
        create: { id: c.id, name: c.name },
      }),
    )
  }

  // 2) 新 clinic（5 間）+ 現有 MF/TW 填 companyId
  const newClinics: { id: string; code: string; comp: string }[] = [
    { id: CLN.TY, code: 'TY', comp: COMP.A },
    { id: CLN.YMT, code: 'YMT', comp: COMP.B },
    { id: CLN.TKW, code: 'TKW', comp: COMP.C },
    { id: CLN.YL, code: 'YL', comp: COMP.C },
    { id: CLN.WTC, code: 'WTC', comp: COMP.C },
  ]
  for (const c of newClinics) {
    await run(`clinic ${c.code} → ${c.comp}`, () =>
      prisma.clinic.upsert({
        where: { id: c.id },
        update: { shortName: c.code, companyId: c.comp },
        create: { id: c.id, name: `${c.code} 診所（followup fixture）`, shortName: c.code, companyId: c.comp },
      }),
    )
  }
  for (const [id, code, comp] of [[CLN.MF, 'MF', COMP.B], [CLN.TW, 'TW', COMP.B]] as const) {
    const ex = await prisma.clinic.findUnique({ where: { id } })
    if (!ex) throw new Error(`現有 clinic ${code} (${id}) 唔存在 — dev DB 被清過？`)
    await run(`clinic ${code}（現有）→ ${comp}`, () => prisma.clinic.update({ where: { id }, data: { companyId: comp } }))
  }

  // 3) VISIT_REASON 字典（upsert by apricotId — 冪等；syncedAt = 而家）
  const now = new Date()
  for (const r of VISIT_REASONS) {
    const apricotId = `fix0000000000000000${r.code}` // 24 字定長（同 Apricot ObjectId 長）
    await run(`dict VISIT_REASON ${r.code} ${r.des}`, () =>
      prisma.apricotDictionary.upsert({
        where: { apricotId },
        update: { kind: 'VISIT_REASON', code: r.code, des: r.des, isRemoved: false, syncedAt: now },
        create: { kind: 'VISIT_REASON', apricotId, code: r.code, des: r.des, isRemoved: false, syncedAt: now },
      }),
    )
  }

  // 4) dev external key（upsert by id — hash 只存 sha256）
  await run(`external key wa-inbox-dev (scopes: ${DEV_KEY_ROW.scopes.join(',')})`, () =>
    prisma.externalApiKey.upsert({
      where: { id: DEV_KEY_ROW.id },
      update: { name: DEV_KEY_ROW.name, scopes: DEV_KEY_ROW.scopes, active: true },
      create: DEV_KEY_ROW,
    }),
  )
}

main()
  .then(() => console.log('[seed-followup-p0] done'))
  .catch((e) => {
    console.error('[seed-followup-p0] FAIL', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
