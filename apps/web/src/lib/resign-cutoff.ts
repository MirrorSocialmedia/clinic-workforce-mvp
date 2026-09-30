// ============================================================
// ★ 2026-09-30 [cwm-restdebt] F2：三條離職路徑共用嘅「最後工作日 cutoff」邏輯
//
// RS-21：結算／確認離職／標記離職三條路之前做嘅嘢各唔同（User.status 三值、
//   tokenVersion 有的加有的唔加、leaveDate 漏、跨日假漏、通知重發舊取消更）。
// 本檔抽出共用 applyResignCutoff() —— 三條路同一個 tx 內 call，最終數據狀態一致：
//   - Employee.status='RESIGNED' + leaveDate + resignedAt（生效日 = 最後工作日+1）
//   - User.status='RESIGNED' + tokenVersion+1（踢所有登入 session）
//   - 取消 cutoff 之後嘅更＋已批假（還額）
//   - ★ 跨過最後工作日嘅已批假：endDate 截到最後工作日、days 按曆日比例減（0.5 倍數）、差額還額（RS-06）
//   - 停人臉模板
//   - 回傳今次取消嘅更（俾通知用 —— 修 RS-17「重發以前已取消嘅更」）
// ============================================================
import { hkDateStart, hkDateOnly, hkDateEnd, addDaysStr, countHKDaysInclusive } from './hk-date'
import { balanceYearFor, consumesQuota } from './leave-types'
import { lockEmployee } from './emp-lock'

export interface ResignCutoffResult {
  shiftsCancelled: number
  leavesCancelled: number
  leavesTruncated: number
  /** 今次取消嘅更（俾 route 發通知 — 只發呢啲，唔係撈全部 CANCELLED） */
  cancelledShifts: Array<{ date: Date; startTime: Date | null; endTime: Date | null; clinicId: string | null }>
}

/**
 * ★ 2026-09-30 [cwm-restdebt] RS-05/06：「已用年假 截至最後工作日」—— 剔走最後工作日之後嘅已批年假。
 * 跨過離職日嘅假按曆日比例拆（days × cutoff 後曆日 ÷ 總曆日）。純函數，可獨立測試。
 *
 * @param leaves 已批（APPROVED）年假，且 endDate 遲過最後工作日（caller 已 filter）
 * @param lastDay 'YYYY-MM-DD'（HK）
 * @returns 要剔走嘅日數（未四捨五入；caller 負責最終 r2 + clamp ≥0）
 */
export function futureAnnualLeaveDays(
  leaves: Array<{ startDate: Date; endDate: Date; days: number }>,
  lastDay: string,
): number {
  const lastDayEnd = hkDateEnd(lastDay)
  const cutoff = hkDateStart(addDaysStr(lastDay, 1)) // 最後工作日 + 1 日（HK 視角）
  let futureDays = 0
  for (const lr of leaves) {
    if (!(lr.endDate > lastDayEnd)) continue
    const total = countHKDaysInclusive(lr.startDate, lr.endDate)
    if (total <= 0) continue
    const afterStart = lr.startDate > lastDayEnd ? lr.startDate : cutoff
    const after = countHKDaysInclusive(afterStart, lr.endDate)
    futureDays += Number(lr.days) * after / total
  }
  return futureDays
}

/** 0.5 倍數取整（假期 days 口徑 — 同 LeaveRequest.days 最小單位一致） */
const roundHalf = (n: number) => Math.round(n * 2) / 2

/**
 * 三條離職路徑共用：喺 caller 嘅 tx 內執行 cutoff（E-11 lockEmployee 喺內）。
 * ⚠️ audit 由 caller 自己寫（各 route action 唔同）。
 */
export async function applyResignCutoff(
  tx: any,
  empId: string,
  lastDay: string, // 'YYYY-MM-DD'（HK）
): Promise<ResignCutoffResult> {
  // ★ E-11：同其他員工寫入一樣先鎖人 —— 否則同排更／批假／打卡並發會 deadlock（40P01）
  await lockEmployee(tx, empId)

  const lastDayDate = hkDateOnly(lastDay)                         // 最後工作日（HK 00:00）
  const cutoff = hkDateStart(addDaysStr(lastDay, 1))              // 生效日 = 最後工作日 + 1（HK 00:00）

  // ① Employee status → RESIGNED + leaveDate + resignedAt（三條路同一口徑 — RS-21）
  const emp = await tx.employee.findUnique({ where: { id: empId }, select: { userId: true } })
  if (!emp) throw new Error('EMP_NOT_FOUND')

  await tx.employee.update({
    where: { id: empId },
    data: { status: 'RESIGNED', leaveDate: lastDayDate, resignedAt: cutoff },
  })

  // ② User status → RESIGNED + tokenVersion +1（踢所有登入 session）
  await tx.user.update({
    where: { id: emp.userId },
    data: { status: 'RESIGNED', tokenVersion: { increment: 1 } },
  })

  // ③ 取消 cutoff 之後嘅更（Shift.date 存工作日 HK 午夜 → gte 唔會漏 cutoff 當日）
  // ★ RS-17：updateMany 之前先撈「今次真係取消」嗰啲（舊版本 route 外撈全部 CANCELLED → 重發以前已取消嘅更）
  const cancelledShifts = await tx.shift.findMany({
    where: { employeeId: empId, date: { gte: cutoff }, status: { not: 'CANCELLED' } },
    select: { date: true, startTime: true, endTime: true, clinicId: true },
    orderBy: { date: 'asc' },
  })
  const shifts = await tx.shift.updateMany({
    where: { employeeId: empId, date: { gte: cutoff }, status: { not: 'CANCELLED' } },
    data: { status: 'CANCELLED' },
  })

  // ④ 取消 cutoff 之後嘅已批假 + 還額
  const leavesToCancel = await tx.leaveRequest.findMany({
    where: { employeeId: empId, startDate: { gte: cutoff }, status: 'APPROVED' },
    select: {
      id: true,
      days: true,
      leaveTypeId: true,
      startDate: true,
      leaveType: { select: { systemKey: true, quantity: true } },   // ★ H1-8c：consumesQuota 要 quantity
    },
  })
  let leavesCancelled = 0
  for (const lr of leavesToCancel) {
    await tx.leaveRequest.update({
      where: { id: lr.id },
      data: { status: 'CANCELLED' },
    })
    leavesCancelled++   // ★ 病假／自訂假都係取消咗，要計入「取消假期=N」
    // ★ 統一口徑：唔扣額嘅類型（SICK 等）從來冇扣過，唔使還
    if (!consumesQuota(lr.leaveType)) continue
    // ★ 年假累積制 = year 0；休息日等 = 曆年（照 leave-requests/[id]:207 口徑）
    const leaveYear = balanceYearFor(lr.leaveType.systemKey, new Date(lr.startDate))
    const updated = await tx.leaveBalance.updateMany({
      where: { employeeId: empId, leaveTypeId: lr.leaveTypeId, year: leaveYear },
      data: { used: { decrement: lr.days }, remaining: { increment: lr.days } },
    })
    // ★ 唔好靜靜吞 —— 還唔到額度係資料錯誤，一定要留痕
    if (updated.count === 0) {
      console.error(
        `[resign-cutoff] ⛔ 還額度失敗（取消）：employeeId=${empId} ` +
        `leaveTypeId=${lr.leaveTypeId} year=${leaveYear} days=${lr.days} leaveRequestId=${lr.id}`,
      )
    }
  }

  // ⑤ ★ 2026-09-30 [cwm-restdebt] RS-06：跨過最後工作日嘅已批假 —— 截斷 + 還差額
  //    舊版只取消 startDate >= cutoff，9/28–10/3 年假 + 9/30 離職 → 10/1–10/3 三日照當已用。
  let leavesTruncated = 0
  const leavesToTruncate = await tx.leaveRequest.findMany({
    where: { employeeId: empId, startDate: { lt: cutoff }, endDate: { gte: cutoff }, status: 'APPROVED' },
    select: {
      id: true,
      days: true,
      leaveTypeId: true,
      startDate: true,
      endDate: true,
      leaveType: { select: { systemKey: true, quantity: true } },
    },
  })
  for (const lr of leavesToTruncate) {
    const total = countHKDaysInclusive(lr.startDate, lr.endDate)
    if (total <= 0) continue
    const after = countHKDaysInclusive(cutoff, lr.endDate)
    if (after <= 0) continue
    const removedDays = roundHalf(Number(lr.days) * after / total)
    if (removedDays <= 0) continue
    const keepDays = roundHalf(Number(lr.days) - removedDays)
    await tx.leaveRequest.update({
      where: { id: lr.id },
      data: { endDate: lastDayDate, days: keepDays },
    })
    leavesTruncated++
    if (!consumesQuota(lr.leaveType)) continue
    const leaveYear = balanceYearFor(lr.leaveType.systemKey, new Date(lr.startDate))
    const updated = await tx.leaveBalance.updateMany({
      where: { employeeId: empId, leaveTypeId: lr.leaveTypeId, year: leaveYear },
      data: { used: { decrement: removedDays }, remaining: { increment: removedDays } },
    })
    if (updated.count === 0) {
      console.error(
        `[resign-cutoff] ⛔ 還額度失敗（截斷）：employeeId=${empId} ` +
        `leaveTypeId=${lr.leaveTypeId} year=${leaveYear} removedDays=${removedDays} leaveRequestId=${lr.id}`,
      )
    }
  }

  // ⑥ 停人臉模板（soft disable）
  await tx.faceTemplate.updateMany({
    where: { employeeId: empId, active: true },
    data: { active: false },
  })

  return { shiftsCancelled: shifts.count, leavesCancelled, leavesTruncated, cancelledShifts }
}
