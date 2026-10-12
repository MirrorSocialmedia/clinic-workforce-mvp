/**
 * ★ 2026-10-11：月結單行「計入下個月」結轉（用家拍板）。
 *
 * 例：KEA 9 月月結單有 2609260002 $440，但成本錄入係 10 月到貨 → 9 月行標 NEXT_MONTH：
 *   - 9 月：呢行唔計入月結單總數（同備貨一樣排除）
 *   - 10 月：同 Lab＋診所＋醫生嘅有效月結單分段，對數前同步一行「上月結轉」副本
 *     （LabStatementLine.carriedFromLineId → 9 月嗰行），計入 10 月總數
 *   - 單號重複：10 月月結單自己都列咗同一個單號 → 副本唔計（只計 10 月單上嗰行），唔會計兩次
 *   - 10 月都未有成本 → 副本可以再標 NEXT_MONTH 帶去 11 月（鏈）
 *
 * 錢嘅一致性（一行喺任何時候只會計一次）：
 *   - 副本只喺「未確認」分段同步（加／刪）；已確認分段嘅副本凍結
 *   - 來源行（或者佢嘅副本鏈）已經喺已確認分段計咗 → 唔准取消 NEXT_MONTH／改成其他標記／改分段基礎
 *     （carryLockedCount）
 *   - 標 NEXT_MONTH 前：下個月嗰段已確認 → 擋；下個月月結單已經有同一個單號 → 擋（唔使結轉）
 *   - 同步喺 transaction 入面先鎖分段（SELECT … FOR UPDATE），唔會並發插兩次（另有 unique(sectionId, carriedFromLineId)）
 */

export const NEXT_MONTH = 'NEXT_MONTH'
const INACTIVE_DOC = ['VOID', 'SUPERSEDED', 'DUPLICATE']
const COUNTED_TYPES = ['INVOICE', 'CREDIT', 'CHARGE']
/** 結轉鏈最多跟幾多層（防資料異常無限循環） */
const MAX_CHAIN = 24

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface CarryScope {
  labId: string
  clinicId: string
  providerId: string
  month: string
}

/** 某 Lab＋診所＋醫生＋月 嘅有效月結單分段（文件唔係 VOID／SUPERSEDED／DUPLICATE）。 */
export async function activeScopeSections(client: any, scope: CarryScope): Promise<Array<{ id: string; status: string }>> {
  return client.labStatementSection.findMany({
    where: {
      clinicId: scope.clinicId,
      providerId: scope.providerId,
      document: { kind: 'STATEMENT', labId: scope.labId, statementMonth: scope.month, status: { notIn: INACTIVE_DOC } },
    },
    select: { id: true, status: true },
  })
}

/**
 * 呢啲行（同佢哋嘅結轉副本鏈）有冇已經喺「已確認」分段計咗。
 * > 0 → 唔准取消 NEXT_MONTH／改標記／改分段基礎（否則同一筆錢會計兩次或者冇咗）。
 */
export async function carryLockedCount(client: any, lineIds: string[]): Promise<number> {
  let frontier = [...new Set(lineIds)]
  let locked = 0
  const seen = new Set<string>(frontier)
  for (let depth = 0; depth < MAX_CHAIN && frontier.length > 0; depth++) {
    const copies: Array<{ id: string; resolution: string | null; section: { status: string } }> = await client.labStatementLine.findMany({
      where: { carriedFromLineId: { in: frontier } },
      select: { id: true, resolution: true, section: { select: { status: true } } },
    })
    locked += copies.filter((c) => c.section.status === 'CONFIRMED').length
    frontier = copies.filter((c) => c.resolution === NEXT_MONTH && !seen.has(c.id)).map((c) => c.id)
    for (const id of frontier) seen.add(id)
  }
  return locked
}

/** 分段入面標咗 NEXT_MONTH 嘅行有冇已經鎖死（改分段基礎前用）。 */
export async function sectionsCarryLocked(client: any, sectionIds: string[]): Promise<number> {
  if (sectionIds.length === 0) return 0
  const lines: Array<{ id: string }> = await client.labStatementLine.findMany({
    where: { sectionId: { in: sectionIds }, resolution: NEXT_MONTH },
    select: { id: true },
  })
  return lines.length ? carryLockedCount(client, lines.map((l) => l.id)) : 0
}

export const CARRY_LOCKED_MSG = '有行「計入下個月」已經喺下個月（已確認）計咗 — 唔可以再改；要改請先喺下個月嗰段處理'

/**
 * 標 NEXT_MONTH 前檢查下個月：
 *  - 下個月同 Lab＋診所＋醫生 有分段已確認 → 擋（副本加唔入已確認分段，筆錢會冇咗）
 *  - 下個月月結單已經列咗同一個單號 → 擋（唔使結轉，下個月本身已計）
 */
export async function nextMonthCarryBlock(
  client: any,
  scope: CarryScope,
  docNo: string | null,
): Promise<string | null> {
  const next = shiftMonth(scope.month, 1)
  const targets = await activeScopeSections(client, { ...scope, month: next })
  if (targets.some((t) => t.status === 'CONFIRMED')) {
    // 例如舊版月結單作廢前已經結轉、下個月已確認 → 下個月已經計咗呢張單
    if (docNo) {
      const already = await client.labStatementLine.count({
        where: { sectionId: { in: targets.map((t) => t.id) }, carriedFromLineId: { not: null }, docNo },
      })
      if (already > 0) return `${next} 已經確認、而且已經計咗呢張單（單號 ${docNo}，由上月結轉）— 呢度請標「唔關我哋事」，唔好計兩次`
    }
    return `${next} 嗰段月結單已經確認咗 — 唔可以再計入下個月`
  }
  if (docNo && targets.length > 0) {
    const dup = await client.labStatementLine.count({
      where: { sectionId: { in: targets.map((t) => t.id) }, carriedFromLineId: null, docNo },
    })
    if (dup > 0) return `${next} 月結單已經有呢張單（單號 ${docNo}）— 唔使計入下個月；如果係 Lab 重複收，請標「唔關我哋事」`
  }
  return null
}

/**
 * 對數前同步「上月結轉」副本（要喺 reconcile 讀行之前叫）。
 * 來源 = 上個月同 Lab＋診所＋醫生 有效月結單分段入面 resolution NEXT_MONTH、金額唔係 0 嘅計數行。
 *  - 分段已確認 → 唔郁（凍結）
 *  - 分段未齊 Lab／月份／診所／醫生 → 清走所有副本（範圍唔成立）
 *  - 來源冇咗（取消、作廢、取代）→ 刪副本；新來源 → 加副本（lineIndex 接住最大嗰個）
 * 回傳有冇改動（加／刪）。
 */
export async function syncCarriedLines(client: any, sectionId: string, opts: { carryInto?: boolean } = {}): Promise<boolean> {
  // ★ 2026-10-12：「兩份加埋一齊對」組入面唔係主段 → 唔收結轉（清走），結轉只入主段，唔會計兩次
  const carryInto = opts.carryInto !== false
  return client.$transaction(async (tx: any) => {
    // 鎖分段：同一段同時對數唔會插兩次
    await tx.$queryRaw`SELECT "id" FROM "LabStatementSection" WHERE "id" = ${sectionId} FOR UPDATE`
    const section = await tx.labStatementSection.findUnique({
      where: { id: sectionId },
      select: {
        id: true, status: true, clinicId: true, providerId: true,
        document: { select: { kind: true, labId: true, statementMonth: true, status: true } },
      },
    })
    if (!section || section.status === 'CONFIRMED' || section.document?.kind !== 'STATEMENT') return false
    const existing: Array<{ id: string; carriedFromLineId: string }> = await tx.labStatementLine.findMany({
      where: { sectionId, carriedFromLineId: { not: null } },
      select: { id: true, carriedFromLineId: true },
    })
    const doc = section.document
    const inScope = carryInto && !!(doc.labId && doc.statementMonth && section.clinicId && section.providerId) && !INACTIVE_DOC.includes(doc.status)
    let sources: any[] = []
    let prev = ''
    if (inScope) {
      prev = shiftMonth(doc.statementMonth, -1)
      const srcSections = await activeScopeSections(tx, { labId: doc.labId, clinicId: section.clinicId, providerId: section.providerId, month: prev })
      if (srcSections.length > 0) {
        sources = await tx.labStatementLine.findMany({
          where: { sectionId: { in: srcSections.map((s) => s.id) }, resolution: NEXT_MONTH, lineType: { in: COUNTED_TYPES } },
          orderBy: [{ sectionId: 'asc' }, { lineIndex: 'asc' }],
        })
        sources = sources.filter((l) => Math.abs(Number(l.amount)) > 0.001)
      }
    }
    const srcIds = new Set(sources.map((l) => l.id))
    const stale = existing.filter((e) => !srcIds.has(e.carriedFromLineId)).map((e) => e.id)
    const have = new Set(existing.map((e) => e.carriedFromLineId))
    const missing = sources.filter((l) => !have.has(l.id))
    if (stale.length > 0) {
      await tx.labStatementLine.deleteMany({ where: { id: { in: stale }, sectionId, carriedFromLineId: { not: null } } })
    }
    if (missing.length > 0) {
      const max = await tx.labStatementLine.aggregate({ where: { sectionId }, _max: { lineIndex: true } })
      let idx = (max?._max?.lineIndex ?? -1) + 1
      await tx.labStatementLine.createMany({
        data: missing.map((l) => ({
          sectionId,
          lineIndex: idx++,
          lineType: l.lineType,
          docNoRaw: l.docNoRaw,
          docNo: l.docNo,
          date: l.date,
          patientRaw: null, // 病人姓名唔複製（B8）
          patientCode: l.patientCode,
          labCaseRef: l.labCaseRef,
          description: l.description,
          toothRaw: l.toothRaw,
          qty: l.qty,
          unitPrice: l.unitPrice,
          amount: l.amount,
          agingBucket: null,
          result: 'PENDING',
          carriedFromLineId: l.id,
          carriedFromMonth: prev,
        })),
      })
    }
    return stale.length > 0 || missing.length > 0
  }, { timeout: 30_000 })
}
