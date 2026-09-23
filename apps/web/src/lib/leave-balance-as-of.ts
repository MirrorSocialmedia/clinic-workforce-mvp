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
import { hkDateEnd, getMonthRange, toHKDateStr } from './hk-date'
import { balanceYearFor, consumesQuota } from './leave-types'
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

/**
 * ★ cwm-leaveasof-20260922：累積制／無逐月發放嘅假期「截至某日」餘額。
 *   適用：ANNUAL_LEAVE、BIRTHDAY_LEAVE（year=0 累積制）、OT_LEAVE（曆年但冇逐月發放）。
 *   ⚠️ 休息日【唔好】用呢個 —— 用上面 restDayBalanceAsOf（佢仲要扣未來發放同換鐘）。
 *
 *   entitled(asOf) = LeaveBalance.entitled（照用 —— 年假累積到 refresh 嗰刻，唔會包未來）
 *   used(asOf)     = LeaveBalance.used − Σ LeaveRequest(同類, APPROVED, startDate > asOfEnd,
 *                  且歸咗落呢一行嘅).days
 *
 *   ⚠️ 邊界同 restDayBalanceAsOf 一致：`gt: asOfEnd`；
 *      跨月假期（例：9/29–10/2）按 startDate 歸月 —— 成張算入 9 月。
 *   ⚠️ 歸行口徑 = balanceYearFor（同 approve 寫入路徑同一個 source of truth）——
 *      年假／生日假永遠歸 year=0 行（即使同類仲有 legacy 曆年行，佢哋唔會被扣）；
 *      曆年類（REST_DAY/OT_LEAVE）歸 startDate 嘅 HK 年行。
 *   ⚠️ 純讀，LeaveBalance 一行都唔改。
 *
 * @param db    Prisma client（或 tx）
 * @param rows  已撈好嘅 LeaveBalance（含 leaveType.systemKey）—— 唔另外 query
 */
export async function accumulativeBalanceAsOf(
  db: any,
  employeeId: string,
  rows: Array<{ leaveTypeId: string; year: number; entitled: number; used: number; leaveType: { systemKey: string | null } }>,
  asOf: string,                 // 'YYYY-MM-DD'（HK）
): Promise<Map<string, { entitled: number; used: number; remaining: number }>> {
  const asOfEnd = hkDateEnd(asOf)
  const out = new Map<string, { entitled: number; used: number; remaining: number }>()
  if (rows.length === 0) return out

  const future = await db.leaveRequest.findMany({
    where: {
      employeeId, status: 'APPROVED',
      leaveTypeId: { in: rows.map(r => r.leaveTypeId) },
      startDate: { gt: asOfEnd },
    },
    // ★ cwm-leaveasoffix-20260923 S1-1：quantity 必須 select —— consumesQuota 靠佢分辨
    //   「systemKey 空 + quantity 空」嘅自訂無薪類（事假／無薪假／請假）。
    select: { leaveTypeId: true, days: true, startDate: true, leaveType: { select: { systemKey: true, quantity: true } } },
  })

  for (const r of rows) {
    // ★ 只扣「真係扣咗落呢一行」嘅未來已批假（同 approve 寫入路徑同一條 balanceYearFor）——
    //   唔係 per-row 年份 cap：同類多行（例：年假 y=0 + legacy y=2026）時，
    //   同一張假唔會雙重扣（寫入路徑只會落其中一行）。
    const futureUsed = future
      // ★ cwm-leaveasoffix-20260923 S1-1：加 consumesQuota —— 同寫入路徑（POST:289 / approve:141）同一條閘。
      //   冇呢句：病假／無薪假（唔扣額）嘅未來已批假會被減走 → used 變負、remaining 憑空變大。
      .filter((f: any) => f.leaveTypeId === r.leaveTypeId
        && consumesQuota(f.leaveType)
        && balanceYearFor(f.leaveType.systemKey, f.startDate) === r.year)
      .reduce((s: number, f: any) => s + Number(f.days), 0)
    const used = Math.round((r.used - futureUsed) * 10) / 10
    const entitled = Math.round(r.entitled * 10) / 10
    out.set(`${r.leaveTypeId}:${r.year}`, { entitled, used, remaining: Math.round((entitled - used) * 10) / 10 })
  }
  return out
}

/**
 * ★ cwm-leaveasof-20260922：asOf 之後已批嘅假（按月、按類型）＋ 休息日未來發放。
 *   ⚠️ 唔設年份上限 —— 12 月時都要睇到 1 月預排。
 *   只攞 asOf 之後 3 個月（員工端唔需要睇半年後）。
 *
 * ⚠️ 歸月口徑 = startDate（HK 視角）—— 同 accumulativeBalanceAsOf / restDayBalanceAsOf 一致。
 * ⚠️ grant 歸 REST_DAY 類型（按 systemKey 撈 id）； grant minutes / 1440 = 日
 *    （同 restDayBalanceAsOf 一致）。
 * ⚠️ 純讀。
 */
export async function upcomingLeaveByMonth(
  db: any,
  employeeId: string,
  asOf: string,
): Promise<Array<{ month: string; leaveTypeId: string; scheduledDays: number; grantedDays: number }>> {
  const asOfEnd = hkDateEnd(asOf)
  // ★ asOf 之後 3 個月嘅月底（例：2026-09 → 2026-12-31 日終）。
  //   年月純算術 + getMonthRange —— 唔好用 new Date(y, m, 1)（伺服器 UTC 差 8 小時）。
  const [ay, am] = asOf.slice(0, 7).split('-').map(Number)
  const t = (am - 1) + 3
  const horizonYm = `${ay + Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
  const horizon = getMonthRange(new Date(`${horizonYm}-01T00:00:00+08:00`)).end

  const [leaves, grants, restDayType] = await Promise.all([
    db.leaveRequest.findMany({
      where: { employeeId, status: 'APPROVED', startDate: { gt: asOfEnd, lte: horizon } },
      // ★ cwm-leaveasoffix-20260923 S4-1：預排明細掛喺「額度卡」下面，所以只列扣額嘅類型
      select: { leaveTypeId: true, days: true, startDate: true, leaveType: { select: { systemKey: true, quantity: true } } },
    }),
    db.timeBankEntry.findMany({
      where: { employeeId, type: 'RESTDAY_GRANT', date: { gt: asOfEnd, lte: horizon } },
      select: { minutes: true, date: true },
    }),
    db.leaveType.findFirst({ where: { systemKey: 'REST_DAY' }, select: { id: true } }),
  ])

  const byKey = new Map<string, { month: string; leaveTypeId: string; scheduledDays: number; grantedDays: number }>()
  const row = (month: string, leaveTypeId: string) => {
    const k = `${month}|${leaveTypeId}`
    let r = byKey.get(k)
    if (!r) { r = { month, leaveTypeId, scheduledDays: 0, grantedDays: 0 }; byKey.set(k, r) }
    return r
  }

  for (const l of leaves) {
    if (!consumesQuota(l.leaveType)) continue   // ★ S4-1：病假／無薪假唔扣額 —— 唔好掛喺額度卡
    row(toHKDateStr(l.startDate).slice(0, 7), l.leaveTypeId).scheduledDays += Number(l.days)
  }
  if (restDayType) {
    for (const g of grants) {
      row(toHKDateStr(g.date).slice(0, 7), restDayType.id).grantedDays += g.minutes / 1440
    }
  }

  return [...byKey.values()]
    .map(r => ({
      ...r,
      scheduledDays: Math.round(r.scheduledDays * 10) / 10,
      grantedDays: Math.round(r.grantedDays * 10) / 10,
    }))
    .filter(r => r.scheduledDays > 0 || r.grantedDays > 0)
    .sort((a, b) => a.month.localeCompare(b.month))
}
