/**
 * cwm-labdoc P3 — §8.2 reconcile core（route 同 auto-trigger 共用）
 *
 * 系統 invoice 範圍（spec §8.2）：kind=INVOICE、status ∈ {CONFIRMED, PARTIAL, RECONCILED}、
 * 同 labId/clinicId/providerId、docDate ∈ [月初−45 日, 月尾+10 日]。
 *
 * 流程：
 *  1. 讀 section＋lines＋document＋LabProfile
 *  2. matchSection（純函數，§8.2 三型）
 *  3. 寫回 lines：只有無 resolution 嘅行被覆寫（「重跑保留 resolution」）
 *  4. section：systemTotal（最終行狀態重算）、status OK|DIFF、resultJson 快照（§8.2.5）
 *  5. audit LAB_STATEMENT_RECONCILE（tx 後，跟 assign/supersede 口徑）
 *
 * 錯誤回 { ok:false, code }，唔 throw（auto-trigger 可 best-effort 吞）。
 */
import { matchSection, type MatchOutcome, type NotOnStatement, type SectionCtx, type StatementLineRow, type SystemInvoice, type SystemLine, type VirtualLine } from './statement-match'
import { labdocAudit } from './audit'

const SYSTEM_DOC_STATUSES = ['CONFIRMED', 'PARTIAL', 'RECONCILED']
const AMT_EPS = 0.01

export type ReconcileClient = any // Prisma 或 tx client（同型 API）

export interface ReconcileArgs {
  sectionId: string
  actorId: string | null
  source: 'manual' | 'auto'
  ipAddress?: string | null
  userAgent?: string | null
}

export type ReconcileFailure =
  | { ok: false; code: 'NOT_FOUND' | 'NOT_STATEMENT' | 'NEEDS_ASSIGN' | 'NO_MONTH'; message: string }

export interface ReconcileSuccess {
  ok: true
  sectionId: string
  documentId: string
  sectionStatus: 'OK' | 'DIFF'
  systemTotal: number
  statedForCheck: number | null
  counts: Record<string, number>
  virtualLinesCount: number
  notOnStatementCount: number
}

export function monthBounds(month: string): { from: Date; to: Date; lastDay: Date } {
  const [y, m] = month.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const lastDay = new Date(Date.UTC(y, m, 0)) // 月尾（UTC）
  const from = new Date(first.getTime() - 45 * 24 * 3600 * 1000)
  const to = new Date(lastDay.getTime() + 10 * 24 * 3600 * 1000)
  return { from, to, lastDay }
}

/** 最終行狀態 → 該行對 systemTotal 嘅貢獻（無 matched / 無金額 → 0）。 */
function lineContribution(
  o: { result: string; matchedDocumentId: string | null; matchedLineId: string | null },
  invoiceById: Map<string, SystemInvoice>,
  sysLineById: Map<string, SystemLine>,
): number {
  if (o.result !== 'MATCHED' && !o.result.endsWith('_DIFF')) return 0
  if (o.matchedLineId) {
    const sl = sysLineById.get(o.matchedLineId)
    return sl ? sl.amount : 0
  }
  if (o.matchedDocumentId) {
    const inv = invoiceById.get(o.matchedDocumentId)
    return inv && inv.total !== null ? inv.total : 0
  }
  return 0
}

/**
 * 寫入後重算 section 總數＋狀態（reconcile 同 STATEMENT_WINS 共用）：
 * - systemTotal = 最終行狀態嘅 MATCHED/*_DIFF 貢獻
 * - status = 冇「未解決」問題行 而且 stated = systemTotal → OK，否則 DIFF
 * - resultJson 快照（§8.2.5）
 * @returns null = section 已唔存在／唔屬呢個 doc
 */
export async function saveSectionTotals(
  tx: any,
  args: {
    sectionId: string
    documentId: string
    /** 全數行最終狀態（含 resolution） */
    finalLines: Array<{ result: string; matchedDocumentId: string | null; matchedLineId: string | null; resolution: string | null }>
    systemInvoices: SystemInvoice[]
    statedTotal: number | null
    statedCurrent: number | null
    /** OUTSTANDING 先使 statedCurrent，其他使 statedTotal */
    useCurrent: boolean
    source: string
    virtualLines: VirtualLine[]
    notOnStatement: NotOnStatement[]
  },
): Promise<{ status: 'OK' | 'DIFF'; systemTotal: number; counts: Record<string, number>; resultJson: Record<string, unknown> } | null> {
  const invoiceById = new Map<string, SystemInvoice>(args.systemInvoices.map((s) => [s.id, s]))
  const sysLineById = new Map<string, SystemLine>()
  for (const s of args.systemInvoices) for (const l of s.lines) sysLineById.set(l.id, l)
  const systemTotal = Math.round(
    args.finalLines.reduce((sum, f) => sum + lineContribution(f, invoiceById, sysLineById), 0) * 100,
  ) / 100
  const unresolvedProblem = args.finalLines.some(
    (f) => !f.resolution && l_result_isProblem(f.result),
  )
  const statedForCheck = args.useCurrent ? args.statedCurrent : args.statedTotal
  const totalsOk = statedForCheck !== null && Math.abs(statedForCheck - systemTotal) <= AMT_EPS
  const status: 'OK' | 'DIFF' = !unresolvedProblem && totalsOk ? 'OK' : 'DIFF'
  const counts: Record<string, number> = {}
  for (const f of args.finalLines) counts[f.result] = (counts[f.result] ?? 0) + 1
  const resultJson: Record<string, unknown> = {
    runAt: new Date().toISOString(),
    source: args.source,
    statedTotal: args.useCurrent ? args.statedCurrent : args.statedTotal,
    statedCurrent: args.statedCurrent,
    systemTotal,
    totalsOk,
    counts,
    virtualLines: args.virtualLines,
    notOnStatement: args.notOnStatement,
  }
  const upd = await tx.labStatementSection.updateMany({
    where: { id: args.sectionId, documentId: args.documentId },
    data: { status, systemTotal, resultJson },
  })
  return upd.count > 0 ? { status, systemTotal, counts, resultJson } : null
}

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
  if (!section.clinicId || !section.providerId) {
    return { ok: false, code: 'NEEDS_ASSIGN', message: '分段未指派診所／醫生' }
  }
  if (!doc.statementMonth) return { ok: false, code: 'NO_MONTH', message: '文件無 statementMonth' }

  const profile = await client.labProfile.findUnique({ where: { labId: doc.labId } })
  const ctx: SectionCtx = {
    kind: profile?.statementKind === 'DETAIL' || profile?.statementKind === 'OUTSTANDING' ? profile.statementKind : 'INVOICE_LIST',
    statementMonth: doc.statementMonth,
    docNoSameAsInvoice: profile?.statementDocNoSameAsInvoice ?? true,
  }

  // 2. 系統 invoice 範圍
  const { from, to } = monthBounds(doc.statementMonth)
  const systemDocs = await client.labDocument.findMany({
    where: {
      kind: 'INVOICE',
      status: { in: SYSTEM_DOC_STATUSES },
      labId: doc.labId,
      clinicId: section.clinicId,
      providerId: section.providerId,
      docDate: { gte: from, lte: to },
    },
    include: { lines: { orderBy: { lineIndex: 'asc' } } },
  })
  const systemInvoices: SystemInvoice[] = systemDocs.map((d: any) => ({
    id: d.id,
    docNo: d.docNo ?? null,
    docDate: d.docDate ?? null,
    total: d.total === null || d.total === undefined ? null : Number(d.total),
    lines: (d.lines as any[]).map((l: any) => ({
      id: l.id,
      description: l.description ?? '',
      toothRaw: l.toothRaw ?? null,
      qty: l.qty === null || l.qty === undefined ? null : Number(l.qty),
      unitPrice: l.unitPrice === null || l.unitPrice === undefined ? null : Number(l.unitPrice),
      amount: Number(l.amount),
      patientCode: l.patientCode ?? null,
    })),
  }))

  // 3. 之前已確認分段 MATCHED／已處理過嘅單號（C 型用）
  let previouslyMatchedDocNos = new Set<string>()
  if (ctx.kind === 'OUTSTANDING') {
    const prevSections = await client.labStatementSection.findMany({
      where: {
        status: 'CONFIRMED',
        clinicId: section.clinicId,
        providerId: section.providerId,
        document: { kind: 'STATEMENT', labId: doc.labId, statementMonth: { lt: doc.statementMonth }, id: { not: doc.id } },
      },
      // 之前「已處理」都算（2026-10-10 修：上線前舊欠款上月已 INVOICE_WINS／NOT_OURS，下月唔使再逐行處理）
      include: {
        lines: {
          where: { docNo: { not: null }, OR: [{ result: { in: ['MATCHED', 'PREVIOUSLY_MATCHED'] } }, { resolution: { not: null } }] },
          select: { docNo: true },
        },
      },
    })
    previouslyMatchedDocNos = new Set(prevSections.flatMap((s: any) => s.lines.map((l: any) => l.docNo).filter(Boolean)))
  }

  // 4. 純函數配對
  const lineRows: StatementLineRow[] = section.lines.map((l: any) => ({
    id: l.id,
    lineIndex: l.lineIndex,
    lineType: l.lineType,
    docNo: l.docNo ?? null,
    date: l.date ?? null,
    patientCode: l.patientCode ?? null,
    description: l.description ?? null,
    toothRaw: l.toothRaw ?? null,
    qty: l.qty === null || l.qty === undefined ? null : Number(l.qty),
    unitPrice: l.unitPrice === null || l.unitPrice === undefined ? null : Number(l.unitPrice),
    amount: Number(l.amount),
    agingBucket: l.agingBucket ?? null,
  }))
  const summary = matchSection(ctx, {
    statedTotal: section.statedTotal === null || section.statedTotal === undefined ? null : Number(section.statedTotal),
    statedCurrent: section.statedCurrent === null || section.statedCurrent === undefined ? null : Number(section.statedCurrent),
    lines: lineRows,
    systemInvoices,
    previouslyMatchedDocNos,
  })
  const outcomeByLineId = new Map(summary.outcomes.map((o) => [o.lineId, o]))

  // 5. 寫回（tx）：無 resolution 行先覆寫；已有 resolution 保留
  const result = await client.$transaction(async (tx: any) => {
    const finalLines: Array<{ result: string; matchedDocumentId: string | null; matchedLineId: string | null; resolution: string | null }> = []
    for (const l of section.lines) {
      const o = outcomeByLineId.get(l.id)
      if (!o) continue
      if (!l.resolution) {
        await tx.labStatementLine.updateMany({
          where: { id: l.id, resolution: null },
          data: {
            result: o.result,
            matchBasis: o.matchBasis,
            matchedDocumentId: o.matchedDocumentId,
            matchedLineId: o.matchedLineId,
          },
        })
        finalLines.push({ result: o.result, matchedDocumentId: o.matchedDocumentId, matchedLineId: o.matchedLineId, resolution: null })
      } else {
        // 保留舊 matched*（DB 現值）
        finalLines.push({ result: l.result, matchedDocumentId: l.matchedDocumentId, matchedLineId: l.matchedLineId, resolution: l.resolution })
      }
    }
    const saved = await saveSectionTotals(tx, {
      sectionId: section.id,
      documentId: doc.id,
      finalLines,
      systemInvoices,
      statedTotal: section.statedTotal === null || section.statedTotal === undefined ? null : Number(section.statedTotal),
      statedCurrent: section.statedCurrent === null || section.statedCurrent === undefined ? null : Number(section.statedCurrent),
      useCurrent: ctx.kind === 'OUTSTANDING',
      source: args.source,
      virtualLines: summary.virtualLines,
      notOnStatement: summary.notOnStatement,
    })
    return saved
  }, { timeout: 30_000 })

  if (result === null) {
    return { ok: false, code: 'NOT_FOUND', message: '分段已变动（版本衝突）' }
  }

  const statedForCheck = ctx.kind === 'OUTSTANDING'
    ? (section.statedCurrent === null || section.statedCurrent === undefined ? null : Number(section.statedCurrent))
    : (section.statedTotal === null || section.statedTotal === undefined ? null : Number(section.statedTotal))

  // 6. audit（tx 後 — 跟 assign/supersede 口徑；失敗唔倒撳 reconcile）
  try {
    await labdocAudit({
      action: 'LAB_STATEMENT_RECONCILE',
      entity: 'LabStatementSection',
      entityId: section.id,
      clinicId: section.clinicId,
      actorId: args.actorId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      notes: `reconcile ${args.source}（doc ${doc.id}）`,
      after: {
        sectionStatus: result.status,
        statedTotal: statedForCheck,
        systemTotal: result.systemTotal,
        delta: statedForCheck !== null ? Math.round((statedForCheck - result.systemTotal) * 100) / 100 : null,
        counts: result.counts,
        virtualLines: result.resultJson.virtualLines.length,
        notOnStatement: result.resultJson.notOnStatement.length,
      },
    })
  } catch (e) {
    console.error('[labdoc] reconcile audit failed', e)
  }

  return {
    ok: true,
    sectionId: section.id,
    documentId: doc.id,
    sectionStatus: result.status,
    systemTotal: result.systemTotal,
    statedForCheck,
    counts: result.counts,
    virtualLinesCount: result.resultJson.virtualLines.length,
    notOnStatementCount: result.resultJson.notOnStatement.length,
  }
}

function l_result_isProblem(r: string | undefined | null): boolean {
  if (!r) return false
  return r.endsWith('_DIFF') || r === 'MISSING_IN_SYSTEM' || r === 'NEEDS_MANUAL'
}

/**
 * §8.1 auto-trigger：分段 Lab＋診所＋醫生 齊（同 doc 有 statementMonth）→ 自動 reconcile。
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
    section = await client.labStatementSection.findUnique({ where: { id: sectionId }, include: { document: { select: { kind: true, statementMonth: true } } } })
  } catch (e) {
    console.error(`${logPrefix} autoReconcile read failed`, e)
    return null
  }
  if (!section || section.document?.kind !== 'STATEMENT' || !section.clinicId || !section.providerId || !section.document?.statementMonth) {
    return null
  }
  try {
    const r = await reconcileSection(client, { sectionId, actorId, source, ipAddress: null, userAgent: null })
    if (!r.ok && r.code !== 'NEEDS_ASSIGN' && r.code !== 'NO_MONTH') {
      console.error(`${logPrefix} autoReconcile failed (${r.code})`, r.message)
    }
    return r
  } catch (e) {
    console.error(`${logPrefix} autoReconcile error`, e)
    return null
  }
}
