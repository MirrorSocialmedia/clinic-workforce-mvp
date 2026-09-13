import { toHKDateStr } from '../hk-date'

/**
 * ★ cwm-implantdate-20260913：CostCase.periodMonth 嘅唯一來源。
 *   LAB     → 跟到貨日（未到貨 = null，冇月度折扣）
 *   IMPLANT → 跟落單日（材料即場用，冇「到貨」概念）
 */
export function deriveCostPeriod(
  category: string,
  orderedAt: string | Date,
  receivedAt: string | Date | null | undefined,
): { receivedAt: Date | null; periodMonth: string | null } {
  if (category === 'IMPLANT') {
    const d = new Date(orderedAt)
    return { receivedAt: d, periodMonth: toHKDateStr(d).slice(0, 7) }
  }
  return receivedAt
    ? { receivedAt: new Date(receivedAt), periodMonth: toHKDateStr(receivedAt).slice(0, 7) }
    : { receivedAt: null, periodMonth: null }
}
