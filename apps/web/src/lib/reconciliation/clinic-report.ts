// ============================================================
// ★ cwm-reconclinic-20261006：月報對數 —— 一次上載全店報表（逐行 Practitioner 欄）
//   1. 按 Practitioner 名分組
//   2. 名 → 醫生：先查已記住嘅名（ProviderReportName）；未記住就用單號
//      （Transaction Code ↔ ApricotBill.code）搵 Apricot 帳號 → ApricotPractitioner.providerId 建議
//   3. 每個醫生照用 compareReport（同單一醫生報表一樣，收窄到報表嗰間診所）
//   4. 系統有收入（> $0）但報表冇嘅醫生 → 列出（老闆：$0 唔使顯示）
//   醫生英文名唔使人手填：確認一次就記住；青衣等其他 Apricot 帳號一樣（名跟醫生，唔跟診所）。
// ============================================================
import { prisma } from '@/lib/prisma'
import type { ParsedRow } from './parsePaymentReport'

/** 名正規化：去頭尾空白、壓縮空格、細階 */
export const normName = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

export const BLANK_PRACTITIONER = '（報表冇寫醫生）'
/** 對應時揀「唔屬任何醫生」 */
export const SKIP_PROVIDER = '__SKIP__'

export interface PractitionerGroup {
  name: string
  nameNorm: string
  rows: ParsedRow[]
  /** 實收合計（同 compareReport reportTotal 一樣口徑） */
  total: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** 純函數：按 Practitioner 分組（空白歸一組，唔會靜靜跳過） */
export function groupByPractitioner(rows: ParsedRow[]): PractitionerGroup[] {
  const m = new Map<string, PractitionerGroup>()
  for (const r of rows) {
    const name = r.practitioner?.trim() || BLANK_PRACTITIONER
    const key = normName(name)
    const g = m.get(key) ?? { name, nameNorm: key, rows: [], total: 0 }
    g.rows.push(r)
    g.total = round2(g.total + (r.paid ?? r.charges ?? r.amount ?? 0))
    m.set(key, g)
  }
  return Array.from(m.values()).sort((a, b) => b.total - a.total)
}

/** 純函數：由單號配對結果揀最多票嘅醫生 */
export function pickSuggestion(votes: Map<string, number>, totalCodes: number): { providerId: string; matched: number; total: number } | null {
  let best: { providerId: string; matched: number } | null = null
  for (const [providerId, n] of votes) if (!best || n > best.matched) best = { providerId, matched: n }
  return best && best.matched > 0 ? { ...best, total: totalCodes } : null
}

export interface PractitionerResolution {
  name: string
  nameNorm: string
  count: number
  total: number
  /** 已記住嘅醫生 */
  providerId: string | null
  providerName: string | null
  /** 未記住時，單號配對建議 */
  suggestion: { providerId: string; providerName: string; matched: number; total: number } | null
}

/** 名 → 醫生（已記住）＋未記住嘅建議 */
export async function resolvePractitioners(groups: PractitionerGroup[]): Promise<PractitionerResolution[]> {
  const known = await prisma.providerReportName.findMany({
    where: { nameNorm: { in: groups.map(g => g.nameNorm) } },
    select: { nameNorm: true, providerId: true, provider: { select: { name: true } } },
  })
  const knownBy = new Map(known.map(k => [k.nameNorm, k]))

  // 未記住嘅組：單號 → ApricotBill.providerExtId → ApricotPractitioner.providerId
  const unknown = groups.filter(g => !knownBy.has(g.nameNorm))
  const codes = Array.from(new Set(unknown.flatMap(g => g.rows.map(r => r.code))))
  const bills = codes.length
    ? await prisma.apricotBill.findMany({ where: { code: { in: codes } }, select: { code: true, providerExtId: true } })
    : []
  const extIds = Array.from(new Set(bills.map(b => b.providerExtId).filter((x): x is string => !!x)))
  const accts = extIds.length
    ? await prisma.apricotPractitioner.findMany({ where: { apricotId: { in: extIds }, providerId: { not: null } }, select: { apricotId: true, providerId: true } })
    : []
  const providerOfExt = new Map(accts.map(a => [a.apricotId, a.providerId!]))
  const providerOfCode = new Map<string, string>()
  for (const b of bills) {
    const pid = b.providerExtId ? providerOfExt.get(b.providerExtId) : undefined
    if (pid) providerOfCode.set(b.code, pid)
  }
  const suggestionIds = new Set<string>()
  const votesBy = new Map<string, { votes: Map<string, number>; total: number }>()
  for (const g of unknown) {
    const uniq = Array.from(new Set(g.rows.map(r => r.code)))
    const votes = new Map<string, number>()
    for (const c of uniq) {
      const pid = providerOfCode.get(c)
      if (pid) votes.set(pid, (votes.get(pid) ?? 0) + 1)
    }
    votes.forEach((_, pid) => suggestionIds.add(pid))
    votesBy.set(g.nameNorm, { votes, total: uniq.length })
  }
  const names = suggestionIds.size
    ? new Map((await prisma.provider.findMany({ where: { id: { in: Array.from(suggestionIds) } }, select: { id: true, name: true } })).map(p => [p.id, p.name]))
    : new Map<string, string>()

  return groups.map(g => {
    const k = knownBy.get(g.nameNorm)
    const v = votesBy.get(g.nameNorm)
    const s = v ? pickSuggestion(v.votes, v.total) : null
    return {
      name: g.name, nameNorm: g.nameNorm, count: g.rows.length, total: g.total,
      providerId: k?.providerId ?? null,
      providerName: k?.provider.name ?? null,
      suggestion: s ? { ...s, providerName: names.get(s.providerId) ?? '' } : null,
    }
  })
}

/** 系統喺呢間店呢個月有收入（> $0）、但報表冇嘅醫生 */
export async function missingProviders(clinicExtId: string, periodMonth: string, presentProviderIds: Set<string>): Promise<Array<{ providerId: string; providerName: string; systemTotal: number }>> {
  const sums = await prisma.paymentAllocation.groupBy({
    by: ['providerExtId'],
    where: { isVoid: false, isSuperseded: false, clinicExtId, periodMonth },
    _sum: { amount: true },
  })
  const extIds = sums.map(s => s.providerExtId).filter((x): x is string => !!x)
  if (extIds.length === 0) return []
  const accts = await prisma.apricotPractitioner.findMany({
    where: { apricotId: { in: extIds }, providerId: { not: null } },
    select: { apricotId: true, providerId: true, provider: { select: { name: true } } },
  })
  const byProvider = new Map<string, { providerName: string; systemTotal: number }>()
  for (const s of sums) {
    const a = accts.find(x => x.apricotId === s.providerExtId)
    if (!a?.providerId || presentProviderIds.has(a.providerId)) continue
    const cur = byProvider.get(a.providerId) ?? { providerName: a.provider?.name ?? '', systemTotal: 0 }
    cur.systemTotal = round2(cur.systemTotal + Number(s._sum.amount ?? 0))
    byProvider.set(a.providerId, cur)
  }
  return Array.from(byProvider.entries())
    .filter(([, v]) => Math.abs(v.systemTotal) > 0.005)
    .map(([providerId, v]) => ({ providerId, ...v }))
}
