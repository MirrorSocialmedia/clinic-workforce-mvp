// ============================================================
// ★ cwm-costdetail-20261006：醫生月結預覽 —— 成本明細（已計入／當月未計入提醒）＋月結頁「成本異常」
//   計入規則同 engine.computePayout 一模一樣（唔好喺度另訂一套）：
//     periodMonth = 本月、status ≠ VOID、finalCost ≠ null → 計入
//   periodMonth 由 deriveCostPeriod 定：LAB／INVISALIGN 跟到貨日（未到貨 = null）；IMPLANT 跟落單日。
//   提醒（唔計錢，只係俾人檢查有冇漏）：
//     UNPRICED   本月到貨（periodMonth = 本月）、未有價錢 → 而家當 $0
//     NOT_RECV   本月落單、未到貨
//     LAST_MONTH 上月落單（或上月到貨）仍未完成（cwm-lastmonth-20261006，老闆要求）：
//                  · 未到貨：上月落單；連埋更早但 60 日內落單嘅（同「成本異常」60 日接駁，唔會漏）
//                  · 未有價錢：上月落單或者上月到貨（到貨月 ≠ 本月）—— 上月月結當咗 $0；
//                    該月已鎖就要手動調整（periodLocked）
//   超過 60 日未到貨、到貨月份早過上月仍未有價錢 → 月結頁「成本異常」。
//   🔴 病人只出編號（patientCode），唔出姓名。
// ============================================================
import { prisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd, addDaysStr, toHKDateStr } from '@/lib/hk-date'
import { UNNAMED_VENDOR } from './engine'

export const STALE_DAYS = 60
export const COST_CATEGORIES = ['LAB', 'IMPLANT', 'INVISALIGN'] as const
export type CostCategory = (typeof COST_CATEGORIES)[number]

export interface CostRow {
  id: string
  category: string
  orderedAt: string // YYYY-MM-DD（HK）
  receivedAt: string | null
  patientCode: string
  vendor: string
  item: string
  amount: number | null
  status: string
  periodMonth: string | null
  /** 落單月 ≠ 計入月（例：8 月落單、9 月到） */
  crossMonth: boolean
  redo: boolean
  daysWaiting?: number
  /** 上月未完成嘅原因 */
  pending?: 'NOT_RECEIVED' | 'UNPRICED'
  /** 未有價錢嗰張單嘅到貨月份月結已鎖定（補價唔會自動計） */
  periodLocked?: boolean
}

export interface CategoryDetail {
  counted: CostRow[]
  countedTotal: number
  unpriced: CostRow[]
  notReceived: CostRow[]
  /** 上月落單／上月到貨仍未完成（未到貨或者未有價錢） */
  lastMonth: CostRow[]
  voided: CostRow[]
  /** 要人手檢查嘅數目（unpriced + notReceived + lastMonth） */
  reminders: number
}

export type CostDetail = Record<CostCategory, CategoryDetail>

/** 'YYYY-MM' 加減月 */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * 純函數：分類（DB 已經揀好範圍）
 * @param recentFromStr 今日 − 60 日：未到貨早過上月但喺呢日之後落單 → 都入「上月未完成」（未去到成本異常）
 * @param lockedMonths  呢個醫生 × 診所已鎖定月結嘅月份
 */
export function classifyCostRows(rows: CostRow[], periodMonth: string, recentFromStr: string, lockedMonths: Set<string> = new Set()): CategoryDetail {
  const counted: CostRow[] = []
  const unpriced: CostRow[] = []
  const notReceived: CostRow[] = []
  const lastMonth: CostRow[] = []
  const voided: CostRow[] = []
  const prevMonth = shiftMonth(periodMonth, -1)
  const monthStartStr = `${periodMonth}-01`
  const orderMonth = (r: CostRow) => r.orderedAt.slice(0, 7)
  for (const r of rows) {
    if (r.status === 'VOID') {
      if (r.periodMonth === periodMonth || orderMonth(r) === periodMonth) voided.push(r)
      continue
    }
    if (r.periodMonth === periodMonth) {
      // 同 engine：finalCost ≠ null 先計
      if (r.amount != null) counted.push(r)
      else unpriced.push(r)
      continue
    }
    if (r.periodMonth == null) {
      if (r.category === 'IMPLANT') continue
      if (orderMonth(r) === periodMonth) notReceived.push(r)
      else if (r.orderedAt < monthStartStr && (orderMonth(r) === prevMonth || r.orderedAt >= recentFromStr)) {
        lastMonth.push({ ...r, pending: 'NOT_RECEIVED' })
      }
      continue
    }
    // 已到貨（到貨月 ≠ 本月）但未有價錢：上月落單或者上月到貨
    if (r.amount == null && (orderMonth(r) === prevMonth || r.periodMonth === prevMonth)) {
      lastMonth.push({ ...r, pending: 'UNPRICED', periodLocked: lockedMonths.has(r.periodMonth) })
    }
  }
  const byDate = (k: 'orderedAt' | 'receivedAt') => (a: CostRow, b: CostRow) => (a[k] ?? '').localeCompare(b[k] ?? '')
  counted.sort(byDate('receivedAt'))
  unpriced.sort(byDate('receivedAt'))
  notReceived.sort(byDate('orderedAt'))
  lastMonth.sort(byDate('orderedAt'))
  const countedTotal = Math.round(counted.reduce((s, r) => s + (r.amount ?? 0), 0) * 100) / 100
  return {
    counted, countedTotal, unpriced, notReceived, lastMonth, voided,
    reminders: unpriced.length + notReceived.length + lastMonth.length,
  }
}

const SELECT = {
  id: true, category: true, orderedAt: true, receivedAt: true, patientCode: true, itemType: true, itemTypeOther: true,
  finalCost: true, status: true, periodMonth: true, redoAt: true, labOther: true, lab: { select: { name: true } },
} as const

function toRow(c: any, todayStr?: string): CostRow {
  const orderedAt = toHKDateStr(c.orderedAt)
  const receivedAt = c.receivedAt ? toHKDateStr(c.receivedAt) : null
  const row: CostRow = {
    id: c.id,
    category: c.category,
    orderedAt,
    receivedAt,
    patientCode: c.patientCode,
    vendor: c.lab?.name || c.labOther || UNNAMED_VENDOR,
    item: (c.itemType === 'Others' && c.itemTypeOther) ? c.itemTypeOther : (c.itemType || c.itemTypeOther || ''),
    amount: c.finalCost == null ? null : Number(c.finalCost),
    status: c.status,
    periodMonth: c.periodMonth,
    crossMonth: !!c.periodMonth && orderedAt.slice(0, 7) !== c.periodMonth,
    redo: c.status === 'REDO' || !!c.redoAt,
  }
  if (todayStr) row.daysWaiting = Math.round((Date.parse(todayStr) - Date.parse(orderedAt)) / 86400000)
  return row
}

/** 預覽用：某醫生某診所某月三類成本嘅明細 */
export async function costDetail(providerId: string, clinicId: string, periodMonth: string, todayStr: string): Promise<CostDetail> {
  const [y, m] = periodMonth.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const monthStartStr = `${periodMonth}-01`
  const monthEnd = hkDateEnd(`${periodMonth}-${String(lastDay).padStart(2, '0')}`)
  const recentFromStr = addDaysStr(todayStr, -STALE_DAYS)
  const prevMonth = shiftMonth(periodMonth, -1)
  const prevStartStr = `${prevMonth}-01`
  const notRecvFromStr = recentFromStr < prevStartStr ? recentFromStr : prevStartStr

  const rows = await prisma.costCase.findMany({
    where: {
      providerId, clinicId,
      OR: [
        { periodMonth },
        // 未到貨：本月、上月，或者更早但 60 日內落單
        { periodMonth: null, orderedAt: { gte: hkDateStart(notRecvFromStr), lte: monthEnd } },
        // 未有價錢：上月落單或者上月到貨
        { finalCost: null, orderedAt: { gte: hkDateStart(prevStartStr), lt: hkDateStart(monthStartStr) } },
        { finalCost: null, periodMonth: prevMonth },
        // 本月落單、本月作廢
        { status: 'VOID', orderedAt: { gte: hkDateStart(monthStartStr), lte: monthEnd } },
      ],
    },
    select: SELECT,
  })
  const all = rows.map(r => toRow(r))
  const months = Array.from(new Set(all.map(r => r.periodMonth).filter((m): m is string => !!m && m !== periodMonth)))
  const locked = months.length
    ? await prisma.payoutRun.findMany({ where: { providerId, clinicId, status: 'LOCKED', periodMonth: { in: months } }, select: { periodMonth: true } })
    : []
  const lockedMonths = new Set(locked.map(l => l.periodMonth))
  const out = {} as CostDetail
  for (const cat of COST_CATEGORIES) {
    out[cat] = classifyCostRows(all.filter(r => r.category === cat), periodMonth, recentFromStr, lockedMonths)
  }
  return out
}

export interface StaleRow extends CostRow { providerName: string; clinicName: string }

/** 月結頁「成本異常」：落單超過 60 日仍未到貨（LAB／INVISALIGN），最舊排最前 */
export async function staleCostCases(todayStr: string, clinicIds: string[] | null): Promise<StaleRow[]> {
  const cutoff = hkDateStart(addDaysStr(todayStr, -STALE_DAYS))
  const where: any = {
    receivedAt: null,
    status: { not: 'VOID' },
    category: { in: ['LAB', 'INVISALIGN'] },
    orderedAt: { lt: cutoff },
  }
  if (clinicIds) where.clinicId = { in: clinicIds }
  const rows = await prisma.costCase.findMany({
    where,
    select: { ...SELECT, providerId: true, clinicId: true },
    orderBy: { orderedAt: 'asc' },
    take: 500,
  })
  const [providers, clinics] = await Promise.all([
    prisma.provider.findMany({ where: { id: { in: Array.from(new Set(rows.map(r => r.providerId))) } }, select: { id: true, name: true, shortName: true } }),
    prisma.clinic.findMany({ where: { id: { in: Array.from(new Set(rows.map(r => r.clinicId))) } }, select: { id: true, name: true, shortName: true } }),
  ])
  const pName = new Map(providers.map(p => [p.id, p.shortName || p.name]))
  const cName = new Map(clinics.map(c => [c.id, c.shortName || c.name]))
  return rows.map(r => ({ ...toRow(r, todayStr), providerName: pName.get(r.providerId) ?? '', clinicName: cName.get(r.clinicId) ?? '' }))
}

/**
 * ★ cwm-costguard-20261006：已鎖月結月份入面、但冇被鎖定嘅成本 —— 即係鎖咗之後先入／取消作廢，
 *   冇計入任何月結（錢漏咗）。新守衛之後唔會再有新嘅，呢度係搵返舊資料入面已經發生咗嘅。
 */
export async function orphanCostCases(clinicIds: string[] | null): Promise<StaleRow[]> {
  const hits: Array<{ id: string }> = await prisma.$queryRaw`
    SELECT c.id FROM "CostCase" c
    JOIN "PayoutRun" r ON r."providerId" = c."providerId" AND r."clinicId" = c."clinicId"
      AND r."periodMonth" = c."periodMonth" AND r.status = 'LOCKED'
    WHERE c.status <> 'VOID' AND c."lockedByRunId" IS NULL`
  if (hits.length === 0) return []
  const where: any = { id: { in: hits.map(h => h.id) } }
  if (clinicIds) where.clinicId = { in: clinicIds }
  const rows = await prisma.costCase.findMany({ where, select: { ...SELECT, providerId: true, clinicId: true }, orderBy: { orderedAt: 'asc' } })
  const [providers, clinics] = await Promise.all([
    prisma.provider.findMany({ where: { id: { in: Array.from(new Set(rows.map(r => r.providerId))) } }, select: { id: true, name: true, shortName: true } }),
    prisma.clinic.findMany({ where: { id: { in: Array.from(new Set(rows.map(r => r.clinicId))) } }, select: { id: true, name: true, shortName: true } }),
  ])
  const pName = new Map(providers.map(p => [p.id, p.shortName || p.name]))
  const cName = new Map(clinics.map(c => [c.id, c.shortName || c.name]))
  return rows.map(r => ({ ...toRow(r), providerName: pName.get(r.providerId) ?? '', clinicName: cName.get(r.clinicId) ?? '' }))
}

/**
 * ★ cwm-lastmonth-20261006：月結頁「成本異常」—— 已到貨、到貨月份早過上月（今日計），仍未有價錢。
 *   嗰個月月結當咗 $0；已鎖就要手動調整（periodLocked）。上月嘅喺預覽「上月落單、仍未完成」提醒。
 */
export async function oldUnpricedCostCases(todayStr: string, clinicIds: string[] | null): Promise<StaleRow[]> {
  const latest = shiftMonth(todayStr.slice(0, 7), -2)
  const where: any = { status: { not: 'VOID' }, finalCost: null, periodMonth: { not: null, lte: latest } }
  if (clinicIds) where.clinicId = { in: clinicIds }
  const rows = await prisma.costCase.findMany({
    where, select: { ...SELECT, providerId: true, clinicId: true }, orderBy: [{ periodMonth: 'asc' }, { orderedAt: 'asc' }], take: 500,
  })
  if (rows.length === 0) return []
  const [providers, clinics, locked] = await Promise.all([
    prisma.provider.findMany({ where: { id: { in: Array.from(new Set(rows.map(r => r.providerId))) } }, select: { id: true, name: true, shortName: true } }),
    prisma.clinic.findMany({ where: { id: { in: Array.from(new Set(rows.map(r => r.clinicId))) } }, select: { id: true, name: true, shortName: true } }),
    prisma.payoutRun.findMany({
      where: { status: 'LOCKED', periodMonth: { in: Array.from(new Set(rows.map(r => r.periodMonth!))) } },
      select: { providerId: true, clinicId: true, periodMonth: true },
    }),
  ])
  const pName = new Map(providers.map(p => [p.id, p.shortName || p.name]))
  const cName = new Map(clinics.map(c => [c.id, c.shortName || c.name]))
  const lockedKey = new Set(locked.map(l => `${l.providerId}|${l.clinicId}|${l.periodMonth}`))
  return rows.map(r => ({
    ...toRow(r), pending: 'UNPRICED' as const,
    periodLocked: lockedKey.has(`${r.providerId}|${r.clinicId}|${r.periodMonth}`),
    providerName: pName.get(r.providerId) ?? '', clinicName: cName.get(r.clinicId) ?? '',
  }))
}

/** 鎖定前要剔「我已檢查」嘅總提醒數 */
export const totalReminders = (d: CostDetail) => COST_CATEGORIES.reduce((s, c) => s + d[c].reminders, 0)
