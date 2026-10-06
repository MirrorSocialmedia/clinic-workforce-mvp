// ============================================================
// ★ cwm-spbulk-20261006：2人SP補貼狀態轉換（單筆確認／跳過／取消 + 批量確認共用）
//   ★★★ 一律「條件寫入」：WHERE 入面帶 lockedByRunId = null（同埋目標狀態），
//      唔准「先讀睇有冇鎖、再 update」—— 兩步之間有人鎖月結，就會改到已鎖定嘅補貼。
//   ★ 已經係目標狀態 = no-op（唔再寫 confirmedBy、唔再寫 audit）。
//   ★ 批量確認帶住用戶睇到嘅金額：期間有人重新掃描改咗金額 → 唔確認，逐筆報返。
// ============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { lockPeriod } from '@/lib/payout/period-lock'
import { lockedRunFor } from '@/lib/cost-entry/guards'

export type SpStatus = 'PENDING' | 'CONFIRMED' | 'SKIPPED'

const ACTION: Record<SpStatus, { action: string; verb: string }> = {
  CONFIRMED: { action: 'SP_SUBSIDY_CONFIRM', verb: '確認' },
  SKIPPED: { action: 'SP_SUBSIDY_SKIP', verb: '跳過' },
  PENDING: { action: 'SP_SUBSIDY_RESET', verb: '重置' },
}

export const BULK_CONFIRM_MAX = 500

export type SetStatusResult =
  | { kind: 'ok'; row: any }
  | { kind: 'noop'; row: any }
  | { kind: 'locked' }
  | { kind: 'monthLocked'; periodMonth: string }
  | { kind: 'notfound' }

function auditData(row: any, to: SpStatus, actorId: string) {
  const a = ACTION[to]
  return {
    actorId,
    action: a.action,
    entity: 'SpSubsidy',
    entityId: row.id,
    notes: `${a.verb} SP 補貼：${row.itemDes} ${row.periodMonth} $${Number(row.amount)}`,
    afterJson: JSON.stringify({ providerId: row.providerId, periodMonth: row.periodMonth, amount: Number(row.amount) }),
  }
}

/** 單筆狀態轉換（條件寫入＋audit 同一個 transaction） */
export async function setSpStatus(id: string, to: SpStatus, actorId: string): Promise<SetStatusResult> {
  return prisma.$transaction(async (tx: any): Promise<SetStatusResult> => {
    // ★ cwm-payaudit-20261006：該月月結已經鎖定（呢筆係鎖完先掃到）→ 確認咗都唔會計入任何月結，
    //   醫生收唔到、匯出又會因為對唔到數而停 —— 擋（跳過／取消唔影響錢，照准）
    if (to === 'CONFIRMED') {
      const cur = await tx.spSubsidy.findUnique({ where: { id }, select: { providerId: true, clinicId: true, periodMonth: true, lockedByRunId: true } })
      if (cur?.clinicId) await lockPeriod(tx, cur.providerId, cur.clinicId, cur.periodMonth)
      if (cur && !cur.lockedByRunId && cur.clinicId && await lockedRunFor(tx, cur.providerId, cur.clinicId, cur.periodMonth)) {
        return { kind: 'monthLocked', periodMonth: cur.periodMonth }
      }
    }
    const res = await tx.spSubsidy.updateMany({
      where: { id, lockedByRunId: null, status: { not: to } },
      data: { status: to, confirmedBy: to === 'CONFIRMED' ? actorId : null },
    })
    const row = await tx.spSubsidy.findUnique({ where: { id } })
    if (res.count === 1) {
      await tx.auditLog.create({ data: auditData(row, to, actorId) })
      return { kind: 'ok', row }
    }
    if (!row) return { kind: 'notfound' }
    if (row.lockedByRunId) return { kind: 'locked' }
    return { kind: 'noop', row }
  })
}

export interface BulkItem { id: string; amount: number }
export type BulkReason = 'AMOUNT_CHANGED' | 'LOCKED' | 'MONTH_LOCKED' | 'NOT_FOUND' | 'NOT_PENDING'
export interface BulkResult {
  confirmed: Array<{ id: string; amount: number }>
  already: string[]
  rejected: Array<{ id: string; reason: BulkReason; billCode?: string | null; providerName?: string | null; amount?: number; expected: number }>
}

/** 純函數：驗證／去重批量請求；錯就 throw（route 回 400） */
export function parseBulkItems(raw: unknown): BulkItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('BULK_EMPTY: 未揀任何補貼')
  if (raw.length > BULK_CONFIRM_MAX) throw new Error(`BULK_TOO_MANY: 一次最多 ${BULK_CONFIRM_MAX} 筆`)
  const seen = new Map<string, BulkItem>()
  for (const it of raw as any[]) {
    const id = typeof it?.id === 'string' ? it.id.trim() : ''
    const amount = typeof it?.amount === 'number' ? it.amount : Number.NaN
    if (!id || !Number.isFinite(amount) || amount < 0) throw new Error('BULK_INVALID: 資料格式錯')
    const prev = seen.get(id)
    if (prev && prev.amount !== amount) throw new Error('BULK_INVALID: 同一筆出現兩個唔同金額')
    seen.set(id, { id, amount })
  }
  return Array.from(seen.values())
}

const money = (n: number) => new Prisma.Decimal(n.toFixed(2))

/**
 * 批量確認：只確認「仍然 PENDING、未鎖定、金額同用戶睇到一樣」嘅；成批喺一個 transaction。
 * 已經 CONFIRMED = already（唔寫）；其餘逐筆講原因。
 */
export async function bulkConfirmSp(items: BulkItem[], actorId: string): Promise<BulkResult> {
  return prisma.$transaction(async (tx: any) => {
    const out: BulkResult = { confirmed: [], already: [], rejected: [] }
    const audits: any[] = []
    const monthLockedCache = new Map<string, boolean>()
    for (const it of items) {
      // ★ cwm-payaudit-20261006：該月月結已鎖 → 唔確認（同單筆一樣）
      const cur = await tx.spSubsidy.findUnique({ where: { id: it.id }, select: { providerId: true, clinicId: true, periodMonth: true, lockedByRunId: true, status: true, amount: true } })
      if (cur && !cur.lockedByRunId && cur.status === 'PENDING' && cur.clinicId) {
        const key = `${cur.providerId}|${cur.clinicId}|${cur.periodMonth}`
        if (!monthLockedCache.has(key)) {
          await lockPeriod(tx, cur.providerId, cur.clinicId, cur.periodMonth)
          monthLockedCache.set(key, !!(await lockedRunFor(tx, cur.providerId, cur.clinicId, cur.periodMonth)))
        }
        if (monthLockedCache.get(key)) { out.rejected.push({ id: it.id, reason: 'MONTH_LOCKED', amount: Number(cur.amount), expected: it.amount }); continue }
      }
      const res = await tx.spSubsidy.updateMany({
        where: { id: it.id, status: 'PENDING', lockedByRunId: null, amount: money(it.amount) },
        data: { status: 'CONFIRMED', confirmedBy: actorId },
      })
      if (res.count === 1) {
        out.confirmed.push({ id: it.id, amount: it.amount })
        continue
      }
      const row = await tx.spSubsidy.findUnique({ where: { id: it.id } })
      if (!row) { out.rejected.push({ id: it.id, reason: 'NOT_FOUND', expected: it.amount }); continue }
      if (row.lockedByRunId) { out.rejected.push({ id: it.id, reason: 'LOCKED', amount: Number(row.amount), expected: it.amount }); continue }
      if (row.status === 'CONFIRMED') { out.already.push(it.id); continue }
      out.rejected.push({
        id: it.id,
        reason: row.status === 'PENDING' ? 'AMOUNT_CHANGED' : 'NOT_PENDING',
        amount: Number(row.amount),
        expected: it.amount,
      })
    }
    if (out.confirmed.length) {
      const rows = await tx.spSubsidy.findMany({ where: { id: { in: out.confirmed.map(c => c.id) } } })
      for (const r of rows) audits.push(auditData(r, 'CONFIRMED', actorId))
      const total = Math.round(out.confirmed.reduce((a, c) => a + c.amount, 0) * 100) / 100
      audits.push({
        actorId,
        action: 'SP_SUBSIDY_BULK_CONFIRM',
        entity: 'SpSubsidy',
        entityId: out.confirmed[0].id,
        notes: `批量確認 SP 補貼：${out.confirmed.length} 筆 $${total}（略過已確認 ${out.already.length}、唔確認 ${out.rejected.length}）`,
        afterJson: JSON.stringify({ ids: out.confirmed.map(c => c.id), total, rejected: out.rejected.map(r => ({ id: r.id, reason: r.reason })) }),
      })
      await tx.auditLog.createMany({ data: audits })
    }
    // 唔確認嘅補返帳單號／醫生名（畫面講清楚係邊筆；唔涉病人資料）
    if (out.rejected.length) {
      const ids = out.rejected.map(r => r.id)
      const rows = await tx.spSubsidy.findMany({ where: { id: { in: ids } }, select: { id: true, billExtId: true, providerId: true } })
      const bills = await tx.apricotBill.findMany({ where: { extId: { in: rows.map((r: any) => r.billExtId) } }, select: { extId: true, code: true } })
      const provs = await tx.provider.findMany({ where: { id: { in: rows.map((r: any) => r.providerId) } }, select: { id: true, name: true } })
      for (const r of out.rejected) {
        const row = rows.find((x: any) => x.id === r.id)
        r.billCode = row ? bills.find((b: any) => b.extId === row.billExtId)?.code ?? null : null
        r.providerName = row ? provs.find((p: any) => p.id === row.providerId)?.name ?? null : null
      }
    }
    return out
  }, { timeout: 30000 })
}

/** 單筆 route 回應（同舊 route 一樣嘅 shape：{ subsidy }；鎖咗 409、搵唔到 404） */
export function spStatusResponse(r: SetStatusResult): { body: any; status: number } {
  if (r.kind === 'notfound') return { body: { error: 'Not found' }, status: 404 }
  if (r.kind === 'locked') return { body: { error: '該補貼已鎖定喺月結單中，無法修改' }, status: 409 }
  if (r.kind === 'monthLocked') return { body: { error: `${r.periodMonth} 嘅月結已經鎖定，確認咗都唔會計入。請用「手動調整」喺下期補，或者先解鎖該月月結` }, status: 409 }
  const s = r.row
  return {
    body: {
      subsidy: { ...s, listPrice: Number(s.listPrice), actualPrice: Number(s.actualPrice), splitPercent: Number(s.splitPercent), amount: Number(s.amount) },
      ...(r.kind === 'noop' ? { unchanged: true } : {}),
    },
    status: 200,
  }
}
