/**
 * ★ 2026-10-12：同一位醫生、同一間 Lab、同一個月有兩份（或以上）月結單 — 唔係 Lab 重發，係真係兩份單。
 * 用家揀「兩份加埋一齊對」→ 後上傳嗰段 combineWithSectionId 指去前一段。
 *
 * 組（group）= 同 Lab＋診所＋醫生＋月、有效文件（唔係 VOID／SUPERSEDED／DUPLICATE）入面，
 *   有 combineWithSectionId 嘅段 ＋ 俾人指住嘅段。少過 2 段 = 唔係組（例如其中一份作廢咗）。
 * 主段（primary）= 最早上傳嗰份。
 *
 * 錢嘅規則（一筆只計一次）：
 *   - 對數：組入面所有段嘅行加埋，同成本錄入（成本只計一次）比；結果寫晒落每段（resultJson.group）
 *   - 確認：一次確認成組
 *   - 上月結轉副本：只會同步入主段（其他段清走）
 *   - 成本錄入頁月結標示／待處理差異／逐店卡：只計主段
 *   - 月結單列表每份單用自己嘅行總數（ownStatementTotal），唔會兩份都顯示合計
 */

const INACTIVE_DOC = ['VOID', 'SUPERSEDED', 'DUPLICATE']

export interface CombineGroup {
  primaryId: string
  /** 主段先，之後按上傳時間 */
  memberIds: string[]
  members: Array<{ id: string; documentId: string; docCreatedAt: Date }>
}

/** 範圍入面全部有效段（同 Lab＋診所＋醫生＋月）。 */
async function scopeSections(client: any, scope: { labId: string; clinicId: string; providerId: string; month: string }) {
  const rows: any[] = await client.labStatementSection.findMany({
    where: {
      clinicId: scope.clinicId,
      providerId: scope.providerId,
      document: { kind: 'STATEMENT', labId: scope.labId, statementMonth: scope.month, status: { notIn: INACTIVE_DOC } },
    },
    select: { id: true, documentId: true, combineWithSectionId: true, document: { select: { createdAt: true } } },
  })
  return rows
}

/** 由一組範圍段計組（純函數）。 */
export function groupFromScope(rows: Array<{ id: string; documentId: string; combineWithSectionId: string | null; document: { createdAt: Date } }>): CombineGroup | null {
  const targets = new Set(rows.map((r) => r.combineWithSectionId).filter((x): x is string => !!x))
  const members = rows
    .filter((r) => r.combineWithSectionId || targets.has(r.id))
    .map((r) => ({ id: r.id, documentId: r.documentId, docCreatedAt: new Date(r.document.createdAt) }))
    .sort((a, b) => a.docCreatedAt.getTime() - b.docCreatedAt.getTime() || a.id.localeCompare(b.id))
  if (members.length < 2) return null
  return { primaryId: members[0].id, memberIds: members.map((m) => m.id), members }
}

/** 呢段屬唔屬一個「加埋一齊對」組；唔屬 → null。 */
export async function sectionCombineGroup(client: any, sectionId: string): Promise<CombineGroup | null> {
  const sec = await client.labStatementSection.findUnique({
    where: { id: sectionId },
    select: { clinicId: true, providerId: true, document: { select: { labId: true, statementMonth: true, status: true } } },
  })
  if (!sec?.clinicId || !sec.providerId || !sec.document?.labId || !sec.document?.statementMonth) return null
  if (INACTIVE_DOC.includes(sec.document.status)) return null
  const rows = await scopeSections(client, { labId: sec.document.labId, clinicId: sec.clinicId, providerId: sec.providerId, month: sec.document.statementMonth })
  const g = groupFromScope(rows)
  return g && g.memberIds.includes(sectionId) ? g : null
}

/**
 * resultJson：呢段係唔係組入面嘅「其他段」（唔係主段）— 標示／待處理／卡片只計主段。
 * activeIds：讀者手上嘅有效段 id；主段唔喺入面（例如已確認之後主段作廢咗、resultJson 未重寫）→ 當呢段自己計，唔會漏數。
 */
export function isNonPrimaryMember(sectionId: string, resultJson: unknown, activeIds?: Set<string>): boolean {
  const g = (resultJson as any)?.group
  if (!(g && typeof g.primarySectionId === 'string' && g.primarySectionId !== sectionId)) return false
  return activeIds ? activeIds.has(g.primarySectionId) : true
}

/**
 * 一份文件（準備作廢／被取代）嘅段所屬組入面，其他文件嘅段 id。要喺改文件狀態之前叫（之後佢已經唔喺範圍）。
 */
export async function otherGroupMembersOfDoc(client: any, documentId: string): Promise<string[]> {
  const secs: any[] = await client.labStatementSection.findMany({ where: { documentId }, select: { id: true } })
  const out = new Set<string>()
  for (const s of secs) {
    const g = await sectionCombineGroup(client, s.id)
    if (g) for (const m of g.members) if (m.documentId !== documentId) out.add(m.id)
  }
  return [...out]
}

/**
 * 組變咗（加埋／組員作廢／取代）→ 之前嘅確認係對住舊合計，唔再成立：已確認嘅段打返 PENDING、
 * 文件 RECONCILED → IN_PROGRESS（之後重對、要重新確認）。回傳打返未確認嘅段 id。喺 transaction 入面叫。
 */
export async function unconfirmSections(tx: any, sectionIds: string[]): Promise<string[]> {
  if (sectionIds.length === 0) return []
  const confirmed: any[] = await tx.labStatementSection.findMany({
    where: { id: { in: sectionIds }, status: 'CONFIRMED' },
    select: { id: true, documentId: true },
  })
  if (confirmed.length === 0) return []
  const ids = confirmed.map((c) => c.id as string)
  await tx.labStatementSection.updateMany({
    where: { id: { in: ids }, status: 'CONFIRMED' },
    data: { status: 'PENDING', confirmedBy: null, confirmedAt: null },
  })
  await tx.labDocument.updateMany({
    where: { id: { in: [...new Set(confirmed.map((c) => c.documentId as string))] }, status: 'RECONCILED' },
    data: { status: 'IN_PROGRESS' },
  })
  return ids
}
