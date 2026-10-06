/**
 * lib/payout/daily-report.ts — 每日大數（cwm-dailyrev-20261003）
 *
 * 醫生月結「每日大數」頁 + 匯出：揀日期（或範圍）＋診所／醫生，直接由 PaymentAllocation 計，
 * 唔使先開月結單。格式同醫生月結 Excel「A 逐日收款」一樣：
 *   ① 揀診所（唔揀醫生）→ 行 = 醫生（範圍內合計）
 *   ② 揀醫生 → 行 = 逐日（範圍內每日一行，冇收款嘅日都出）
 *
 * 口徑（同 report-data.ts / engine.ts 一字不差，唔准另起爐灶）：
 *   - ACTIVE_ALLOCATION（isVoid=false, isSuperseded=false）
 *   - 欄 = colKey（方法 + 雙旗），排序 METHOD_ORDER，label 括號提示同 Excel
 *   - storeIncome = countAsIncome → TOTAL（店舖營收）
 *   - doctorIncome = countAsIncome || FREE_SP → 醫生收入（收款／淨額）
 *   - 日子 = paidAt 嘅 HK 日
 *   - SP 筆數 = CONFIRMED SpSubsidy，按 bill billTime HK 日
 *   - 醫生分成 = Σ(醫生收入淨額 × 該月該店拆帳%)（pickCommission）——
 *     ⚠️ 未扣 Lab／植牙成本、未計 SP 補貼／轉介／調整（呢啲係月結先有）
 * ★★★ 純讀，唔寫任何金額。
 */
import { prisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd, toHKDateStr, addDaysStr } from '@/lib/hk-date'
import { resolveApricotAccounts } from '@/lib/apricot-accounts'
import { ACTIVE_ALLOCATION, pickCommission } from '@/lib/payout/engine'
import { METHOD_ORDER, METHOD_LABELS, colKey, methodOf, round2 } from '@/lib/payout/report-data'

export const DAILY_MAX_DAYS = 62

export interface DailyAlloc {
  method: string
  amount: number
  net: number
  countAsIncome: boolean
  paidAt: Date
  providerExtId: string | null
  clinicExtId: string
}

export interface DailyMethod { key: string; label: string; storeIncome: boolean; doctorIncome: boolean }

export interface DailyRow {
  key: string // byDoctor：providerId（或 'ext:<apricotId>'）；byDay：YYYY-MM-DD
  label: string
  byMethod: Record<string, number> // colKey → 收款（未扣手續費）
  storeTotal: number // TOTAL：店舖營收（countAsIncome）
  doctorRaw: number // 醫生收入收款
  doctorNet: number // 醫生收入淨額（扣手續費）
  share: number | null // 醫生分成（未扣成本）；冇拆帳設定 = null
  spCount: number
}

export interface DailyReport {
  mode: 'byDoctor' | 'byDay'
  from: string
  to: string
  title: string
  methods: DailyMethod[]
  rows: DailyRow[]
  totals: DailyRow
  /** 冇拆帳設定嘅醫生名（分成顯示「—」） */
  missingCommission: string[]
  /** 單一醫生 + 單一診所 + 單一月份先有一個固定 % */
  percent: number | null
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
export function dayLabel(d: string): string {
  const dow = new Date(`${d}T12:00:00+08:00`).getUTCDay()
  return `${d.slice(8, 10)}/${d.slice(5, 7)}（${WEEK[dow]}）`
}

export function methodsOf(allocs: DailyAlloc[]): DailyMethod[] {
  const seen: string[] = []
  for (const a of allocs) {
    const m = a.method.trim()
    if (!m) continue
    const k = colKey(m, a.countAsIncome, a.countAsIncome || m === 'FREE_SP')
    if (!seen.includes(k)) seen.push(k)
  }
  const first = new Map(seen.map((k, i) => [k, i]))
  seen.sort((a, b) => {
    const ra = METHOD_ORDER.indexOf(methodOf(a))
    const rb = METHOD_ORDER.indexOf(methodOf(b))
    if (ra !== -1 && rb !== -1) return ra - rb
    if (ra !== -1) return -1
    if (rb !== -1) return 1
    return (first.get(a) ?? 0) - (first.get(b) ?? 0)
  })
  return seen.map(k => {
    const [m, s, d] = k.split('|')
    return {
      key: k,
      label: (METHOD_LABELS[m] || m) + (d === '0' ? '（不計醫生收入）' : s === '0' ? '（不計店舖營收）' : ''),
      storeIncome: s === '1',
      doctorIncome: d === '1',
    }
  })
}

function emptyRow(key: string, label: string): DailyRow {
  return { key, label, byMethod: {}, storeTotal: 0, doctorRaw: 0, doctorNet: 0, share: 0, spCount: 0 }
}

/**
 * 純函數：allocation → 行。
 * groupOf(a) 回行 key（byDay = HK 日；byDoctor = 醫生 key）；null = 唔入（例如診所帳號）。
 * percentOf(a) 回該筆適用嘅拆帳 %（0–100）；null = 冇設定（該行 share = null）。
 */
export function aggregateDaily(
  allocs: DailyAlloc[],
  rowsInit: { key: string; label: string }[],
  groupOf: (a: DailyAlloc) => string | null,
  percentOf: (a: DailyAlloc) => number | null,
  spCountOf: (rowKey: string) => number,
): { methods: DailyMethod[]; rows: DailyRow[]; totals: DailyRow } {
  const methods = methodsOf(allocs)
  const rows = new Map<string, DailyRow>(rowsInit.map(r => [r.key, emptyRow(r.key, r.label)]))
  const shareRaw = new Map<string, number>() // 未 round 嘅分成（逐筆累加，最後先 round2）
  for (const a of allocs) {
    const g = groupOf(a)
    if (!g) continue
    let row = rows.get(g)
    if (!row) { row = emptyRow(g, g); rows.set(g, row) }
    const m = a.method.trim()
    if (!m) continue
    const store = a.countAsIncome
    const doctor = a.countAsIncome || m === 'FREE_SP'
    const k = colKey(m, store, doctor)
    row.byMethod[k] = (row.byMethod[k] ?? 0) + a.amount
    if (store) row.storeTotal += a.amount
    if (doctor) {
      row.doctorRaw += a.amount
      row.doctorNet += a.net
      const pct = percentOf(a)
      if (pct == null) row.share = null
      else if (row.share != null) shareRaw.set(g, (shareRaw.get(g) ?? 0) + a.net * pct / 100)
    }
  }
  const out = [...rows.values()]
  for (const r of out) {
    for (const k of Object.keys(r.byMethod)) r.byMethod[k] = round2(r.byMethod[k])
    r.storeTotal = round2(r.storeTotal)
    r.doctorRaw = round2(r.doctorRaw)
    r.doctorNet = round2(r.doctorNet)
    if (r.share != null) r.share = round2(shareRaw.get(r.key) ?? 0)
    r.spCount = spCountOf(r.key)
  }
  const totals = emptyRow('total', 'Total')
  for (const r of out) {
    for (const [k, v] of Object.entries(r.byMethod)) totals.byMethod[k] = round2((totals.byMethod[k] ?? 0) + v)
    totals.storeTotal = round2(totals.storeTotal + r.storeTotal)
    totals.doctorRaw = round2(totals.doctorRaw + r.doctorRaw)
    totals.doctorNet = round2(totals.doctorNet + r.doctorNet)
    // 合計分成 = 有設定嗰啲加埋；冇設定嘅醫生由 missingCommission 列出（頁面提示「部分」）
    totals.share = round2((totals.share ?? 0) + (r.share ?? 0))
    totals.spCount += r.spCount
  }
  return { methods, rows: out, totals }
}

export class DailyReportError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length <= DAILY_MAX_DAYS; d = addDaysStr(d, 1)) out.push(d)
  return out
}

/**
 * 攞數。clinicId / providerId 至少一個。scopeClinics = null 代表全部診所可見。
 */
export async function loadDailyReport(opts: {
  from: string
  to?: string | null
  clinicId?: string | null
  providerId?: string | null
  scopeClinics: string[] | null
}): Promise<DailyReport> {
  const from = opts.from
  const to = opts.to || opts.from
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new DailyReportError('日期格式要 YYYY-MM-DD')
  if (to < from) throw new DailyReportError('「至」唔可以早過開始日期')
  const days = daysBetween(from, to)
  if (days.length > DAILY_MAX_DAYS) throw new DailyReportError(`日期範圍最多 ${DAILY_MAX_DAYS} 日`)
  if (!opts.clinicId && !opts.providerId) throw new DailyReportError('請揀診所或醫生')
  if (opts.clinicId && opts.scopeClinics && !opts.scopeClinics.includes(opts.clinicId)) {
    throw new DailyReportError('You do not have access to this clinic', 403)
  }

  // ─── 診所（apricotClinicId ↔ Clinic.id）────────────────────────
  const clinics = await prisma.clinic.findMany({
    where: {
      apricotClinicId: { not: null },
      ...(opts.clinicId ? { id: opts.clinicId } : opts.scopeClinics ? { id: { in: opts.scopeClinics } } : {}),
    },
    select: { id: true, name: true, shortName: true, apricotClinicId: true },
  })
  if (opts.clinicId && clinics.length === 0) throw new DailyReportError('診所未對應 Apricot ID')
  const clinicByExt = new Map(clinics.map(c => [c.apricotClinicId as string, c]))

  // ─── 醫生 ────────────────────────────────────────────────────────
  const provider = opts.providerId
    ? await prisma.provider.findUnique({ where: { id: opts.providerId }, select: { id: true, name: true, shortName: true } })
    : null
  if (opts.providerId && !provider) throw new DailyReportError('醫生不存在', 404)
  let providerExtIds: string[] | null = null
  if (provider) {
    const rows = await prisma.apricotPractitioner.findMany({
      where: { providerId: provider.id, kind: 'PROVIDER' },
      select: { apricotId: true },
    })
    providerExtIds = rows.map(r => r.apricotId)
    // ★ 同 engine B3：冇綁帳號唔准當「唔 filter」
    if (providerExtIds.length === 0) throw new DailyReportError(`醫生「${provider.name}」冇綁任何 Apricot 帳號`)
  }

  const raw = await prisma.paymentAllocation.findMany({
    where: {
      ...ACTIVE_ALLOCATION,
      paidAt: { gte: hkDateStart(from), lte: hkDateEnd(to) },
      clinicExtId: { in: [...clinicByExt.keys()] },
      ...(providerExtIds ? { providerExtId: { in: providerExtIds } } : { providerExtId: { not: null } }),
    },
    select: { methodNorm: true, amount: true, netAmount: true, countAsIncome: true, paidAt: true, providerExtId: true, clinicExtId: true },
  })
  const allocs: DailyAlloc[] = raw.map(a => ({
    method: a.methodNorm,
    amount: Number(a.amount),
    net: Number(a.netAmount),
    countAsIncome: a.countAsIncome,
    paidAt: a.paidAt,
    providerExtId: a.providerExtId,
    clinicExtId: a.clinicExtId,
  }))

  // ─── 帳號 → 醫生（byDoctor 分組 + 拆帳% 用）────────────────────
  const accounts = await resolveApricotAccounts(prisma, [...new Set(allocs.map(a => a.providerExtId).filter(Boolean) as string[])])
  const providerIdOf = (a: DailyAlloc): string | null => {
    if (provider) return provider.id
    const acc = a.providerExtId ? accounts.get(a.providerExtId) : null
    return acc?.kind === 'PROVIDER' ? (acc.providerId ?? null) : null
  }
  const providerIds = [...new Set(allocs.map(providerIdOf).filter(Boolean) as string[])]
  const providerRows = providerIds.length
    ? await prisma.provider.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true, shortName: true } })
    : []
  const providerName = new Map(providerRows.map(p => [p.id, p.name]))

  // ─── 拆帳%：(醫生, 月, 診所) → % ─────────────────────────────────
  const pctCache = new Map<string, number | null>()
  const pctKey = (pid: string, a: DailyAlloc) => `${pid}|${toHKDateStr(a.paidAt).slice(0, 7)}|${clinicByExt.get(a.clinicExtId)?.id ?? ''}`
  for (const a of allocs) {
    const pid = providerIdOf(a)
    if (!pid) continue
    const k = pctKey(pid, a)
    if (pctCache.has(k)) continue
    const [, month, cid] = k.split('|')
    const c = await pickCommission(pid, month, cid || undefined)
    pctCache.set(k, c ? Number(c.percent) : null)
  }
  const percentOf = (a: DailyAlloc): number | null => {
    const pid = providerIdOf(a)
    return pid ? (pctCache.get(pctKey(pid, a)) ?? null) : null
  }

  // ─── SP 筆數（CONFIRMED，按 bill 日）─────────────────────────────
  const months = [...new Set(days.map(d => d.slice(0, 7)))]
  const sps = await prisma.spSubsidy.findMany({
    where: {
      status: 'CONFIRMED',
      periodMonth: { in: months },
      ...(provider ? { providerId: provider.id } : { providerId: { in: providerIds } }),
      ...(opts.clinicId ? { clinicId: opts.clinicId } : { clinicId: { in: clinics.map(c => c.id) } }),
    },
    select: { providerId: true, billExtId: true },
  })
  const bills = sps.length
    ? await prisma.apricotBill.findMany({ where: { extId: { in: [...new Set(sps.map(s => s.billExtId))] } }, select: { extId: true, billTime: true } })
    : []
  const billDay = new Map(bills.map(b => [b.extId, toHKDateStr(b.billTime)]))
  const spCount = new Map<string, number>()
  for (const s of sps) {
    const d = billDay.get(s.billExtId)
    if (!d || d < from || d > to) continue
    const k = provider ? d : s.providerId
    spCount.set(k, (spCount.get(k) ?? 0) + 1)
  }

  const clinicLabel = opts.clinicId ? (clinics[0].shortName || clinics[0].name) : '全部診所'
  const rangeLabel = from === to ? `${from}${dayLabel(from).slice(5)}` : `${from} 至 ${to}`

  if (provider) {
    // ② 逐日
    const agg = aggregateDaily(
      allocs,
      days.map(d => ({ key: d, label: dayLabel(d) })),
      a => toHKDateStr(a.paidAt),
      percentOf,
      k => spCount.get(k) ?? 0,
    )
    const pcts = [...new Set([...pctCache.values()])]
    return {
      mode: 'byDay', from, to,
      title: `${provider.name} · ${clinicLabel} · ${rangeLabel}`,
      ...agg,
      missingCommission: pcts.includes(null) ? [provider.name] : [],
      percent: pcts.length === 1 && pcts[0] != null ? pcts[0] : null,
    }
  }

  // ① 逐醫生（未綁醫生嘅 PROVIDER 帳號用 Apricot 名獨立一行；CLINIC 帳號 = 診所雜項，唔入）
  const groupOf = (a: DailyAlloc): string | null => {
    const pid = providerIdOf(a)
    if (pid) return pid
    const acc = a.providerExtId ? accounts.get(a.providerExtId) : null
    if (acc?.kind === 'CLINIC') return null
    return `ext:${a.providerExtId}`
  }
  const keys = [...new Set(allocs.map(groupOf).filter(Boolean) as string[])]
  const labelOf = (k: string) => k.startsWith('ext:')
    ? `（未綁）${accounts.get(k.slice(4))?.name ?? k.slice(4)}`
    : (providerName.get(k) ?? k)
  const agg = aggregateDaily(
    allocs,
    keys.map(k => ({ key: k, label: labelOf(k) })),
    groupOf,
    percentOf,
    k => spCount.get(k) ?? 0,
  )
  agg.rows.sort((a, b) => b.storeTotal - a.storeTotal || a.label.localeCompare(b.label))
  return {
    mode: 'byDoctor', from, to,
    title: `${clinicLabel} · ${rangeLabel}`,
    ...agg,
    missingCommission: agg.rows.filter(r => r.share == null && r.doctorRaw > 0).map(r => r.label),
    percent: null,
  }
}
