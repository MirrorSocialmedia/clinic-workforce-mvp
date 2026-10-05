/**
 * cwm-labdoc P2 — §7.5 核對動作 primitives（行配對 / B7 主單 / 改價 / labInvoiceLinked 重算）。
 *
 * 全部設計做「條件寫 + 撞咗就 throw」，由 caller（§7.8 儲存分組 transaction）catch 轉 409/400。
 * T5 相鄰：同行對兩筆成本 → 第二個 0 行 → LineTakenError（409）。
 * T6 相鄰：同成本做兩張單 MAIN → 第二個 MainTakenError（400）。
 * T2 相鄰：改價 → baseCost/finalCost=linkedSum、discountPct=null（B4）、PENDING→PRICED。
 * T7 相鄰：成本已鎖（lockedByRunId）改價 → PriceLockedError（409）。
 */
import { assertAuditInputClean } from './audit-pii'

export class LineTakenError extends Error {
  constructor(lineId: string) {
    super(`LINE_TAKEN:${lineId}`)
    this.name = 'LineTakenError'
  }
}

export class MainTakenError extends Error {
  constructor(docNo: string | null) {
    super(`MAIN_TAKEN:${docNo ?? 'unknown'}`)
    this.name = 'MainTakenError'
  }
}

export class PriceLockedError extends Error {
  constructor(costCaseId: string) {
    super(`PRICE_LOCKED:${costCaseId}`)
    this.name = 'PriceLockedError'
  }
}

export class CostInvalidError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'CostInvalidError'
  }
}

/**
 * §7.8 step 4（T5）：行條件寫。
 * `UPDATE LabDocumentLine SET status='MATCHED', costCaseId=…, linkType=…, matchedBy/At
 *  WHERE id=… AND (status='UNMATCHED' OR (status='MATCHED' AND costCaseId=…))`
 * 影響 0 行 → throw LineTakenError。
 */
export async function matchLine(
  tx: any,
  args: { lineId: string; costCaseId: string; linkType: 'MAIN' | 'SUPPLEMENT' | 'REDO'; actorId: string },
): Promise<void> {
  const r = await tx.labDocumentLine.updateMany({
    where: {
      id: args.lineId,
      OR: [{ status: 'UNMATCHED' }, { status: 'MATCHED', costCaseId: args.costCaseId }],
    },
    data: {
      status: 'MATCHED',
      costCaseId: args.costCaseId,
      linkType: args.linkType,
      matchedBy: args.actorId,
      matchedAt: new Date(),
    },
  })
  if (r.count === 0) throw new LineTakenError(args.lineId)
}

/**
 * §7.8 step 4（UNMATCH 方向）：行解除（只喺未連或連住同一筆時 — 避免兩邊同時改）。
 */
export async function unmatchLine(
  tx: any,
  args: { lineId: string; expectedCostCaseId: string | null; actorId: string },
): Promise<void> {
  await tx.labDocumentLine.updateMany({
    where: {
      id: args.lineId,
      costCaseId: args.expectedCostCaseId === null ? null : args.expectedCostCaseId,
    },
    data: {
      status: 'UNMATCHED',
      costCaseId: null,
      linkType: null,
      matchedBy: args.actorId,
      matchedAt: null,
    },
  })
}

/**
 * §7.8 step 5（B7，T6）：同一筆成本嘅 MAIN 行只可以嚟自一張單。
 * 查呢筆成本已有嘅 MATCHED MAIN 行（排除本單）→ 有就 throw MainTakenError。
 */
export async function assertNoOtherMain(
  tx: any,
  args: { costCaseId: string; docId: string },
): Promise<void> {
  const rows = await tx.labDocumentLine.findMany({
    where: { costCaseId: args.costCaseId, status: 'MATCHED', linkType: 'MAIN', documentId: { not: args.docId } },
    select: { documentId: true, document: { select: { docNo: true } } },
    take: 1,
  })
  if (rows.length > 0) {
    throw new MainTakenError(rows[0].document?.docNo ?? null)
  }
}

/**
 * §7.5：linkedSum(cc) = 該成本所有 MATCHED 行（包括其他 invoice 嘅補收費／重做）＋今次要連嘅行嘅 amount 總和。
 * @param tx
 * @param args.costCaseId
 * @param args.pendingAmounts 今次要連嘅行（尚未寫 DB）嘅 amount
 */
export async function computeLinkedSumDb(
  tx: any,
  args: { costCaseId: string; pendingAmounts: number[] },
): Promise<number> {
  const rows: Array<{ amount: any }> = await tx.labDocumentLine.findMany({
    where: { costCaseId: args.costCaseId, status: 'MATCHED' },
    select: { amount: true },
  })
  const dbSum = rows.reduce((s: number, r) => s + Number(r.amount || 0), 0)
  return dbSum + args.pendingAmounts.reduce((s: number, a: number) => s + (Number(a) || 0), 0)
}

export interface PriceUpdateArgs {
  costCaseId: string
  /** linkedSum（§7.5） */
  newAmount: number
  docId: string
  lineIds: string[]
  actorId: string
  clinicId: string | null
}

/**
 * §7.5 填入／改做（T2）：baseCost = linkedSum、discountPct = null（B4）、finalCost = baseCost、
 * PENDING → PRICED；條件寫 lockedByRunId IS NULL（0 行 → PriceLockedError，T7）；
 * audit LAB_DOC_PRICE_UPDATE（before/after baseCost、finalCost、discountPct；notes：docId、lineIds）。
 * 必須喺 caller 嘅 transaction 入面行（audit 同寫入同 atom）。
 */
export async function applyPriceUpdate(tx: any, args: PriceUpdateArgs): Promise<void> {
  const before = await tx.costCase.findUnique({
    where: { id: args.costCaseId },
    select: { baseCost: true, finalCost: true, discountPct: true, lockedByRunId: true, status: true },
  })
  if (!before) throw new CostInvalidError('成本唔存在')
  if (before.status === 'VOID') throw new CostInvalidError('成本已作廢')

  const r = await tx.costCase.updateMany({
    where: { id: args.costCaseId, lockedByRunId: null },
    data: {
      baseCost: args.newAmount,
      discountPct: null, // B4：labInvoiceLinked → 唔套 LabMonthlyDiscount
      finalCost: args.newAmount,
      status: 'PRICED',
    },
  })
  if (r.count === 0) throw new PriceLockedError(args.costCaseId)

  assertAuditInputClean({
    notes: `經 Lab 單據改價 lines=[${args.lineIds.join(',')}] doc=${args.docId}`,
    before: {
      baseCost: before.baseCost == null ? null : Number(before.baseCost),
      finalCost: before.finalCost == null ? null : Number(before.finalCost),
      discountPct: before.discountPct == null ? null : Number(before.discountPct),
    },
    after: { baseCost: args.newAmount, finalCost: args.newAmount, discountPct: null },
  })
  await tx.auditLog.create({
    data: {
      actorId: args.actorId,
      action: 'LAB_DOC_PRICE_UPDATE',
      entity: 'CostCase',
      entityId: args.costCaseId,
      clinicId: args.clinicId,
      beforeJson: JSON.stringify({
        baseCost: before.baseCost == null ? null : Number(before.baseCost),
        finalCost: before.finalCost == null ? null : Number(before.finalCost),
        discountPct: before.discountPct == null ? null : Number(before.discountPct),
      }),
      afterJson: JSON.stringify({ baseCost: args.newAmount, finalCost: args.newAmount, discountPct: null }),
      notes: `經 Lab 單據改價 lines=[${args.lineIds.join(',')}] doc=${args.docId}`,
    },
  })
}

/**
 * §7.8 step 8：CostCase.labInvoiceLinked 重算（有任何 MATCHED 行 → true；一旦 true 唔會 false，B4 方向）。
 * （文件狀態重算用 reconcile.recomputeInvoiceDocStatus — 單一來源。）
 */
export async function recalcLabInvoiceLinked(tx: any, costCaseIds: string[]): Promise<void> {
  for (const id of [...new Set(costCaseIds)]) {
    const rows = await tx.labDocumentLine.findMany({
      where: { costCaseId: id, status: 'MATCHED' },
      select: { id: true },
      take: 1,
    })
    if (rows.length > 0) {
      await tx.costCase.updateMany({ where: { id }, data: { labInvoiceLinked: true } })
    }
  }
}
