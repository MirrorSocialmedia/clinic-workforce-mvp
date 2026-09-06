/**
 * cwm-excessrest-20260907 — #23 BEFORE capture（改 engine 前跑，生死格基準）
 * Run: npx tsx scripts/e2erx-before-capture.ts
 */
import fs from 'node:fs'
import { buildCohort, captureCohort, sweepCohort, PFX } from './emp-caldayratio-shared'

async function main() {
  const outPath = '/tmp/emp-excessrest-before.json'
  const ids = await buildCohort()
  const cap = await captureCohort(ids)
  await sweepCohort(PFX)
  fs.writeFileSync(outPath, JSON.stringify({ pfx: PFX, month: '2026-09', capturedAt: new Date().toISOString(), results: cap }, null, 2))
  console.log(`BEFORE capture 完成 → ${outPath}（${Object.keys(cap).length} 員工，fixture 已 sweep）`)
  for (const [k, v] of Object.entries(cap)) {
    const d: any = v
    console.log(`  ${k}: basePay=${d.basePay} grossPay=${d.detail?.grossPay} mpf=${d.detail?.mpf} netPay=${d.detail?.netPay}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
