/**
 * cwm-labdoc — 月結單分段對數核心（route 同 auto-trigger 共用）
 *
 * 2026-10-11 改：系統方由「上傳咗嘅 invoice」改為「成本錄入」（CostCase）。
 *   範圍：同 Lab ＋ 同診所 ＋ 同醫生 ＋ periodMonth（到貨日月份）＝ 月結單月份，status ≠ VOID。
 *   比總數決定 OK／DIFF；按金額劃埋只係提示（statement-cost-match.ts）。
 *
 * 流程：
 *  1. 讀 section＋lines＋document＋LabProfile（欠款型只計本月）
 *  2. 查成本錄入 → matchStatementToCosts（純函數）
 *  3. 寫回 lines（result／matchBasis；舊 invoice 配對欄清走；STOCK／NOT_OURS／STATEMENT_WINS 標記保留）
 *  4. section：systemTotal = Σ 成本、status OK|DIFF、resultJson 快照（mode=COST）
 *  5. audit LAB_STATEMENT_RECONCILE（tx 後）
 *
 * 分段未有診所／醫生：如果冇要計嘅行（例如成段標咗備貨）→ 照對（0 = 0）；否則 NEEDS_ASSIGN。
 * 錯誤回 { ok:false, code }，唔 throw（auto-trigger 可 best-effort 吞）。
 */
import { matchStatementToCosts, lineInScope, EXCLUDE_RESOLUTIONS, type CostCaseIn, type CostLineIn } from './statement-cost-match'
import { labdocAudit } from './audit'

export type ReconcileClient = any // Prisma 或 tx client（同型 API）

/** 對數時保留嘅行標記（其他舊 invoice 對法嘅標記會清走） */
const KEEP_RESOLUTIONS = new Set(['STOCK', 'NOT_OURS', 'STATEMENT_WINS'])

export interface ReconcileArgs {
  sectionId: string
  actorId: string | null
  source: 'manual' | 'auto'
  ipAddress?: string | null
  userAgent?: string | null
}

export type ReconcileFailure =
  | { ok: false; code: 'NOT_FOUND' | 'NOT_STATEMENT' | 'NEEDS_ASSIGN' | 'NO_MONTH' | 'NO_LAB' | 'CONFIRMED'; message: string }

export interface ReconcileSuccess {
  ok: true
  sectionId: string
  documentId: string
  sectionStatus: 'OK' | 'DIFF'
  statementTotal: number
  costTotal: number
  diff: number
  /** = costTotal（舊欄名，route 回傳兼容） */
  systemTotal: number
}

/** 'YYYY-MM' → 月初至月尾（UTC；from／to 預留 −45／+10 日窗俾舊 invoice 查詢用）。 */
export function monthBounds(month: string): { from: Date; to: Date; lastDay: Date } {
  const [y, m] = month.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const lastDay = new Date(Date.UTC(y, m, 0)) // 月尾（UTC）
  const from = new Date(first.getTime() - 45 * 24 * 3600 * 1000)
  const to = new Date(lastDay.getTime() + 10 * 24 * 3600 * 1000)
  return { from, to, lastDay }
}

/** 分段對應嘅成本錄入範圍（GET 都用嚟計「上次對數之後有冇改」）。 */
export function costScopeWhere(args: { labId: string; clinicId: string; providerId: string; month: string }) {
  return {
    labId: args.labId,
    clinicId: args.clinicId,
    providerId: args.providerId,
    periodMonth: args.month,
    status: { not: 'VOID' },
  }
}

const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export async function reconcileSection(
  client: ReconcileClient,
  args: ReconcileArgs,
): Promise<ReconcileSuccess | ReconcileFailure> {
  // 1. 讀
  const section = await client.labStatementSection.findUnique({
    where: { id: args.sectionId },
    include: {
      document: true,
      lines: { orderBy: { lineIndex: 'asc' } },
    },
  })
  if (!section) return { ok: false, code: 'NOT_FOUND', message: '分段唔存在' }
  const doc = section.document
  if (doc.kind !== 'STATEMENT') return { ok: false, code: 'NOT_STATEMENT', message: '唔係月結單' }
  if (section.status === 'CONFIRMED') return { ok: false, code: 'CONFIRMED', message: '分段已確認' }
  if (!doc.labId) return { ok: false, code: 'NO_LAB', message: '月結單未揀 Lab — 返月結單頁撳「改 Lab／月份」揀咗先' }
  if (!doc.statementMonth) return { ok: false, code: 'NO_MONTH', message: '月結單未揀月份 — 返月結單頁撳「改 Lab／月份」揀咗先' }

  const profile = await client.labProfile.findUnique({ where: { labId: doc.labId } })
  const outstanding = profile?.statementKind === 'OUTSTANDING'

  const lineIn: CostLineIn[] = section.lines.map((l: any) => ({
    id: l.id,
    lineIndex: l.lineIndex,
    lineType: l.lineType,
    amount: Number(l.amount),
    qty: toNum(l.qty),
    unitPrice: toNum(l.unitPrice),
    date: l.date ?? null,
    agingBucket: l.agingBucket ?? null,
    resolution: l.resolution && KEEP_RESOLUTIONS.has(l.resolution) ? l.resolution : null,
    pairMode: l.pairMode ?? null,
    pairCostCaseId: l.pairCostCaseId ?? null,
  }))

  // 2. 成本錄入
  const assigned = !!section.clinicId && !!section.providerId
  let costRows: any[] = []
  if (assigned) {
    costRows = await client.costCase.findMany({
      where: costScopeWhere({ labId: doc.labId, clinicId: section.clinicId, providerId: section.providerId, month: doc.statementMonth }),
      select: { id: true, patientCode: true, itemType: true, itemTypeOther: true, finalCost: true, status: true, receivedAt: true, note: true },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    })
  } else {
    // 未指派：仲有要計嘅行 → 要先揀診所／醫生；全部係備貨／唔關我哋事／$0 → 照對（0 = 0）
    const needsCount = lineIn.some(
      (l) => lineInScope(l, lineIn, outstanding, doc.statementMonth) && Math.abs(l.amount) > 0.001 && !(l.resolution && EXCLUDE_RESOLUTIONS.has(l.resolution)),
    )
    if (needsCount) return { ok: false, code: 'NEEDS_ASSIGN', message: '分段未指派診所／醫生' }
  }
  const costs: CostCaseIn[] = costRows.map((c) => ({
    id: c.id,
    patientCode: c.patientCode ?? null,
    itemType: c.itemType === 'Others' && c.itemTypeOther ? c.itemTypeOther : c.itemType ?? null,
    finalCost: toNum(c.finalCost),
    status: c.status,
    receivedAt: c.receivedAt ?? null,
  }))

  const costNote = new Map<string, string | null>(costRows.map((c) => [c.id, c.note ?? null]))
  const statedTotal = outstanding ? toNum(section.statedCurrent) : toNum(section.statedTotal)
  const m = matchStatementToCosts({ lines: lineIn, costs, outstanding, statementMonth: doc.statementMonth, statedTotal })

  const counts: Record<string, number> = {}
  for (const l of m.lines) counts[l.result] = (counts[l.result] ?? 0) + 1
  const resultJson = {
    mode: 'COST',
    runAt: new Date().toISOString(),
    source: args.source,
    statementTotal: m.statementTotal,
    costTotal: m.costTotal,
    diff: m.diff,
    totalsOk: m.status === 'OK',
    stockTotal: m.stockTotal,
    notOursTotal: m.notOursTotal,
    unpricedCount: m.unpricedCount,
    readCheck: m.readCheck,
    pairs: m.pairs,
    unpairedCostIds: m.unpairedCostIds,
    // 成本快照（只有病人編號，冇姓名）
    costs: costs.map((c) => ({
      id: c.id,
      patientCode: c.patientCode,
      itemType: c.itemType,
      finalCost: c.finalCost,
      status: c.status,
      receivedAt: c.receivedAt ? c.receivedAt.toISOString().slice(0, 10) : null,
      // 成本錄入備註（例如「$190 補差價」）— 人手配對時幫手認
      note: costNote.get(c.id) ?? null,
    })),
    counts,
    // 舊 invoice 對法嘅欄位（待處理 NOT_ON_STATEMENT 讀）— 新對法冇
    virtualLines: [],
    notOnStatement: [],
  }

  // 3–4. 寫回
  const lineById = new Map<string, any>(section.lines.map((l: any) => [l.id, l]))
  const saved = await client.$transaction(async (tx: any) => {
    for (const o of m.lines) {
      const prev = lineById.get(o.id)
      const keepRes = prev?.resolution && KEEP_RESOLUTIONS.has(prev.resolution)
      await tx.labStatementLine.updateMany({
        where: { id: o.id, sectionId: section.id },
        data: {
          result: o.result,
          matchBasis: o.costCaseId ? 'COST' : null,
          matchedDocumentId: null,
          matchedLineId: null,
          ...(keepRes ? {} : { resolution: null, resolutionNote: null, resolvedBy: null, resolvedAt: null, followUpClosedAt: null, followUpClosedBy: null }),
        },
      })
    }
    const upd = await tx.labStatementSection.updateMany({
      where: { id: section.id, documentId: doc.id, status: { not: 'CONFIRMED' } },
      data: { status: m.status, systemTotal: m.costTotal, resultJson },
    })
    if (upd.count === 0) return false
    // 未指派但成段唔使計（備貨）→ 唔再當未識別；全部分段齊 → 文件 IN_PROGRESS（§3.4）
    if (doc.status === 'NEEDS_REVIEW') {
      const all = await tx.labStatementSection.findMany({ where: { documentId: doc.id }, select: { clinicId: true, providerId: true, status: true } })
      if (all.length > 0 && all.every((x: any) => (x.clinicId && x.providerId) || x.status !== 'NEEDS_ASSIGN')) {
        await tx.labDocument.updateMany({ where: { id: doc.id, status: 'NEEDS_REVIEW' }, data: { status: 'IN_PROGRESS' } })
      }
    }
    return true
  }, { timeout: 30_000 })

  if (!saved) {
    return { ok: false, code: 'NOT_FOUND', message: '分段已變動（可能啱啱確認咗）' }
  }

  // 5. audit（tx 後；失敗唔倒撳 reconcile）
  try {
    await labdocAudit({
      action: 'LAB_STATEMENT_RECONCILE',
      entity: 'LabStatementSection',
      entityId: section.id,
      clinicId: section.clinicId,
      actorId: args.actorId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      notes: `reconcile ${args.source}（doc ${doc.id}，對成本錄入）`,
      after: {
        sectionStatus: m.status,
        statementTotal: m.statementTotal,
        costTotal: m.costTotal,
        delta: m.diff,
        stockTotal: m.stockTotal,
        notOursTotal: m.notOursTotal,
        costCount: costs.length,
        pairs: m.pairs.length,
        counts,
      },
    })
  } catch (e) {
    console.error('[labdoc] reconcile audit failed', e)
  }

  return {
    ok: true,
    sectionId: section.id,
    documentId: doc.id,
    sectionStatus: m.status,
    statementTotal: m.statementTotal,
    costTotal: m.costTotal,
    diff: m.diff,
    systemTotal: m.costTotal,
  }
}

/**
 * auto-trigger：分段有 Lab＋月份 → 自動對數（診所／醫生未齊由 reconcileSection 判斷）。
 * best-effort：失敗只 log（分段留 PENDING，人手可重跑）。
 */
export async function autoReconcileIfReady(
  client: ReconcileClient,
  sectionId: string,
  actorId: string | null,
  source: 'manual' | 'auto' = 'auto',
  logPrefix = '[labdoc]',
): Promise<ReconcileSuccess | ReconcileFailure | null> {
  let section: any
  try {
    section = await client.labStatementSection.findUnique({ where: { id: sectionId }, include: { document: { select: { kind: true, statementMonth: true, labId: true } } } })
  } catch (e) {
    console.error(`${logPrefix} autoReconcile read failed`, e)
    return null
  }
  if (!section || section.document?.kind !== 'STATEMENT' || section.status === 'CONFIRMED' || !section.document?.statementMonth || !section.document?.labId) {
    return null
  }
  if (!section.clinicId || !section.providerId) return null
  try {
    const r = await reconcileSection(client, { sectionId, actorId, source, ipAddress: null, userAgent: null })
    if (!r.ok && r.code !== 'NEEDS_ASSIGN' && r.code !== 'NO_MONTH' && r.code !== 'NO_LAB') {
      console.error(`${logPrefix} autoReconcile failed (${r.code})`, r.message)
    }
    return r
  } catch (e) {
    console.error(`${logPrefix} autoReconcile error`, e)
    return null
  }
}

/**
 * 月結單總覽頂部：成份月結單 vs 成本錄入（同 Lab、同月、月結單涉及嘅診所）。
 * uncovered = 嗰幾間診所有成本、但月結單冇呢位醫生嘅分段（例如 Lab 漏咗、或者醫生揀錯）。
 */
export async function statementCostSummary(
  client: ReconcileClient,
  doc: { labId: string | null; statementMonth: string | null },
  sections: Array<{ clinicId: string | null; providerId: string | null; resultJson: unknown }>,
): Promise<{
  statementTotal: number
  costTotal: number
  diff: number
  stockTotal: number
  uncovered: Array<{ clinicId: string; providerId: string; total: number; count: number }>
} | null> {
  if (!doc.labId || !doc.statementMonth) return null
  const r2 = (n: number) => Math.round(n * 100) / 100
  let statementTotal = 0
  let costTotal = 0
  let stockTotal = 0
  for (const s of sections) {
    const rj = (s.resultJson ?? {}) as any
    if (rj.mode !== 'COST') continue
    statementTotal += Number(rj.statementTotal ?? 0)
    costTotal += Number(rj.costTotal ?? 0)
    stockTotal += Number(rj.stockTotal ?? 0)
  }
  const clinicIds = [...new Set(sections.map((s) => s.clinicId).filter((x): x is string => !!x))]
  const covered = new Set(sections.filter((s) => s.clinicId && s.providerId).map((s) => `${s.clinicId}|${s.providerId}`))
  const uncovered: Array<{ clinicId: string; providerId: string; total: number; count: number }> = []
  if (clinicIds.length > 0) {
    const rows = await client.costCase.findMany({
      where: { labId: doc.labId, periodMonth: doc.statementMonth, clinicId: { in: clinicIds }, status: { not: 'VOID' } },
      select: { clinicId: true, providerId: true, finalCost: true },
    })
    const agg = new Map<string, { clinicId: string; providerId: string; total: number; count: number }>()
    for (const c of rows) {
      const k = `${c.clinicId}|${c.providerId}`
      if (covered.has(k)) continue
      const a = agg.get(k) ?? { clinicId: c.clinicId, providerId: c.providerId, total: 0, count: 0 }
      a.total = r2(a.total + (c.finalCost == null ? 0 : Number(c.finalCost)))
      a.count++
      agg.set(k, a)
    }
    uncovered.push(...agg.values())
  }
  statementTotal = r2(statementTotal)
  costTotal = r2(costTotal)
  return { statementTotal, costTotal, diff: r2(statementTotal - costTotal), stockTotal: r2(stockTotal), uncovered }
}
