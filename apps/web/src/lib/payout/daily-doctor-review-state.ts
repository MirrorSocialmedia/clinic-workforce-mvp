// ============================================================
// ★ cwm-dailyreview2-20261014：每日大數「核對同事」覆核 —— 純函數（零 prisma，client／server／test 共用）
//   一格 = 醫生 × 診所 × 日。快照 = 剔嗰陣逐付款方式金額（非 0、兩位小數）；
//   而家嘅數同快照唔同 → CHANGED（要再剔）。
// ============================================================

export type DoctorReviewStatus = 'NONE' | 'OK' | 'CHANGED'

export interface DoctorReviewRecord {
  date: string
  reviewerName: string
  reviewedAt: string // ISO
  snapshot: Record<string, number>
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** 呢日呢位醫生有冇收款（任何付款方式非 0） */
export function hasRevenue(byMethod: Record<string, number> | null | undefined): boolean {
  return !!byMethod && Object.values(byMethod).some(v => Math.abs(v) > 0.005)
}

/** 快照：只留非 0 嘅付款方式，兩位小數 */
export function snapshotOf(byMethod: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of Object.keys(byMethod).sort()) {
    const v = round2(byMethod[k] ?? 0)
    if (Math.abs(v) > 0.005) out[k] = v
  }
  return out
}

export function sameSnapshot(a: Record<string, number>, b: Record<string, number>): boolean {
  const sa = snapshotOf(a), sb = snapshotOf(b)
  const ka = Object.keys(sa), kb = Object.keys(sb)
  if (ka.length !== kb.length) return false
  return ka.every(k => k in sb && Math.abs(sa[k] - sb[k]) < 0.005)
}

export function reviewStatus(current: Record<string, number> | null | undefined, rec: { snapshot: Record<string, number> } | null | undefined): DoctorReviewStatus {
  if (!rec) return 'NONE'
  return sameSnapshot(current ?? {}, rec.snapshot ?? {}) ? 'OK' : 'CHANGED'
}

export interface DoctorReviewProgress {
  /** 有收款嘅日數 */
  total: number
  ok: number
  changed: number
  /** 有收款但未覆核（唔包有變） */
  pendingDates: string[]
  changedDates: string[]
  /** 未核對晒（未覆核或者有變）→ 月結要剔「我知道」 */
  needsAck: boolean
}

/** 逐日（行 = 日）計進度：只計有收款嘅日；冇收款但有舊覆核唔計 */
export function reviewProgress(
  days: Array<{ date: string; byMethod: Record<string, number> }>,
  reviews: Map<string, { snapshot: Record<string, number> }>,
): DoctorReviewProgress {
  const pendingDates: string[] = []
  const changedDates: string[] = []
  let total = 0, ok = 0
  for (const d of days) {
    if (!hasRevenue(d.byMethod)) continue
    total++
    const st = reviewStatus(d.byMethod, reviews.get(d.date) ?? null)
    if (st === 'OK') ok++
    else if (st === 'CHANGED') changedDates.push(d.date)
    else pendingDates.push(d.date)
  }
  return { total, ok, changed: changedDates.length, pendingDates, changedDates, needsAck: pendingDates.length + changedDates.length > 0 }
}
