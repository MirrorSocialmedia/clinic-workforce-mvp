// ============================================================
// 共用 helper —— 「截至某日（HK）嘅休息日餘額」
//
// ★ 2026-09-02 cwm-lba 重寫：由「事件源向前重建」改「由 LeaveBalance
//   向後扣」。原因：手動初始化直接改 LeaveBalance.entitled，冇任何
//   TimeBankEntry —— 向前重建永遠睇唔到（Suki 手動加 8 日 → 顯示 −4 應該 4）。
//   ⚠️ LeaveBalance 先係權威值；事件源只用嚟扣「asOf 之後發生」嘅部分。
//   （本 MD 取代 rest_to_account_helper_fix.md —— 向後扣 + 再加 convert = 雙重計，
//     REST_TO_ACCOUNT 已經包含喺 LeaveBalance.used（convert:79 加咗）。）
//
// 消費者：
//   ① /api/leave-balance?asOf=        —— 薪資明細「假期餘額」（asOf = 薪資月月底）
//   ② /api/scheduling-leave-summary   —— 排班「上月剩」（asOf = 上月月底，snapshot 缺時 fallback）
// ============================================================
import { hkDateEnd } from './hk-date'
import { TIMEBANK_MINUTES_PER_DAY } from './timebank-constants'

/**
 * 休息日餘額（截至 asOf 當日 HK 日終）—— 向後扣版本。
 *
 *   entitled(asOf) = LeaveBalance(entitled, 該曆年 REST_DAY 行)
 *                  − Σ TimeBankEntry(RESTDAY_GRANT, date > asOfEnd, ≤ yearEnd) / 1440
 *   used(asOf)     = LeaveBalance.used（同上）
 *                  − Σ LeaveRequest(REST_DAY, APPROVED, startDate > asOfEnd, ≤ yearEnd).days
 *                  − Σ TimeBankEntry(REST_TO_ACCOUNT, date > asOfEnd, ≤ yearEnd) / 540
 *
 * ⚠️★★★ 邊界：`gt: asOfEnd`（asOfEnd = hkDateEnd(asOf) = 當日 15:59:59.999 UTC），
 *   唔係 `gte`、更唔係字串 `'> …16:00:00'` —— 9 月發放正正存喺
 *   2026-08-31T16:00Z（＝ HK 9/1 00:00），16:00:00 > 15:59:59.999 先會扣到。
 *
 * ⚠️★★★ 冇 LeaveBalance 行嘅員工就唔回（Map 冇 entry）—— 唔好憑空建 {0,0,0}，
 *   前端會當「有記錄但係 0」。consumer 要自己處理 missing（null /「—」語義）。
 *
 * ⚠️★ `year = asOf 前四位`（曆年）—— 睇 2027-01 上月剩（asOf='2026-12-31'）
 *   攞 2026 行；薪資明細 2027-01（asOf='2027-01-31'）攞 2027 行。
 *   三個 future query 加 `lte: yearEnd`（該年 12-31 日終）—— 跨年上界：
 *   睇 2026-08 時唔可以扣走 2027 年嘅發放／假期／換 OT（佢哋屬於 2027 行）。
 *
 * ⚠️★ RESTDAY_GRANT 存 minutes = 日 × 1440（-calendar day-，payroll-engine 寫入側）；
 *   REST_TO_ACCOUNT 存 minutes = 日 × 540（TIMEBANK_MINUTES_PER_DAY，換算側）。
 *
 * ⚠️★ 只支援 REST_DAY —— 年假／OT補假／生日假冇逐月發放記錄。
 *
 * ⚠️★ 純讀：LeaveBalance 一行都唔改。
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
  // ★ 只扣「同年、asOf 之後」—— 跨年嘅唔關呢個 LeaveBalance.year 事（§3.2）
  const yearEnd = hkDateEnd(`${year}-12-31`)

  const [balances, futureGrants, futureLeaves, futureConverts] = await Promise.all([
    db.leaveBalance.findMany({
      where: { employeeId: { in: employeeIds }, year, leaveType: { systemKey: 'REST_DAY' } },
      select: { employeeId: true, entitled: true, used: true },
    }),
    db.timeBankEntry.findMany({
      where: { employeeId: { in: employeeIds }, type: 'RESTDAY_GRANT', date: { gt: asOfEnd, lte: yearEnd } },
      select: { employeeId: true, minutes: true },
    }),
    db.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds }, status: 'APPROVED',
        leaveType: { systemKey: 'REST_DAY' }, startDate: { gt: asOfEnd, lte: yearEnd },
      },
      select: { employeeId: true, days: true },
    }),
    db.timeBankEntry.findMany({
      where: { employeeId: { in: employeeIds }, type: 'REST_TO_ACCOUNT', date: { gt: asOfEnd, lte: yearEnd } },
      select: { employeeId: true, minutes: true },
    }),
  ])

  // ★ 冇 LeaveBalance 行就唔回 —— 唔好憑空建（lmr 版行為改變，見 §3.1 #2）
  const out = new Map<string, { entitled: number; used: number; remaining: number }>()
  for (const b of balances) {
    out.set(b.employeeId, { entitled: b.entitled, used: b.used, remaining: 0 })
  }
  const get = (id: string) => out.get(id)

  // ★ 向後扣：只減「asOf 之後」嘅事件（past 事件已經包含喺 LeaveBalance 入面）
  //   grant minutes / 1440 = 日（同 payroll-engine 寫入側 quota * 24 * 60 對沖）
  for (const g of futureGrants)   { const v = get(g.employeeId); if (v) v.entitled -= Math.round(g.minutes / 1440) }
  for (const l of futureLeaves)   { const v = get(l.employeeId); if (v) v.used -= Number(l.days) }
  for (const c of futureConverts) { const v = get(c.employeeId); if (v) v.used -= c.minutes / TIMEBANK_MINUTES_PER_DAY }

  for (const v of out.values()) {
    v.entitled = Math.round(v.entitled * 10) / 10
    v.used     = Math.round(v.used * 10) / 10
    v.remaining = Math.round((v.entitled - v.used) * 10) / 10
  }
  return out
}
