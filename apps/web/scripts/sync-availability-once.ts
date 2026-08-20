/**
 * ★ cw-pa P2: availability sync — one-shot（打真 API 一次）
 *
 * 跑法（生產/部署機）：
 *   cd /home/clinicapp/clinic/apps/web   # 或實際 checkout 位置
 *   npx tsx scripts/sync-availability-once.ts
 *
 * 行為：
 *   - 跑 runAvailabilitySync()（§3.3 外層 advisory lock 包住全部店）
 *   - log 每間 clinic 統計（open / bookings / unknown / error）＋ 總數
 *   - 攞唔到 lock（另一個 apricot call 進行中）→ log skipped 後 exit 0（唔係錯誤）
 *   - ★ hard timeout 5 分鐘：強制結束（生產機鐵律，唔准 hang）
 *
 * 🔴 唔 log 任何 raw response 值（response 內嵌病人 PII，§7.1 #4）。
 *
 * P3 嘅 internal API 會包同一個核心（runAvailabilitySync），呢個 script 只係
 * 人手觸發入口 —— 核心邏輯永遠喺 src/lib/apricot/sync-availability.ts。
 */
import { runAvailabilitySync } from '../src/lib/apricot/sync-availability'

// ★ hard timeout：5 分鐘
setTimeout(() => {
  console.error('[sync-availability-once] TIMEOUT 5min — 強制結束')
  process.exit(2)
}, 5 * 60 * 1000).unref()

async function main() {
  const t0 = Date.now()
  console.log(`[sync-availability-once] start ${new Date().toISOString()}`)

  const res = await runAvailabilitySync()

  if (!res.ok) {
    // §7.2 #18c：攞唔到 lock —— 正常跳過，唔係失敗
    console.log(`[sync-availability-once] SKIPPED: ${res.skipped}`)
    process.exit(0)
  }

  let totalOpen = 0
  let totalBookings = 0
  let totalUnknown = 0
  let errors = 0

  for (const r of res.results) {
    if ('error' in r) {
      errors++
      console.log(`[sync-availability-once] ${r.clinic}: ERROR ${r.error}`)
    } else {
      totalOpen += r.open
      totalBookings += r.bookings
      totalUnknown += r.unknown
      console.log(
        `[sync-availability-once] ${r.clinic}: open=${r.open} bookings=${r.bookings} unknown=${r.unknown}`,
      )
    }
  }

  console.log(
    `[sync-availability-once] window ${res.start}..${res.end} ` +
      `total open=${totalOpen} bookings=${totalBookings} unknown=${totalUnknown} ` +
      `errors=${errors} skippedClinics=${res.skippedClinics} ` +
      `elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )
  process.exit(0)
}

main().catch((e) => {
  console.error('[sync-availability-once] FATAL', e)
  process.exit(1)
})
