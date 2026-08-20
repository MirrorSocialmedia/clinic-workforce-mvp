// ★ cw-pa: 預約時段掃描線合併（P3）
// Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §5.2
//
// ★ 唔可以照抄原版 mergeRanges（佢假設 slot 唔重疊；實測 11:15–11:45 有四筆並排）。
// 排序 + 掃描：`r.startMin <= cur.e` 就合併 —— 重疊同**相鄰**都併
// （09:30–10:00 + 10:00–10:30 係連續，畫出嚟應該係一整條，唔好斷開假空隙）。
//
// ⚠️ `count` = 該段內**總 booking 筆數**（tooltip 顯示「N 個預約」），
//    **唔係**同時人數 —— 第一版唔做真 sweep-event 並發計算，UI 禁寫「同時 N 人」。
//
// 純 function，零依賴 —— 可直接 unit test（p3-acceptance.ts）。

export interface MergedBookingRange {
  s: number    // 段起（分鐘，00:00 起）
  e: number    // 段止（分鐘）
  count: number // 段內總 booking 筆數
}

export function mergeBookings(
  rows: { startMin: number; endMin: number }[],
): MergedBookingRange[] {
  if (rows.length === 0) return []
  const sorted = [...rows].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin,
  )
  const out: MergedBookingRange[] = []
  let cur = { s: sorted[0].startMin, e: sorted[0].endMin, count: 1 }
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]
    if (r.startMin <= cur.e) {
      // ★ 重疊或者相接 → 合併
      cur.e = Math.max(cur.e, r.endMin)
      cur.count += 1
    } else {
      out.push(cur)
      cur = { s: r.startMin, e: r.endMin, count: 1 }
    }
  }
  out.push(cur)
  return out
}
