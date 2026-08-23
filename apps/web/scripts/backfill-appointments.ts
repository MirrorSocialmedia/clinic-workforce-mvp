/**
 * ★ cwc-rdchain-20260823-b1: Backfill 一次性 CLI（read-chain MD §3.3）
 *
 * 範圍 -24 個月 → -7，逐月逐店，經同一把 withApricotLock 慢拉（夜晚行）；
 * 只餵 AppointmentIndex + PatientIndex（唔掂 AvailabilityCache）。
 * **冪等 upsert（apricotApptId 鍵）— 可中斷重跑**：中途 fail/人手 kill 都直接
 * 重跑本 script，已完成嘅行會被原樣覆寫。
 *
 * 跑法（夜晚）：
 *   cd apps/web
 *   set -a && . ./.env.development && set +a \
 *     && npx tsx scripts/backfill-appointments.ts
 *
 * 完成 log 統計：總單數（AppointmentIndex）／病人數（PatientIndex）／耗時。
 * 任一批 fail → exit 1（重跑即可）。
 */
import { runAppointmentIndexBackfill } from '../src/lib/apricot/backfill-appointments'

async function main(): Promise<void> {
  console.log('[backfill-appointments] 開始（範圍 -24 個月 → -7，逐月逐店，同一把 lock 慢拉）')
  const out = await runAppointmentIndexBackfill()

  if (!out.ok) {
    console.error(`[backfill-appointments] skipped: ${out.skipped}（另一個 Apricot call 進行中 — 稍後重跑）`)
    process.exit(1)
  }

  const failed = out.results.filter(r => 'error' in r)
  for (const r of out.results) {
    if ('error' in r) {
      console.error(`  ❌ ${r.clinic} ${r.month}: ${r.error}`)
    } else {
      console.log(`  ✅ ${r.clinic} ${r.month}: ${r.indexRows} 單`)
    }
  }

  console.log('────────────────────────────────────────────────────────────')
  console.log(`  範圍: ${out.start} → ${out.end}（${out.results.length - failed.length}/${out.results.length} 月店批次成功）`)
  console.log(`  總單數（AppointmentIndex）: ${out.stats.totalAppointments}`)
  console.log(`  病人數（PatientIndex）: ${out.stats.totalPatients}`)
  console.log(`  耗時: ${(out.stats.elapsedMs / 60000).toFixed(1)} 分鐘`)
  console.log('────────────────────────────────────────────────────────────')

  if (failed.length > 0) {
    console.error(`⚠️ ${failed.length} 批失敗 — 直接重跑本 script（upsert 冪等，只會補/覆寫失敗批次）`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[backfill-appointments] 致命錯誤:', e?.message ?? e)
  process.exit(1)
})
