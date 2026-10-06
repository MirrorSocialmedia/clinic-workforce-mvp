// ============================================================
// ★ cwm-dailyreview-20261006：醫生月結預覽 —— 每日收款＋護士核對狀態
//   逐日：呢位醫生嗰日收款（同「原始收入」同一口徑：每日大數 doctorRaw）、全店收款、該店該日核對狀態。
//   有未核對／核對後有變 → 預覽要剔「我知道」先鎖得（老闆拍板，同成本、2人SP 一樣）。
// ============================================================
import { loadDailyReport } from './daily-report'
import { loadCheckStates, type CheckStatus } from './daily-check'

export interface DailyReviewDay {
  date: string
  doctorRaw: number
  storeTotal: number
  /** NONE = 全店嗰日冇店舖營收（例如只有 FREE SP／CREDIT），唔使核對 */
  status: CheckStatus | 'NONE'
  nurseName: string | null
  checkedAt: string | null
  checkedAmount: number | null
}

export interface DailyReview {
  days: DailyReviewDay[]
  doctorTotal: number
  counts: { checked: number; changed: number; unchecked: number }
  needsAck: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function monthDays(periodMonth: string): { from: string; to: string } {
  const [y, m] = periodMonth.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${periodMonth}-01`, to: `${periodMonth}-${String(last).padStart(2, '0')}` }
}

/** 純函數：合併醫生逐日收款 + 店舖逐日核對狀態（只列醫生嗰日有收款嘅日子） */
export function mergeDailyReview(
  doctorDays: Array<{ date: string; doctorRaw: number }>,
  shopDays: Array<{ date: string; storeTotal: number; status: CheckStatus; check: { nurseName: string; checkedAt: string; amount: number } | null }>,
): DailyReview {
  const shop = new Map(shopDays.map(d => [d.date, d]))
  const days: DailyReviewDay[] = doctorDays
    .filter(d => Math.abs(d.doctorRaw) > 0.005)
    .map(d => {
      const s = shop.get(d.date)
      return {
        date: d.date,
        doctorRaw: d.doctorRaw,
        storeTotal: s?.storeTotal ?? 0,
        status: s ? s.status : 'NONE',
        nurseName: s?.check?.nurseName ?? null,
        checkedAt: s?.check?.checkedAt ?? null,
        checkedAmount: s?.check?.amount ?? null,
      }
    })
  const counts = {
    checked: days.filter(d => d.status === 'CHECKED').length,
    changed: days.filter(d => d.status === 'CHANGED').length,
    unchecked: days.filter(d => d.status === 'UNCHECKED').length,
  }
  return {
    days,
    doctorTotal: round2(days.reduce((a, d) => a + d.doctorRaw, 0)),
    counts,
    needsAck: counts.changed + counts.unchecked > 0,
  }
}

export async function dailyReview(providerId: string, clinicId: string, periodMonth: string): Promise<DailyReview> {
  const { from, to } = monthDays(periodMonth)
  const doctor = await loadDailyReport({ from, to, clinicId, providerId, scopeClinics: null })
  const shop = await loadCheckStates(clinicId, from, to)
  return mergeDailyReview(
    doctor.rows.map(r => ({ date: r.key, doctorRaw: r.doctorRaw })),
    shop.map(s => ({ date: s.date, storeTotal: s.storeTotal, status: s.status, check: s.check ? { nurseName: s.check.nurseName, checkedAt: s.check.checkedAt, amount: s.check.amount } : null })),
  )
}
