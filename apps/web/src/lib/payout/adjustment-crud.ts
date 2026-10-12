// ============================================================
// ★ cwm-adjedit-20261013：手動調整（PayoutAdjustment）新增／修改／刪除 —— 驗證＋寫入規則（唯一來源）
//
// 月結點讀調整：
//   - 未鎖定（預覽／草稿／全店月報／一鍵匯出）：即場讀 runId=null 嘅調整（engine ⑦、report-data liveDraft）
//     → 改／刪之後即刻反映，冇快取、冇舊值。
//   - 鎖定（lockPayoutRun e.）：將嗰期 runId=null 嘅調整綁落 run（runId=run.id），之後讀快照。
// 所以：只准改／刪「未入月結」（runId=null）嘅調整；已入月結（草稿或鎖定）→ 擋（要先解鎖／刪草稿月結）。
// 併發：喺期間鎖（period-lock，同鎖月結同一把）入面做；改咗醫生／診所／月份 → 新舊兩個期間都鎖（排序防死鎖），
//   兩個期間都要未鎖定；寫入條件 runId=null（updateMany／deleteMany count=0 = 啱啱被鎖入月結 → 409）。
// ============================================================
import { Prisma } from '@prisma/client'
import { lockPeriod, periodKey } from './period-lock'
import { lockedRunFor, isMonthStr } from '@/lib/cost-entry/guards'

export const ADJ_REASONS = ['VOID', 'REFUND', 'MANUAL'] as const
export type AdjReason = typeof ADJ_REASONS[number]

export interface AdjInput {
  providerId: string
  clinicId: string
  periodMonth: string
  sourceMonth: string
  reason: AdjReason
  refCode: string | null
  amount: number
  note: string
}

export class AdjustmentError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const MAX_ABS = 1_000_000

/** 純驗證（新增／修改共用）。sourceMonth 冇填 = periodMonth。 */
export function validateAdjustmentInput(raw: any): { ok: true; data: AdjInput } | { ok: false; error: string } {
  const b = raw ?? {}
  const { providerId, clinicId, periodMonth, reason } = b
  if (!providerId || !clinicId || !periodMonth || !reason || b.amount == null || b.amount === '') {
    return { ok: false, error: 'providerId, clinicId, periodMonth, reason, amount 都係必填' }
  }
  const amt = Number(b.amount)
  if (!Number.isFinite(amt) || Math.abs(amt) > MAX_ABS) return { ok: false, error: '金額異常' }
  if (reason === 'VOID' && amt > 0) return { ok: false, error: '作廢回沖金額必須係負數' }
  // 最多兩個小數位（容差：0.07×100 = 7.000000000000001 唔應該當錯）
  if (amt === 0 || Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) {
    return { ok: false, error: '金額唔可以係 $0，最多兩個小數位' }
  }
  const sourceMonth = b.sourceMonth || periodMonth
  if (!isMonthStr(periodMonth) || !isMonthStr(sourceMonth)) return { ok: false, error: '月份格式錯（YYYY-MM）' }
  if (!(ADJ_REASONS as readonly string[]).includes(reason)) return { ok: false, error: '原因只可以係 VOID / REFUND / MANUAL' }
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : ''
  const refCode = typeof b.refCode === 'string' && b.refCode.trim() ? b.refCode.trim().slice(0, 100) : null
  return {
    ok: true,
    data: { providerId: String(providerId), clinicId: String(clinicId), periodMonth, sourceMonth, reason, refCode, amount: Math.round(amt * 100) / 100, note },
  }
}

const lockedMsg = (m: string) => `${m} 嘅月結已經鎖定，唔可以改呢期嘅調整。請揀下一個未鎖定嘅月份，或者先解鎖該月月結`
const inRunMsg = '呢筆調整已經入咗月結單（草稿或已鎖定），唔可以改／刪。要先解鎖並刪除嗰張月結草稿，或者喺下期加一筆反向調整'

type Period = { providerId: string; clinicId: string; periodMonth: string }

/** 鎖晒相關期間（去重＋排序，防兩個 transaction 互相等），再確認冇一個已鎖定 */
async function lockPeriods(tx: any, periods: Period[]): Promise<void> {
  const uniq = new Map<string, Period>()
  for (const p of periods) uniq.set(periodKey(p.providerId, p.clinicId, p.periodMonth), p)
  const sorted = [...uniq.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [, p] of sorted) await lockPeriod(tx, p.providerId, p.clinicId, p.periodMonth)
  for (const [, p] of sorted) {
    if (await lockedRunFor(tx, p.providerId, p.clinicId, p.periodMonth)) throw new AdjustmentError(409, lockedMsg(p.periodMonth))
  }
}

const snap = (a: any) => ({
  providerId: a.providerId, clinicId: a.clinicId, periodMonth: a.periodMonth, sourceMonth: a.sourceMonth,
  reason: a.reason, refCode: a.refCode, amount: Number(a.amount), note: a.note,
})

/**
 * 修改。allowClinic = 店舖帳號範圍（舊同新診所都要喺範圍）。
 * 回傳更新後嘅記錄；錯誤 throw AdjustmentError。
 */
export async function updateAdjustment(db: any, id: string, input: AdjInput, actorId: string, allowClinic: (clinicId: string | null) => boolean) {
  const cur = await db.payoutAdjustment.findUnique({ where: { id } })
  if (!cur) throw new AdjustmentError(404, '調整記錄唔存在（可能已經刪咗）')
  if (!allowClinic(cur.clinicId) || !allowClinic(input.clinicId)) throw new AdjustmentError(403, '店舖帳號只可以處理自己間店嘅醫生月結')
  if (cur.runId) throw new AdjustmentError(409, inRunMsg)
  const [prov, clin] = await Promise.all([
    db.provider.findUnique({ where: { id: input.providerId }, select: { id: true } }),
    db.clinic.findUnique({ where: { id: input.clinicId }, select: { id: true } }),
  ])
  if (!prov || !clin) throw new AdjustmentError(400, '醫生或者診所唔存在')

  return db.$transaction(async (tx: any) => {
    const periods: Period[] = [{ providerId: input.providerId, clinicId: input.clinicId, periodMonth: input.periodMonth }]
    if (cur.clinicId) periods.push({ providerId: cur.providerId, clinicId: cur.clinicId, periodMonth: cur.periodMonth })
    await lockPeriods(tx, periods)
    const res = await tx.payoutAdjustment.updateMany({
      where: { id, runId: null },
      data: {
        providerId: input.providerId, clinicId: input.clinicId, periodMonth: input.periodMonth, sourceMonth: input.sourceMonth,
        reason: input.reason, refCode: input.refCode, amount: new Prisma.Decimal(String(input.amount)), note: input.note,
      },
    })
    if (res.count === 0) throw new AdjustmentError(409, '呢筆調整啱啱被鎖入月結或者已經刪咗，請重新整理')
    await tx.auditLog.create({
      data: {
        actorId, action: 'PAYOUT_ADJUST_UPDATE', entity: 'PayoutAdjustment', entityId: id, clinicId: input.clinicId,
        notes: `修改調整記錄：${cur.periodMonth} ${Number(cur.amount)} → ${input.periodMonth} ${input.amount}（${input.reason}）`,
        beforeJson: JSON.stringify(snap(cur)),
        afterJson: JSON.stringify(input),
      } as any,
    })
    return tx.payoutAdjustment.findUnique({ where: { id } })
  })
}

/** 刪除（只限未入月結） */
export async function deleteAdjustment(db: any, id: string, actorId: string, allowClinic: (clinicId: string | null) => boolean): Promise<void> {
  const cur = await db.payoutAdjustment.findUnique({ where: { id } })
  if (!cur) throw new AdjustmentError(404, '調整記錄唔存在（可能已經刪咗）')
  if (!allowClinic(cur.clinicId)) throw new AdjustmentError(403, '店舖帳號只可以處理自己間店嘅醫生月結')
  if (cur.runId) throw new AdjustmentError(409, inRunMsg)
  await db.$transaction(async (tx: any) => {
    if (cur.clinicId) await lockPeriods(tx, [{ providerId: cur.providerId, clinicId: cur.clinicId, periodMonth: cur.periodMonth }])
    const res = await tx.payoutAdjustment.deleteMany({ where: { id, runId: null } })
    if (res.count === 0) throw new AdjustmentError(409, '呢筆調整啱啱被鎖入月結或者已經刪咗，請重新整理')
    await tx.auditLog.create({
      data: {
        actorId, action: 'PAYOUT_ADJUST_DELETE', entity: 'PayoutAdjustment', entityId: id, clinicId: cur.clinicId,
        notes: `刪除調整記錄：${cur.periodMonth} ${Number(cur.amount)}（${cur.reason}）${cur.note ? ` · ${cur.note}` : ''}`,
        beforeJson: JSON.stringify(snap(cur)),
      } as any,
    })
  })
}
