// ★ cwm-labdoc：月結單「改返」— 改分段診所／醫生、解除指派、改 Lab／月份 之前嘅守門＋清配對
//
// 配對（result／matched*）同差異處理（resolution）都係基於「Lab＋診所＋醫生＋月」計出嚟；
// 呢四樣任何一樣改咗，舊配對就唔再成立 → 清走，再自動重新配對。
// 例外：STATEMENT_WINS（以月結單為準）已經改咗系統 invoice／成本，清 resolution 都還原唔到 → 擋。

import { Prisma } from '@prisma/client'

/** 有冇行已經「以月結單為準」改咗系統（改咗就唔可以再改分段基礎）。 */
export async function sectionsWithSystemChange(client: any, sectionIds: string[]): Promise<number> {
  if (sectionIds.length === 0) return 0
  return client.labStatementLine.count({
    where: { sectionId: { in: sectionIds }, resolution: 'STATEMENT_WINS' },
  })
}

export const SYSTEM_CHANGE_BLOCK_MSG =
  '呢段已經有行用咗「以月結單為準」改咗系統 invoice／成本 — 唔可以再改診所／醫生／Lab／月份（要改請先作廢呢份月結單再重新上傳）'

/**
 * 清走分段所有行嘅配對，分段結果歸零（要喺 transaction 入面行）。
 * 「備貨」／「唔關我哋事」標記同診所、醫生、月份無關 → 保留；其他舊處理清走。
 * ★ 2026-10-11：「計入下個月」（NEXT_MONTH）係對應舊範圍嘅下個月 → 一齊清（route 先用 sectionsCarryLocked 擋已確認）；
 *   上月結轉副本屬舊範圍 → 刪走（新範圍對數時再同步）。改完 route 要 reconcileCarryTargets(舊範圍)。
 */
export async function resetSectionMatching(tx: any, sectionIds: string[]): Promise<void> {
  if (sectionIds.length === 0) return
  await tx.labStatementLine.deleteMany({ where: { sectionId: { in: sectionIds }, carriedFromLineId: { not: null } } })
  await tx.labStatementLine.updateMany({
    where: { sectionId: { in: sectionIds } },
    // 人手配對／未配對到都係基於呢段嘅成本範圍 → 一齊清
    data: { result: 'PENDING', matchBasis: null, matchedDocumentId: null, matchedLineId: null, pairMode: null, pairCostCaseId: null },
  })
  await tx.labStatementLine.updateMany({
    where: { sectionId: { in: sectionIds }, OR: [{ resolution: null }, { resolution: { notIn: ['STOCK', 'NOT_OURS'] } }] },
    data: {
      resolution: null,
      resolutionNote: null,
      resolvedBy: null,
      resolvedAt: null,
      followUpClosedAt: null,
      followUpClosedBy: null,
    },
  })
  await tx.labStatementSection.updateMany({
    where: { id: { in: sectionIds } },
    // ★ 2026-10-12：改範圍 → 唔再同舊範圍嘅另一份「加埋一齊對」
    data: { systemTotal: null, resultJson: Prisma.DbNull, combineWithSectionId: null },
  })
}
