// ============================================================
// ★ cwm-sppreview-20261006：醫生月結預覽 —— 未確認 2人SP／未掃描提示
//   ① 呢位醫生 × 診所 × 月仲有 PENDING 嘅 SP → 列出（只帳單號／日期／金額，零病人資料）
//   ② 成間診所呢個月未掃描過 → 提示（掃描係人手撳，漏咗 SP 會靜靜變 $0）
//   兩樣都要喺預覽剔「我知道」先鎖得（老闆拍板，同成本「當月未計入」一樣）
// ============================================================
import { prisma } from '@/lib/prisma'

export const SP_SCAN_AUDIT = 'SP_SUBSIDY_SCAN'

/** 掃描紀錄嘅 entityId：全部診所 = 月份；指定診所 = 月份:clinicId */
export function scanAuditEntityId(periodMonth: string, clinicId?: string | null) {
  return clinicId ? `${periodMonth}:${clinicId}` : periodMonth
}

export interface SpReview {
  providerName: string
  clinicName: string
  pending: Array<{ id: string; billCode: string | null; billTime: string | null; amount: number; needsReview: boolean; hasMarker: boolean }>
  pendingTotal: number
  /** 呢間診所呢個月有冇掃描過（有 SP 紀錄，或者有掃描紀錄） */
  scanned: boolean
}

/** 純函數：要唔要剔「我知道」先鎖得 */
export function spReviewNeeded(r: Pick<SpReview, 'pending' | 'scanned'>): boolean {
  return r.pending.length > 0 || !r.scanned
}

export async function spReview(providerId: string, clinicId: string, periodMonth: string): Promise<SpReview> {
  const [rows, anyInClinic, scanLog, provider, clinic] = await Promise.all([
    prisma.spSubsidy.findMany({
      where: { providerId, clinicId, periodMonth, status: 'PENDING', lockedByRunId: null },
      select: { id: true, billExtId: true, amount: true, needsReview: true, hasMarker: true },
    }),
    prisma.spSubsidy.count({ where: { clinicId, periodMonth } }),
    prisma.auditLog.findFirst({
      where: { action: SP_SCAN_AUDIT, entityId: { in: [scanAuditEntityId(periodMonth), scanAuditEntityId(periodMonth, clinicId)] } },
      select: { id: true },
    }),
    prisma.provider.findUnique({ where: { id: providerId }, select: { name: true } }),
    prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true } }),
  ])
  const bills = rows.length
    ? await prisma.apricotBill.findMany({ where: { extId: { in: rows.map(r => r.billExtId) } }, select: { extId: true, code: true, billTime: true } })
    : []
  const billOf = new Map(bills.map(b => [b.extId, b]))
  const pending = rows
    .map(r => ({
      id: r.id,
      billCode: billOf.get(r.billExtId)?.code ?? null,
      billTime: billOf.get(r.billExtId)?.billTime?.toISOString() ?? null,
      amount: Number(r.amount),
      needsReview: r.needsReview,
      hasMarker: r.hasMarker,
    }))
    .sort((a, b) => (a.billTime ?? '').localeCompare(b.billTime ?? '') || (a.billCode ?? '').localeCompare(b.billCode ?? ''))
  return {
    providerName: provider?.name ?? '',
    clinicName: clinic?.name ?? '',
    pending,
    pendingTotal: Math.round(pending.reduce((a, p) => a + p.amount, 0) * 100) / 100,
    scanned: anyInClinic > 0 || !!scanLog,
  }
}
