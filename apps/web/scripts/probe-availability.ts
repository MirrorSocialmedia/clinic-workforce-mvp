/**
 * ★ cw-pa P1-D: Apricot availability probe — 結構統計 only，零值輸出
 * 跑法: npx tsx scripts/probe-availability.ts [fixture.json]
 *       （預設 = testdata/availability-overview.sample.json，P1 唔打真 API）
 *
 * 🔴 安全紅線（spec §7.1 #1）：呢個 script 永不輸出 response 任何值 —
 *    無日期 key、無 practitioner code/name、無時間、無病人資料。
 *    只輸出四個結構計數（日期數 / practitioner 數 / timeSlots 數 /
 *    bookingDetail 長度）＋ 白名單提取行數。
 *
 * P2 接真 API 時：apricotCall 拎到 raw 之後照呢個 walk 邏輯跑（同樣零值）。
 */
import { readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { extractOpenSch, extractBookings } from '../src/lib/apricot/availability'

// ★ hard timeout：唔准 hang（生產機鐵律）
setTimeout(() => {
  console.error('[probe] TIMEOUT 15s — 強制結束')
  process.exit(2)
}, 15_000).unref()

const DEFAULT_FIXTURE = resolve(import.meta.dirname, '../testdata/availability-overview.sample.json')
const file = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_FIXTURE

let raw: any
try {
  raw = JSON.parse(readFileSync(file, 'utf8'))
} catch (e: any) {
  console.error(`[probe] 讀 fixture 失敗: ${e?.message ?? e}`)
  process.exit(1)
}

let dates = 0
let practitioners = 0
let timeSlots = 0
let bookingDetailLen = 0
let skippedNonDateKeys = 0
let openSchRows = 0
let bookingRows = 0

for (const [key, dayNode] of Object.entries(raw ?? {})) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    skippedNonDateKeys++ // 唔 log key 本身（值）
    continue
  }
  dates++
  const appts = (dayNode as any)?.appointments
  if (!appts || typeof appts !== 'object') continue
  for (const [pid, node] of Object.entries(appts)) {
    if (!pid) continue
    practitioners++
    const slots = (node as any)?.practitionerOpenSchs?.timeSlots
    if (Array.isArray(slots)) timeSlots += slots.length
    const bd = (node as any)?.bookingDetail
    if (Array.isArray(bd)) bookingDetailLen += bd.length
    openSchRows += extractOpenSch(key, node).length
    bookingRows += extractBookings(key, node).length
  }
}

// ★ 只輸出結構計數 —— 零值（§7.1 #1）。basename 係我哋自己嘅檔名，唔係 response 值。
console.log(`[probe] fixture=${basename(file)}`)
console.log(`[probe] dates=${dates} practitioners=${practitioners} timeSlots=${timeSlots} bookingDetailLen=${bookingDetailLen}`)
console.log(`[probe] extracted openSchRows=${openSchRows} bookingRows=${bookingRows}${skippedNonDateKeys ? ` (skippedNonDateKeys=${skippedNonDateKeys})` : ''}`)
console.log('[probe] OK — 零值輸出')
process.exit(0)
