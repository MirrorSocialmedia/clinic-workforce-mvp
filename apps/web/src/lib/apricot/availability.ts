// ★ cw-pa: Apricot 醫生時間表 — 白名單提取（P1-C）
// Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §一
//
// 🔴 呢個 response 係目前見過最危險嘅 Apricot JSON：每筆預約內嵌病人
//    完整資料（HKID／病歷／電話／地址／緊急聯絡人）、求診原因、
//    醫生病情自由文字備註、員工姓名。
// 白名單提取係唯一防線：
//   ✅ 抽：時間戳（bookingTime/bookingEndTime）、開診 HHMM 整數、狀態整數
//   ❌ 唔抽：其餘所有欄位
// ★★★ 回傳只准 primitive —— 唔可以回 booking 本身或者任何 sub-object，
//     一回 object，敏感欄位就跟住入 scope。
//
// PII 洩漏測試：availability.test.ts（test-first，實裝前已寫好）。
// 落刀 discipline：本檔案永不提及任何病人資料欄位名（§7.1 #3 grep 驗收）。

export interface OpenSchRow {
  date: string     // 'YYYY-MM-DD'（HK）
  startTime: string // 'HH:mm'
  endTime: string   // 'HH:mm'
}

export interface BookingRow {
  date: string   // 'YYYY-MM-DD'（HK）
  startMin: number // 由 00:00 起嘅分鐘數（09:30 → 570）
  endMin: number
  status: number   // Apricot bookingStatus；實見 0（已約）/ 4（已完成）
}

/** 開診時段 —— 只抽三樣（date/startTime/endTime），零 sub-object */
export function extractOpenSch(dateStr: string, node: any): OpenSchRow[] {
  const slots = node?.practitionerOpenSchs?.timeSlots
  if (!Array.isArray(slots)) return []
  return slots
    .map((t: any): OpenSchRow => ({
      date: dateStr,
      startTime: hhmmIntToStr(t?.startTime), // 900 → '09:00'
      endTime: hhmmIntToStr(t?.endTime),     // 1800 → '18:00'
    }))
    .filter(r => r.startTime && r.endTime)
}

/**
 * 預約時段 —— 🔴 只抽四樣（date/startMin/endMin/status），其餘一律唔掂。
 *
 * 白名單：
 *   ✅ bookingTime / bookingEndTime（ISO UTC 時間戳）
 *   ✅ bookingStatus（整數）· isRemoved（boolean，只讀做跳過判斷，唔回傳）
 *
 * 非白名單（一律唔讀、唔回傳、唔 log）：
 *   ❌ 病人資料（證件號／病歷／電話／地址／緊急聯絡人等成個病人 object）
 *   ❌ 求診原因（病情）
 *   ❌ 醫生備註（病情自由文字）
 *   ❌ 員工姓名（createdBy 等）· 任何內部 id
 */
export function extractBookings(dateStr: string, node: any): BookingRow[] {
  const arr = node?.bookingDetail
  if (!Array.isArray(arr)) return []
  const out: BookingRow[] = []
  for (const b of arr) {
    if (b?.isRemoved === true) continue // §7.2 #15
    const s = utcIsoToHkMin(b?.bookingTime, dateStr)
    const e = utcIsoToHkMin(b?.bookingEndTime, dateStr)
    if (s == null || e == null || e <= s) continue // 壞格式／跨日／無效時段
    // §7.2 #16：status 保留；缺省 → -1；NaN 防御（Int 欄禁 NaN，P2 入庫前最後一關）
    const st = Number(b?.bookingStatus ?? -1)
    out.push({ date: dateStr, startMin: s, endMin: e, status: Number.isFinite(st) ? st : -1 })
  }
  return out
}

/**
 * ISO UTC → HK 當日「由 00:00 起嘅分鐘數」；跨日／格式錯回 null。
 *
 * ★ dateStr（node 頂層日期 key，HK 日期）必傳 ——
 *   bookingTime 係 UTC，HK 00:00–08:00 嘅預約 UTC 會落喺前一日。
 *   HK 日期要同 node 日期一致先數得，唔一致就係錯日筆，跳過。
 */
export function utcIsoToHkMin(iso: unknown, dateStr: string): number | null {
  if (typeof iso !== 'string' || !iso) return null
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const hk = new Date(t + 8 * 3600 * 1000)
  // ★ 跨日檢查：預約嘅 HK 日期要同 node 個日期一致，唔係就跳過
  if (hk.toISOString().slice(0, 10) !== dateStr) return null
  return hk.getUTCHours() * 60 + hk.getUTCMinutes()
}

/** HHMM 整數 → 'HH:mm'；900 → '09:00'、2000 → '20:00'；非法回 ''（caller filter 走）
 *  ★ 防御 spec 偽碼漏洞：Number(null)/Number('') 都 = 0，會造出假 00:00 slot ——
 *    null/undefined/''/boolean 一律拒。 */
export function hhmmIntToStr(n: unknown): string {
  if (n === null || n === undefined || n === '' || typeof n === 'boolean') return ''
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0 || v > 2359) return ''
  const str = String(Math.floor(v)).padStart(4, '0')
  const hh = str.slice(0, 2), mm = str.slice(2)
  if (Number(mm) > 59) return ''
  return `${hh}:${mm}`
}
