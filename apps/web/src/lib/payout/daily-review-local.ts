// ============================================================
// ★ cwm-pvcheck-20261007 A4：預視就地核對成功後 —— 本地即時更新
//   純函數，零 prisma import（client bundle 安全）。
//   DailyReview 只用 import type（daily-review.ts 本體 import loadDailyReport → prisma，
//   本檔絕對唔可以 `import { ... } from './daily-review'`）。
//   本地更新只係顯示用：鎖定時伺服器 dailyReviewAck gate 會重新計，唔影響安全。
// ============================================================
import type { DailyReview, DailyReviewDay } from './daily-review'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 喺 DailyReview 入面本地套用「date 呢日核對成功」：
 * - 該日 → status='CHECKED'、nurseName、checkedAt、checkedAmount=storeTotal
 * - counts 同 needsAck 重新計（同 mergeDailyReview 一條式）
 * - 純函數：唔改原物件；搵唔到 date → 原樣返回（唔 throw）
 */
export function applyLocalCheck(
  r: DailyReview,
  date: string,
  nurseName: string,
  checkedAtISO: string,
): DailyReview {
  const idx = r.days.findIndex(d => d.date === date)
  if (idx === -1) return r
  const updated: DailyReviewDay = {
    ...r.days[idx],
    status: 'CHECKED',
    nurseName,
    checkedAt: checkedAtISO,
    checkedAmount: round2(r.days[idx].storeTotal),
  }
  const days = r.days.map((d, i) => (i === idx ? updated : d))
  const counts = {
    checked: days.filter(d => d.status === 'CHECKED').length,
    changed: days.filter(d => d.status === 'CHANGED').length,
    unchecked: days.filter(d => d.status === 'UNCHECKED').length,
  }
  return {
    days,
    doctorTotal: r.doctorTotal,
    counts,
    needsAck: counts.changed + counts.unchecked > 0,
  }
}
