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
import { syncCarriedLines, activeScopeSections, shiftMonth, type CarryScope } from './statement-carry'
import { sectionCombineGroup } from './statement-combine'

export type ReconcileClient = any // Prisma 或 tx client（同型 API）

/** 對數時保留嘅行標記（其他舊 invoice 對法嘅標記會清走） */
const KEEP_RESOLUTIONS = new Set(['STOCK', 'NOT_OURS', 'STATEMENT_WINS', 'NEXT_MONTH'])

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
  // ★ 2026-10-12：同 Lab＋診所＋醫生＋月「兩份加埋一齊對」→ 成組一齊對（statement-combine.ts）
  const group = await sectionCombineGroup(client, args.sectionId)
  const memberIds: string[] = group ? group.memberIds : [args.sectionId]

  // 0. ★ 2026-10-11：同步「上月結轉」副本（已確認分段唔郁）；組入面只會入主段
  for (const id of memberIds) {
    await syncCarriedLines(client, id, { carryInto: !group || id === group.primaryId })
  }

  // 1. 讀（組：全部成員）
  const loaded: any[] = []
  for (const id of memberIds) {
    const sec = await client.labStatementSection.findUnique({
      where: { id },
      include: {
        document: true,
        lines: { orderBy: { lineIndex: 'asc' } },
      },
    })
    if (sec) loaded.push(sec)
  }
  const section = loaded.find((x) => x.id === args.sectionId)
  if (!section) return { ok: false, code: 'NOT_FOUND', message: '分段唔存在' }
  const doc = section.document
  if (doc.kind !== 'STATEMENT') return { ok: false, code: 'NOT_STATEMENT', message: '唔係月結單' }
  if (loaded.some((x) => x.status === 'CONFIRMED')) return { ok: false, code: 'CONFIRMED', message: '分段已確認' }
  if (!doc.labId) return { ok: false, code: 'NO_LAB', message: '月結單未揀 Lab — 返月結單頁撳「改 Lab／月份」揀咗先' }
  if (!doc.statementMonth) return { ok: false, code: 'NO_MONTH', message: '月結單未揀月份 — 返月結單頁撳「改 Lab／月份」揀咗先' }
  const members = group ? loaded : [section]

  const profile = await client.labProfile.findUnique({ where: { labId: doc.labId } })
  const outstanding = profile?.statementKind === 'OUTSTANDING'

  // 組：唔同份單嘅 lineIndex 會撞 → 加偏移保持「每份單自己嘅次序」（連續行配對靠次序）
  const lineIn: CostLineIn[] = members.flatMap((sec: any, mi: number) => sec.lines.map((l: any) => ({
    id: l.id,
    lineIndex: mi * 1_000_000 + l.lineIndex,
    lineType: l.lineType,
    amount: Number(l.amount),
    qty: toNum(l.qty),
    unitPrice: toNum(l.unitPrice),
    date: l.date ?? null,
    agingBucket: l.agingBucket ?? null,
    resolution: l.resolution && KEEP_RESOLUTIONS.has(l.resolution) ? l.resolution : null,
    pairMode: l.pairMode ?? null,
    pairCostCaseId: l.pairCostCaseId ?? null,
    docNo: l.docNo ?? null,
    carriedFromLineId: l.carriedFromLineId ?? null,
  })))

  // 2. 成本錄入（組都係同一個範圍 → 只查一次、只計一次）
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
  const statedOf = (sec: any) => (outstanding ? toNum(sec.statedCurrent) : toNum(sec.statedTotal))
  // 組：每份都有印總數先加埋比；任何一份冇 → 唔做讀數檢查
  const stateds = members.map(statedOf)
  const statedTotal = stateds.some((x: number | null) => x === null) ? null : Math.round(stateds.reduce((a: number, b: number | null) => a + (b ?? 0), 0) * 100) / 100
  const m = matchStatementToCosts({ lines: lineIn, costs, outstanding, statementMonth: doc.statementMonth, statedTotal })

  const counts: Record<string, number> = {}
  for (const l of m.lines) counts[l.result] = (counts[l.result] ?? 0) + 1
  // 每份單自己計入嘅金額（列表／總覽用，唔會兩份都顯示合計）
  const resultById = new Map(m.lines.map((l) => [l.id, l.result]))
  const ownTotal = (sec: any) => Math.round(sec.lines
    .filter((l: any) => { const r = resultById.get(l.id); return r === 'MATCHED' || r === 'UNPAIRED' })
    .reduce((a: number, l: any) => a + Number(l.amount), 0) * 100) / 100
  const groupInfo = group
    ? {
        primarySectionId: group.primaryId,
        memberSectionIds: group.memberIds,
        members: members.map((sec: any) => ({ sectionId: sec.id, documentId: sec.documentId, ownStatementTotal: ownTotal(sec) })),
      }
    : null
  const baseJson = {
    mode: 'COST',
    runAt: new Date().toISOString(),
    source: args.source,
    statementTotal: m.statementTotal,
    costTotal: m.costTotal,
    diff: m.diff,
    totalsOk: m.status === 'OK',
    stockTotal: m.stockTotal,
    notOursTotal: m.notOursTotal,
    nextMonthTotal: m.nextMonthTotal,
    carryInTotal: m.carryInTotal,
    carryDuplicateLineIds: m.carryDuplicateLineIds,
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

  // 3–4. 寫回（組：每份單嘅行寫返自己段；每段寫同一組結果＋自己總數）
  const lineById = new Map<string, any>(members.flatMap((sec: any) => sec.lines.map((l: any) => [l.id, { ...l, sectionId: sec.id }])))
  const saved = await client.$transaction(async (tx: any) => {
    for (const o of m.lines) {
      const prev = lineById.get(o.id)
      if (!prev) continue
      const keepRes = prev.resolution && KEEP_RESOLUTIONS.has(prev.resolution)
      await tx.labStatementLine.updateMany({
        where: { id: o.id, sectionId: prev.sectionId },
        data: {
          result: o.result,
          matchBasis: o.costCaseId ? 'COST' : null,
          matchedDocumentId: null,
          matchedLineId: null,
          ...(keepRes ? {} : { resolution: null, resolutionNote: null, resolvedBy: null, resolvedAt: null, followUpClosedAt: null, followUpClosedBy: null }),
        },
      })
    }
    for (const sec of members) {
      const json = groupInfo ? { ...baseJson, group: groupInfo, ownStatementTotal: ownTotal(sec) } : baseJson
      const upd = await tx.labStatementSection.updateMany({
        where: { id: sec.id, documentId: sec.documentId, status: { not: 'CONFIRMED' } },
        data: { status: m.status, systemTotal: m.costTotal, resultJson: json },
      })
      if (upd.count === 0) return false
      // 未指派但成段唔使計（備貨）→ 唔再當未識別；全部分段齊 → 文件 IN_PROGRESS（§3.4）
      if (sec.document.status === 'NEEDS_REVIEW') {
        const all = await tx.labStatementSection.findMany({ where: { documentId: sec.documentId }, select: { clinicId: true, providerId: true, status: true } })
        if (all.length > 0 && all.every((x: any) => (x.clinicId && x.providerId) || x.status !== 'NEEDS_ASSIGN')) {
          await tx.labDocument.updateMany({ where: { id: sec.documentId, status: 'NEEDS_REVIEW' }, data: { status: 'IN_PROGRESS' } })
        }
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
        nextMonthTotal: m.nextMonthTotal,
        carryInTotal: m.carryInTotal,
        group: groupInfo ? { primarySectionId: groupInfo.primarySectionId, memberSectionIds: groupInfo.memberSectionIds } : null,
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

/**
 * ★ 2026-10-11：「計入下個月」有改動（標／取消／作廢／取代／改分段基礎）→ 下個月（同 Lab＋診所＋醫生）
 * 未確認分段即刻重新同步＋對數，總數唔會停喺舊數；鏈落去（再下個月）都一齊（最多 12 層）。
 * best-effort：失敗只 log（下次對數／確認前會再同步）。
 */
export async function reconcileCarryTargets(
  client: ReconcileClient,
  scopes: Array<Partial<CarryScope> | null | undefined>,
  actorId: string | null,
  depth = 0,
): Promise<void> {
  if (depth >= 12) return
  const seen = new Set<string>()
  for (const sc of scopes) {
    if (!sc?.labId || !sc.clinicId || !sc.providerId || !sc.month) continue
    const next = shiftMonth(sc.month, 1)
    const key = `${sc.labId}|${sc.clinicId}|${sc.providerId}|${next}`
    if (seen.has(key)) continue
    seen.add(key)
    let targets: Array<{ id: string; status: string }> = []
    try {
      targets = await activeScopeSections(client, { labId: sc.labId, clinicId: sc.clinicId, providerId: sc.providerId, month: next })
    } catch (e) {
      console.error('[labdoc] carry targets read failed', e)
      continue
    }
    let touched = false
    for (const t of targets) {
      if (t.status === 'CONFIRMED') continue
      const r = await autoReconcileIfReady(client, t.id, actorId, 'auto', '[labdoc:carry]')
      if (r) touched = true
    }
    if (touched) await reconcileCarryTargets(client, [{ ...sc, month: next }], actorId, depth + 1)
  }
}

/** 分段 → 結轉範圍（Lab＋診所＋醫生＋月）；未齊回 null。 */
export async function sectionCarryScopes(client: ReconcileClient, sectionIds: string[]): Promise<Array<CarryScope | null>> {
  if (sectionIds.length === 0) return []
  const secs: any[] = await client.labStatementSection.findMany({
    where: { id: { in: sectionIds } },
    select: { clinicId: true, providerId: true, document: { select: { labId: true, statementMonth: true } } },
  })
  return secs.map((s) =>
    s.clinicId && s.providerId && s.document?.labId && s.document?.statementMonth
      ? { labId: s.document.labId, clinicId: s.clinicId, providerId: s.providerId, month: s.document.statementMonth }
      : null,
  )
}

/**
 * 改動已經寫入之後叫：下個月結轉同步（best-effort，永遠唔 throw — 唔可以令已成功嘅寫入變 500）。
 * 下次對數／確認前 reconcileSection 都會再同步，所以呢度失敗只係遲啲更新。
 */
export async function afterCarryChange(
  client: ReconcileClient,
  opts: { sectionIds?: string[]; scopes?: Array<CarryScope | null> },
  actorId: string | null,
): Promise<void> {
  try {
    const scopes = [...(opts.scopes ?? []), ...(opts.sectionIds?.length ? await sectionCarryScopes(client, opts.sectionIds) : [])]
    // ★ 2026-10-12：同月同範圍其他段（「兩份加埋一齊對」組可能變咗：作廢／取代／改範圍）→ 重對
    const seen = new Set<string>()
    for (const sc of scopes) {
      if (!sc) continue
      const key = `${sc.labId}|${sc.clinicId}|${sc.providerId}|${sc.month}`
      if (seen.has(key)) continue
      seen.add(key)
      const same = await activeScopeSections(client, sc)
      for (const t of same) if (t.status !== 'CONFIRMED') await autoReconcileIfReady(client, t.id, actorId, 'auto', '[labdoc:scope]')
    }
    await reconcileCarryTargets(client, scopes, actorId)
  } catch (e) {
    console.error('[labdoc] carry re-sync failed', e)
  }
}
