// ============================================================
// ★ cwm-costguard-20261006：成本錄入寫入守衛（同錢直接有關 —— 老闆要求深入檢查後補）
//   問題（本地 DB 實測重現）：
//     ① 新增／改成本落「已鎖定月結」嘅月份 → 唔計入任何月結（錢靜靜漏咗）
//     ② 成本負數、亂碼（"abc" → 存 null 但狀態 PRICED）
//     ③ 到貨日早過落單日、將來日子（打錯年份 → 成本跑去錯月份）
//     ④ MANAGER 寫入冇限所屬診所（讀取有限，寫入冇）
//   純函數放呢度（有單元測試）；查 DB 嘅 lockedRunFor 都喺度，三條寫入 route 共用。
// ============================================================
import { toHKDateStr } from '@/lib/hk-date'

export class CostGuardError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const MAX_COST = 9_999_999

/** 成本金額：null／undefined／'' → null；其餘要係 0 至 MAX_COST 嘅數字（2 位小數） */
export function parseMoney(v: unknown, label = '成本'): number | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim())
  if (!Number.isFinite(n)) throw new CostGuardError(400, `${label}唔係數字`)
  if (n < 0) throw new CostGuardError(400, `${label}唔可以係負數`)
  if (n > MAX_COST) throw new CostGuardError(400, `${label}太大（最多 ${MAX_COST.toLocaleString('en-US')}）`)
  return Math.round(n * 100) / 100
}

/** 日期欄 → HK 日期字串 YYYY-MM-DD；null／'' → null；壞日期 → 400 */
export function parseDay(v: unknown, label: string): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new CostGuardError(400, `${label}日期唔啱`)
  return toHKDateStr(d)
}

/**
 * 日期合理性：落單日／到貨日唔可以係將來（打錯年份會令成本跑去將來月份）；
 * 到貨日唔可以早過落單日。
 */
export function checkCostDates(orderedDay: string, receivedDay: string | null, todayDay: string): void {
  if (orderedDay > todayDay) throw new CostGuardError(400, `落單日（${orderedDay}）唔可以係將來`)
  if (receivedDay) {
    if (receivedDay > todayDay) throw new CostGuardError(400, `到貨日（${receivedDay}）唔可以係將來`)
    if (receivedDay < orderedDay) throw new CostGuardError(400, `到貨日（${receivedDay}）早過落單日（${orderedDay}）`)
  }
}

/** 折扣 %：0–100 */
export function parseDiscountPct(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new CostGuardError(400, '折扣要係 0–100%')
  return Math.round(n * 100) / 100
}

export const isMonthStr = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

/** MANAGER 只可以寫自己診所（同 GET 一樣嘅範圍） */
export function assertClinicAllowed(session: { role: string; clinics?: string[] | null }, ...clinicIds: string[]): void {
  if (session.role !== 'MANAGER') return
  const mine = new Set(session.clinics ?? [])
  for (const c of clinicIds) {
    if (!mine.has(c)) throw new CostGuardError(403, '你只可以處理所屬診所嘅成本')
  }
}

/** 呢個醫生 × 診所 × 月份有冇已鎖定嘅月結 */
export async function lockedRunFor(db: any, providerId: string, clinicId: string, periodMonth: string | null): Promise<{ id: string } | null> {
  if (!periodMonth) return null
  return db.payoutRun.findFirst({ where: { providerId, clinicId, periodMonth, status: 'LOCKED' }, select: { id: true } })
}

export const lockedMonthMessage = (periodMonth: string) =>
  `${periodMonth} 嘅月結已經鎖定，呢筆成本唔會計入。請用「手動調整」喺下期補，或者先解鎖該月月結再改`
