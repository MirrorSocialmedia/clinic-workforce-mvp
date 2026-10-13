// ============================================================
// ★ cwm-dailyreview2-20261014：每日大數「核對同事」覆核 —— 寫入／讀取（伺服器）
//   多日畫面（指定醫生＋診所）最右邊格仔；表頭格仔 = 一次過剔晒。
//   - 剔：伺服器重新計嗰日呢位醫生嘅數（loadDailyReport，同頁面同一口徑，唔信前端），記快照。
//     冇收款嘅日子跳過；已經覆核而冇變 → 唔重複寫；有變 → 舊嗰條標取消、寫新嗰條。
//   - 取消：revokedAt（唔刪）。
//   - 留名：個人帳號 = 帳號名；店舖帳號一定要揀同事（同埋數同一份名單 nurseOptions）。
//   - 併發：同一位醫生同一間店用 advisory lock 排隊；partial unique index 兜底。
//   - 審計：DAILY_DOCTOR_REVIEW / DAILY_DOCTOR_REVIEW_REVOKE（每次一條，列晒日子）。
// ============================================================
import { prisma } from '@/lib/prisma'
import { todayHK } from '@/lib/hk-date'
import { loadDailyReport } from './daily-report'
import { nurseOptions } from './daily-check'
import { hasRevenue, reviewProgress, sameSnapshot, snapshotOf, type DoctorReviewProgress, type DoctorReviewRecord } from './daily-doctor-review-state'
import { monthDays } from './daily-review'

export class DoctorReviewError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const round2 = (n: number) => Math.round(n * 100) / 100

/** 店舖帳號（公開裝置）要揀同事名先剔得 —— role 判斷喺 lib（check-role-hardcode-api.sh） */
export function reviewNeedsStaff(session: { role: string }): boolean {
  return session.role === 'KIOSK'
}

/** 揀名單日：範圍尾（未到就用今日） */
const staffDate = (to: string) => (to > todayHK() ? todayHK() : to)

export async function reviewStaffOptions(clinicId: string, to: string) {
  return nurseOptions(clinicId, staffDate(to))
}

export async function loadDoctorReviews(db: any, clinicId: string, providerId: string, from: string, to: string): Promise<DoctorReviewRecord[]> {
  const rows = await db.dailyDoctorReview.findMany({
    where: { clinicId, providerId, date: { gte: from, lte: to }, revokedAt: null },
    orderBy: { date: 'asc' },
  })
  return rows.map((r: any) => ({ date: r.date, reviewerName: r.reviewerName, reviewedAt: r.reviewedAt.toISOString(), snapshot: (r.snapshotJson ?? {}) as Record<string, number> }))
}

export interface DayAmounts { byMethod: Record<string, number>; doctorRaw: number; storeTotal: number }

export interface ApplyResult {
  reviewed: string[] // 新剔（包括有變重新剔）
  unchanged: string[] // 本身已覆核而冇變
  skipped: Array<{ date: string; reason: string }>
  revoked: string[]
}

/**
 * 核心寫入（current = 伺服器啱啱計嘅逐日金額；route 一定由 loadDailyReport 計，唔信前端）。
 * 抽出嚟方便真 DB 測試直接行。
 */
export async function applyDoctorReviews(db: any, input: {
  clinicId: string; providerId: string; dates: string[]; checked: boolean
  actorId: string; reviewerName: string
}, current: Map<string, DayAmounts>): Promise<ApplyResult> {
  const { clinicId, providerId, checked, actorId, reviewerName } = input
  const dates = [...new Set(input.dates)].sort()
  if (dates.length === 0) throw new DoctorReviewError('冇揀日子')
  if (dates.some(d => !DATE_RE.test(d))) throw new DoctorReviewError('日期格式要 YYYY-MM-DD')
  const res: ApplyResult = { reviewed: [], unchanged: [], skipped: [], revoked: [] }

  await db.$transaction(async (tx: any) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`daily-doctor-review:${clinicId}:${providerId}`}))`
    const active = await tx.dailyDoctorReview.findMany({ where: { clinicId, providerId, date: { in: dates }, revokedAt: null } })
    const byDate = new Map<string, any>(active.map((a: any) => [a.date, a]))
    const now = new Date()
    for (const date of dates) {
      const ex = byDate.get(date)
      if (!checked) {
        if (ex) {
          await tx.dailyDoctorReview.update({ where: { id: ex.id }, data: { revokedAt: now, revokedBy: actorId } })
          res.revoked.push(date)
        }
        continue
      }
      const cur = current.get(date)
      if (!cur || !hasRevenue(cur.byMethod)) { res.skipped.push({ date, reason: '冇收款' }); continue }
      if (date > todayHK()) { res.skipped.push({ date, reason: '未到嘅日子' }); continue }
      if (ex && sameSnapshot(cur.byMethod, (ex.snapshotJson ?? {}) as Record<string, number>)) { res.unchanged.push(date); continue }
      if (ex) await tx.dailyDoctorReview.update({ where: { id: ex.id }, data: { revokedAt: now, revokedBy: actorId } })
      await tx.dailyDoctorReview.create({
        data: {
          clinicId, providerId, date, snapshotJson: snapshotOf(cur.byMethod),
          doctorRaw: round2(cur.doctorRaw).toFixed(2), storeTotal: round2(cur.storeTotal).toFixed(2),
          reviewedBy: actorId, reviewerName,
        },
      })
      res.reviewed.push(date)
    }
    const changedDates = checked ? res.reviewed : res.revoked
    if (changedDates.length > 0) {
      await tx.auditLog.create({
        data: {
          actorId, clinicId,
          action: checked ? 'DAILY_DOCTOR_REVIEW' : 'DAILY_DOCTOR_REVIEW_REVOKE',
          entity: 'DailyDoctorReview', entityId: `${clinicId}|${providerId}|${changedDates[0]}`,
          notes: `${checked ? '每日大數覆核' : '取消每日大數覆核'}（${reviewerName}）：醫生 ${providerId} · ${changedDates.length} 日 · `
            + changedDates.map(d => checked ? `${d} $${round2(current.get(d)!.doctorRaw)}` : d).join('、'),
          afterJson: checked ? JSON.stringify(changedDates.map(d => ({ date: d, snapshot: snapshotOf(current.get(d)!.byMethod) }))) : null,
        } as any,
      })
    }
  })
  return res
}

/** route 用：驗證 → 伺服器計數 → applyDoctorReviews */
export async function setDoctorReviews(input: {
  clinicId: string; providerId: string; from: string; to: string; dates: string[]; checked: boolean
  actorId: string; needsStaff: boolean; staffEmployeeId: string | null
}): Promise<ApplyResult> {
  const { clinicId, providerId, from, to } = input
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw new DoctorReviewError('日期範圍唔啱')
  if (input.dates.some(d => d < from || d > to)) throw new DoctorReviewError('揀咗嘅日子唔喺範圍入面')

  let reviewerName: string
  if (input.staffEmployeeId) {
    const staff = (await reviewStaffOptions(clinicId, to)).find(n => n.employeeId === input.staffEmployeeId)
    if (!staff) throw new DoctorReviewError('呢位同事唔屬於呢間店，請重新揀')
    reviewerName = staff.name
  } else if (input.needsStaff) {
    throw new DoctorReviewError('店舖帳號請先揀核對同事名')
  } else {
    const u = await prisma.user.findUnique({ where: { id: input.actorId }, select: { name: true, fullName: true } })
    reviewerName = u?.name || u?.fullName || input.actorId
  }

  const current = new Map<string, DayAmounts>()
  if (input.checked) {
    const report = await loadDailyReport({ from, to, clinicId, providerId, scopeClinics: null })
    if (report.mode !== 'byDay') throw new DoctorReviewError('要揀醫生先可以覆核')
    for (const r of report.rows) current.set(r.key, { byMethod: r.byMethod, doctorRaw: r.doctorRaw, storeTotal: r.storeTotal })
  }
  return applyDoctorReviews(prisma, { clinicId, providerId, dates: input.dates, checked: input.checked, actorId: input.actorId, reviewerName }, current)
}

/** 醫生月結用：呢位醫生呢間店呢個月覆核進度 */
export async function doctorReviewProgress(providerId: string, clinicId: string, periodMonth: string): Promise<DoctorReviewProgress> {
  const { from, to } = monthDays(periodMonth)
  const report = await loadDailyReport({ from, to, clinicId, providerId, scopeClinics: null })
  const reviews = await loadDoctorReviews(prisma, clinicId, providerId, from, to)
  return reviewProgress(report.rows.map(r => ({ date: r.key, byMethod: r.byMethod })), new Map(reviews.map(r => [r.date, r])))
}
