/**
 * ★ cwi-followup-p4-20260916（S1）：dev seed — ClinicalTermMap 術語表 + ClinicalRxCode 藥物 code
 *
 * 背景：MD §5.2 樣本（x→拔牙 / rsd→牙根刮治 / br→牙橋 / implant→植牙 / SP→洗牙 / INV→隱形牙箍…）
 *   + MD 三實測樣本嘅療程詞（FILLING / FILL / BLEACHING / DURAPHAT / ANTI SNORING DEVICE）—
 *   quote-parser 確定性層 unit test 要呢啲詞喺表入面先抽到（TCA 係 parser 意向詞規則，唔落表）。
 * ClinicalRxCode：rxCodes 抽取 + C 類抗生素判定（dev 無 Apricot 藥物字典 — seed 代替）。
 *
 * 用法（idempotent — upsert by shorthand / code）：
 *   env DATABASE_URL=postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce \
 *     npx tsx scripts/seed-followup-p4.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')

// ── MD §5.2 樣本 + 三實測樣本療程詞 ──────────────────────────────────────
const TERMS: { shorthand: string; nameCn: string; nameEn: string; usedFor: string[] }[] = [
  { shorthand: 'x', nameCn: '拔牙', nameEn: 'extraction', usedFor: ['after_treatment', 'quote_extraction'] },
  { shorthand: 'rsd', nameCn: '牙根刮治', nameEn: 'root planing', usedFor: ['after_treatment'] },
  { shorthand: 'br', nameCn: '牙橋', nameEn: 'bridge', usedFor: ['quote_extraction'] },
  { shorthand: 'implant', nameCn: '植牙', nameEn: 'implant', usedFor: ['after_treatment', 'quote_extraction', 'recall'] },
  { shorthand: 'SP', nameCn: '洗牙', nameEn: 'scaling', usedFor: ['recall', 'quote_extraction'] },
  { shorthand: 'INV', nameCn: '隱形牙箍', nameEn: 'invisible aligner', usedFor: ['quote_extraction', 'recall'] },
  { shorthand: 'FILLING', nameCn: '補牙', nameEn: 'filling', usedFor: ['quote_extraction'] },
  { shorthand: 'FILL', nameCn: '補牙', nameEn: 'filling', usedFor: ['quote_extraction'] },
  { shorthand: 'BLEACHING', nameCn: '牙齒美白', nameEn: 'bleaching', usedFor: ['quote_extraction'] },
  { shorthand: 'DURAPHAT', nameCn: '氟保護漆 (DURAPHAT)', nameEn: 'duraphat', usedFor: ['quote_extraction'] },
  { shorthand: 'ANTI SNORING DEVICE', nameCn: '止鼾牙套', nameEn: 'anti snoring device', usedFor: ['quote_extraction'] },
]

// ── 藥物 code（抗生素判定用 — C 類）─────────────────────────────────────
const RX: { code: string; nameEn: string; nameCn: string; isAntibiotic: boolean }[] = [
  { code: 'AMOX', nameEn: 'AMOXICILLIN', nameCn: '阿莫西林', isAntibiotic: true },
  { code: 'METRO', nameEn: 'METRONIDAZOLE', nameCn: '甲硝唑', isAntibiotic: true },
  { code: 'CIPRO', nameEn: 'CIPROFLOXACIN', nameCn: '環丙沙星', isAntibiotic: true },
  { code: 'IBU', nameEn: 'IBUPROFEN', nameCn: '布洛芬', isAntibiotic: false },
  { code: 'PANADOL', nameEn: 'PANADOL', nameCn: '百多涼', isAntibiotic: false },
]

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  if (DRY) {
    console.log(`  [dry] ${label}`)
    return
  }
  await fn()
  console.log(`  ✓ ${label}`)
}

async function main(): Promise<void> {
  console.log(`seed-followup-p4 (dry=${DRY})`)
  for (const t of TERMS) {
    await run(`term ${t.shorthand} → ${t.nameCn}`, () =>
      prisma.clinicalTermMap.upsert({
        where: { shorthand: t.shorthand },
        create: { ...t },
        update: { nameCn: t.nameCn, nameEn: t.nameEn, usedFor: t.usedFor, active: true },
      })
    )
  }
  for (const r of RX) {
    await run(`rx ${r.code} (${r.nameEn})${r.isAntibiotic ? ' [antibiotic]' : ''}`, () =>
      prisma.clinicalRxCode.upsert({
        where: { code: r.code },
        create: { ...r },
        update: { nameEn: r.nameEn, nameCn: r.nameCn, isAntibiotic: r.isAntibiotic, active: true },
      })
    )
  }
  const tc = await prisma.clinicalTermMap.count()
  const rc = await prisma.clinicalRxCode.count()
  console.log(`done — ClinicalTermMap=${tc} ClinicalRxCode=${rc}`)
}

main()
  .catch((e) => {
    console.error('seed failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
