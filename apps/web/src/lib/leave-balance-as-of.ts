// ============================================================
// 共用 helper —— 「截至某日（HK）嘅休息日餘額」
//
// ★ 2026-09-01 cwm-lmr：兩份 MD 解同一個問題（leave_balance_as_of_month.md +
//   last_month_rest_dynamic.md），呢度係唯一實裝，兩邊 import，唔好各寫一次。
//
// 消費者：
//   ① /api/leave-balance?asOf=        —— 薪資明細「假期餘額」（asOf = 薪資月月底）
//   ② /api/scheduling-leave-summary   —— 排班「上月剩」（asOf = 上月月底，snapshot 缺時 fallback）
// ============================================================
import { hkDateStart, hkDateEnd } from './hk-date'

/**
 * 休息日餘額（截至 asOf 當日 HK 日終）。
 *
 * entitled — TimeBankEntry(RESTDAY_GRANT) 逐筆加總（minutes / 1440 = 日）
 * used     — LeaveRequest(APPROVED, REST_DAY) 按 startDate 歸月加總 days
 *
 * ⚠️★★★ RESTDAY_GRANT 存【HK 月初】（＝ UTC 上月最後一日 16:00）。
 *   asOf 一定要用 hkDateEnd()，用 UTC 午夜會令下個月嗰筆照樣入。
 *   例：九月發放存 2026-08-31T16:00Z；
 *       asOf '2026-08-31' → hkDateEnd = 15:59:59.999 UTC → 唔會入 ✅
 *
 * ⚠️★ 只支援 REST_DAY —— 年假／OT補假／生日假冇逐月發放記錄。
 *
 * ⚠️★ yearStart 下界 = asOf 同年 1 月 1 日 00:00 HK（曆年）——
 *   REST_DAY 每曆年一行，跨年唔可以累加上年（一月視「上月剩」時
 *   asOf='2025-12-31' → yearStart=2025-01-01，正確）。
 *
 * ⚠️★ 資料量細（44 grant / 421 leave / 25 員工）→ 一次撈晒，唔好逐個員工 query。
 *
 * @param db        Prisma client（或 tx）
 * @param employeeIds 目標員工 id 陣列（空陣列 = 空 Map，唔會 query）
 * @param asOf      'YYYY-MM-DD'（HK 日）
 */
export async function restDayBalanceAsOf(
  db: any,
  employeeIds: string[],
  asOf: string,                 // 'YYYY-MM-DD'（HK）
): Promise<Map<string, { entitled: number; used: number; remaining: number }>> {
  if (employeeIds.length === 0) return new Map()

  const asOfEnd = hkDateEnd(asOf)
  const year = Number(asOf.slice(0, 4))
  const yearStart = hkDateStart(`${year}-01-01`)

  const [grants, uses] = await Promise.all([
    db.timeBankEntry.findMany({
      where: {
        employeeId: { in: employeeIds },
        type: 'RESTDAY_GRANT',
        date: { gte: yearStart, lte: asOfEnd },
      },
      select: { employeeId: true, minutes: true },
    }),
    db.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'APPROVED',
        leaveType: { systemKey: 'REST_DAY' },
        startDate: { gte: yearStart, lte: asOfEnd },
      },
      select: { employeeId: true, days: true },
    }),
  ])

  const out = new Map<string, { entitled: number; used: number; remaining: number }>()
  const ensure = (id: string) => {
    if (!out.has(id)) out.set(id, { entitled: 0, used: 0, remaining: 0 })
    return out.get(id)!
  }
  // ★ minutes / 1440 = 日 —— 同 payroll-engine 發放時 Math.round(minutes/(24*60)) 一致
  for (const g of grants) ensure(g.employeeId).entitled += Math.round(g.minutes / 1440)
  for (const u of uses)   ensure(u.employeeId).used += Number(u.days)
  // ★ total function：範圍內零發放零用嘅員工都要有 0/0/0 entry
  //   （排班「上月剩」：上月冇發放冇用 → 顯 0，唔好返 null 顯「—」）
  for (const id of employeeIds) ensure(id)
  for (const v of out.values()) v.remaining = Math.round((v.entitled - v.used) * 10) / 10
  return out
}
