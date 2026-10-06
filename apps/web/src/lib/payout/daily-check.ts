// ============================================================
// ★ cwm-dailycheck-20261006：每日大數 —— 護士核對（每店每日一次）
//   核對金額 = 每日大數 A 區 Total（店舖營收），同頁面同一個 loadDailyReport 計，唔另計。
//   狀態：未核對 / 已核對 / 核對後有變（而家金額 ≠ 核對時金額 → 要重新核對）
//   重新核對、取消 = 舊紀錄標 revokedAt（唔刪）；同一店同一日只得一條有效（DB partial unique index）。
// ============================================================
import { prisma } from '@/lib/prisma'
import { loadDailyReport } from './daily-report'
import { todayHK, hkDateStart, hkDateEnd } from '@/lib/hk-date'

export type CheckStatus = 'UNCHECKED' | 'CHECKED' | 'CHANGED'

export interface DayCheckState {
  date: string
  storeTotal: number
  status: CheckStatus
  check: null | {
    id: string
    nurseName: string
    amount: number
    checkedAt: string
    checkedByName: string
    byProvider: Array<{ key: string; label: string; amount: number }>
  }
}

export class DailyCheckError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** 店舖帳號（KIOSK）綁咗店 → 只准核對嗰啲店；其他角色由 route 權限控制 */
export function kioskClinicAllowed(session: { role: string; clinics?: string[] | null }, clinicId: string): boolean {
  if (session.role === 'KIOSK') {
    const mine = session.clinics ?? []
    return mine.length === 0 || mine.includes(clinicId)
  }
  return true
}

/** 純函數：而家金額 vs 核對時金額 */
export function checkStatus(current: number, checkedAmount: number | null): CheckStatus {
  if (checkedAmount == null) return 'UNCHECKED'
  return Math.abs(round2(current) - round2(checkedAmount)) > 0.005 ? 'CHANGED' : 'CHECKED'
}

/** 某店某段日子嘅逐日核對狀態（冇收款又冇核對嘅日子唔列） */
export async function loadCheckStates(clinicId: string, from: string, to: string): Promise<DayCheckState[]> {
  const report = await loadDailyReport({ from, to, clinicId, providerId: null, scopeClinics: null })
  const totals = report.dayStoreTotals ?? {}
  const checks = await prisma.dailyRevenueCheck.findMany({
    where: { clinicId, date: { gte: from, lte: to }, revokedAt: null },
  })
  const users = checks.length
    ? await prisma.user.findMany({ where: { id: { in: [...new Set(checks.map(c => c.checkedBy))] } }, select: { id: true, name: true } })
    : []
  const userName = new Map(users.map(u => [u.id, u.name]))
  const byDate = new Map(checks.map(c => [c.date, c]))
  const out: DayCheckState[] = []
  for (const date of Object.keys(totals).sort()) {
    const c = byDate.get(date)
    const storeTotal = totals[date]
    if (!c && storeTotal === 0) continue
    out.push({
      date,
      storeTotal,
      status: checkStatus(storeTotal, c ? Number(c.amount) : null),
      check: c ? {
        id: c.id,
        nurseName: c.nurseName,
        amount: Number(c.amount),
        checkedAt: c.checkedAt.toISOString(),
        checkedByName: userName.get(c.checkedBy) ?? '',
        byProvider: (c.byProviderJson as any[]) ?? [],
      } : null,
    })
  }
  return out
}

/** 護士名單：該店在職（或嗰日之後先離職）員工；當日喺該店有更嘅排前 */
export async function nurseOptions(clinicId: string, date: string) {
  const dayStart = hkDateStart(date)
  const emps = await prisma.employee.findMany({
    where: {
      OR: [{ homeClinicId: clinicId }, { clinics: { some: { clinicId } } }],
      AND: [{ OR: [{ resignedAt: null }, { resignedAt: { gt: dayStart } }] }],
      joinDate: { lte: hkDateEnd(date) },
    },
    select: { id: true, user: { select: { name: true, fullName: true } } },
  })
  const shifts = await prisma.shift.findMany({
    where: {
      date: { gte: dayStart, lte: hkDateEnd(date) },
      employeeId: { in: emps.map(e => e.id) },
      OR: [{ clinicId }, { secondaryClinicId: clinicId }],
    },
    select: { employeeId: true },
  })
  const onShift = new Set(shifts.map(s => s.employeeId))
  return emps
    .map(e => ({ employeeId: e.id, name: e.user.name || e.user.fullName || '', onShift: onShift.has(e.id) }))
    .sort((a, b) => Number(b.onShift) - Number(a.onShift) || a.name.localeCompare(b.name, 'zh-HK'))
}

/**
 * 確認核對。expectedAmount = 頁面顯示緊嘅金額：同 server 而家計嘅唔同 → 唔准核對（頁面舊咗）。
 * 已有有效核對（例如有變要重新核對）→ 同一個 transaction 入面先標走舊嗰條。
 */
export async function createCheck(input: {
  clinicId: string; date: string; nurseEmployeeId: string; expectedAmount: number; actorId: string
}) {
  const { clinicId, date, nurseEmployeeId, expectedAmount, actorId } = input
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new DailyCheckError('日期格式要 YYYY-MM-DD')
  if (date > todayHK()) throw new DailyCheckError('未到嘅日子唔可以核對')
  if (!Number.isFinite(expectedAmount)) throw new DailyCheckError('金額格式錯')

  const nurses = await nurseOptions(clinicId, date)
  const nurse = nurses.find(n => n.employeeId === nurseEmployeeId)
  if (!nurse) throw new DailyCheckError('呢位員工唔屬於呢間店，請重新揀')

  const report = await loadDailyReport({ from: date, to: date, clinicId, providerId: null, scopeClinics: null })
  const amount = report.totals.storeTotal
  if (Math.abs(round2(amount) - round2(expectedAmount)) > 0.005) {
    throw new DailyCheckError(`數字啱啱變咗（而家 $${amount}，畫面 $${expectedAmount}），請重新整理再核對`, 409)
  }
  const byProvider = report.rows.map(r => ({ key: r.key, label: r.label, amount: r.storeTotal }))

  try {
    return await prisma.$transaction(async tx => {
      const old = await tx.dailyRevenueCheck.findFirst({ where: { clinicId, date, revokedAt: null } })
      if (old) {
        if (checkStatus(amount, Number(old.amount)) === 'CHECKED') {
          throw new DailyCheckError('呢日已經核對咗，唔使再核對', 409)
        }
        await tx.dailyRevenueCheck.update({
          where: { id: old.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedBy: actorId, revokeReason: '核對後數字有變，重新核對' },
        })
      }
      const created = await tx.dailyRevenueCheck.create({
        data: { clinicId, date, nurseEmployeeId, nurseName: nurse.name, amount, byProviderJson: byProvider, checkedBy: actorId },
      })
      await tx.auditLog.create({
        data: {
          actorId, action: 'DAILY_REVENUE_CHECK', entity: 'DailyRevenueCheck', entityId: created.id, clinicId,
          notes: `每日大數核對：${date} · 護士 ${nurse.name} · $${amount}${old ? `（重新核對，之前 $${Number(old.amount)}）` : ''}`,
          afterJson: JSON.stringify({ clinicId, date, nurseEmployeeId, amount }),
        } as any,
      })
      return created
    })
  } catch (e: any) {
    // 兩部機同時剔 → partial unique index 擋第二個
    if (e?.code === 'P2002' || e?.code === 'P2025') throw new DailyCheckError('呢日啱啱已經有人核對咗，請重新整理', 409)
    throw e
  }
}

export async function revokeCheck(input: { clinicId: string; date: string; reason: string; actorId: string }) {
  const reason = (input.reason ?? '').trim()
  if (!reason) throw new DailyCheckError('取消核對要填原因')
  return prisma.$transaction(async tx => {
    const cur = await tx.dailyRevenueCheck.findFirst({ where: { clinicId: input.clinicId, date: input.date, revokedAt: null } })
    if (!cur) throw new DailyCheckError('呢日冇有效嘅核對紀錄', 404)
    const res = await tx.dailyRevenueCheck.updateMany({
      where: { id: cur.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: input.actorId, revokeReason: reason.slice(0, 200) },
    })
    if (res.count === 0) throw new DailyCheckError('啱啱已經有人改咗，請重新整理', 409)
    await tx.auditLog.create({
      data: {
        actorId: input.actorId, action: 'DAILY_REVENUE_CHECK_REVOKE', entity: 'DailyRevenueCheck', entityId: cur.id, clinicId: input.clinicId,
        notes: `取消每日大數核對：${input.date} · 原本護士 ${cur.nurseName} · 原因：${reason.slice(0, 200)}`,
      } as any,
    })
  })
}
