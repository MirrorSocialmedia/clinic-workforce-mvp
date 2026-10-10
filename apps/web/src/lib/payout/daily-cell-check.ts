// ============================================================
// ★ cwm-dailyv2-20261007 ④：每日大數逐格核對（醫生 × 付款方式）—— 寫入端
//   tick：由伺服器重新計嗰格而家金額（loadDailyReport 同頁面同一口徑，唔信前端傳嘅數）；
//         金額 0 / 搵唔到 → 400「呢格冇數」；upsert（unique key 擋重複）。
//   取消 tick：deleteMany（刪 0 筆都當成功 — idempotent）。
//   兩個方向都寫 AuditLog（DAILY_CELL_CHECK / DAILY_CELL_UNCHECK），notes 冇病人資料。
//   狀態判斷純函數喺 daily-cell-state.ts（client 同 test 共用，呢度唔 import）。
// ============================================================
import { prisma } from '@/lib/prisma'
import { addDaysStr } from '@/lib/hk-date'
import { loadDailyReport, DAILY_MAX_DAYS } from './daily-report'
import { kioskClinicAllowed, nurseOptions } from './daily-check'

export class DailyCellCheckError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const round2 = (n: number) => Math.round(n * 100) / 100

export interface CellCheckCell {
  /** ★ cwm-dailyv3-20261010 §5a：範圍版 —— 每個 cell 帶 HK 日（單日 GET 就係嗰日） */
  date: string
  rowKey: string
  colKey: string
  amount: number
  checkedName: string
  checkedAt: string
}

/**
 * ★ cwm-dailyv3-20261010 §5a：GET 由單日改日期範圍（單日 = from === to）。
 *   每個 cell 回傳 date 欄；前端 map key = `${date}|${rowKey}|${colKey}`，
 *   ①（單日逐醫生）同 ③（逐日逐醫生）共用。
 */
export async function loadCellChecks(clinicId: string, from: string, to: string): Promise<CellCheckCell[]> {
  const rows = await prisma.dailyRevenueCellCheck.findMany({
    where: { clinicId, date: { gte: from, lte: to } },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })
  return rows.map(r => ({
    date: r.date,
    rowKey: r.rowKey,
    colKey: r.colKey,
    amount: Number(r.amount),
    checkedName: r.checkedName,
    checkedAt: r.checkedAt.toISOString(),
  }))
}

/** ★ cwm-dailyv3-20261010 §5a：範圍校驗（route 用）—— 格式 + 起訖 + 上限 62 日 */
export function validateCellRange(from: string, to: string): { ok: false; error: string } | { ok: true; from: string; to: string } {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return { ok: false, error: '日期格式要 YYYY-MM-DD' }
  if (to < from) return { ok: false, error: '「至」唔可以早過開始日期' }
  let days = 0
  for (let d = from; d <= to && days <= DAILY_MAX_DAYS; d = addDaysStr(d, 1)) days++
  if (days > DAILY_MAX_DAYS) return { ok: false, error: `日期範圍最多 ${DAILY_MAX_DAYS} 日` }
  return { ok: true, from, to }
}

/**
 * tick / 取消 tick。
 * checkedName 規則（MD ④）：店舖帳號就寫揀咗嘅護士名，冇揀就寫帳號名
 *   （KIOSK 可以傳 nurseEmployeeId；其他角色唔傳就寫自己帳號名）。
 */
export async function setCellCheck(input: {
  clinicId: string
  date: string
  rowKey: string
  colKey: string
  checked: boolean
  nurseEmployeeId?: string | null
  actorId: string
}) {
  const { clinicId, date, rowKey, colKey, checked, actorId } = input
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new DailyCellCheckError('日期格式要 YYYY-MM-DD')
  if (!rowKey || !colKey) throw new DailyCellCheckError('rowKey、colKey 必填')

  // 操作人帳號名（checkedName 兜底；user 唔應該搵唔到，兜底寫 userId）
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { name: true, fullName: true } })
  const actorName = actor?.name || actor?.fullName || actorId

  // 護士名（KIOSK 可揀）— ★ cwm-premerge-fix-20261008：照整店護士核對口徑校驗（nurseOptions 該店該日）
  //   唔喺名單 → 400（原先任何員工 ID 都會用佢個名做「核對人」）
  let nurseName: string | null = null
  if (input.nurseEmployeeId) {
    const nurses = await nurseOptions(clinicId, date)
    const nurse = nurses.find(n => n.employeeId === input.nurseEmployeeId)
    if (!nurse) throw new DailyCellCheckError('呢位員工唔屬於呢間店，請重新揀')
    nurseName = nurse.name
  }
  const checkedName = nurseName || actorName

  if (checked) {
    // ★ MD ④：由伺服器重新計嗰格而家嘅金額（逐醫生模式單日，同頁面同一個 loadDailyReport），唔信前端
    const report = await loadDailyReport({ from: date, to: date, clinicId, providerId: null, scopeClinics: null })
    const row = report.rows.find(r => r.key === rowKey)
    const amount = row?.byMethod[colKey]
    if (amount == null || round2(amount) === 0) throw new DailyCellCheckError('呢格冇數', 400)

    const rowLabel = row?.label ?? rowKey
    const colLabel = report.methods.find(m => m.key === colKey)?.label ?? colKey

    try {
      return await prisma.$transaction(async tx => {
        const up = await tx.dailyRevenueCellCheck.upsert({
          where: { clinicId_date_rowKey_colKey: { clinicId, date, rowKey, colKey } },
          update: { amount, checkedBy: actorId, checkedName, checkedAt: new Date() },
          create: { clinicId, date, rowKey, colKey, amount, checkedBy: actorId, checkedName },
        })
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'DAILY_CELL_CHECK',
            entity: 'DailyRevenueCellCheck',
            entityId: up.id,
            clinicId,
            notes: `每日大數逐格核對：${date} · ${rowLabel} · ${colLabel} · $${round2(amount)}`,
            afterJson: JSON.stringify({ clinicId, date, rowKey, colKey, amount }),
          } as any,
        })
        return up
      })
    } catch (e: any) {
      // ★ 併發：兩部機同時剔同一格 → upsert 冇問題；race 撞 unique（P2002）→ 409（MD ④）
      if (e?.code === 'P2002') throw new DailyCellCheckError('呢格啱啱有變化，請重新整理', 409)
      throw e
    }
  }

  // 取消 tick：deleteMany（刪 0 筆都當成功 — idempotent；冇紀錄就冇嘢可審計）
  const existing = await prisma.dailyRevenueCellCheck.findUnique({
    where: { clinicId_date_rowKey_colKey: { clinicId, date, rowKey, colKey } },
  })
  await prisma.$transaction(async tx => {
    await tx.dailyRevenueCellCheck.deleteMany({ where: { clinicId, date, rowKey, colKey } })
    if (existing) {
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'DAILY_CELL_UNCHECK',
          entity: 'DailyRevenueCellCheck',
          entityId: existing.id,
          clinicId,
          notes: `取消每日大數逐格核對：${date} · ${rowKey} · ${colKey} · 原 $${Number(existing.amount)}（${existing.checkedName}）`,
        } as any,
      })
    }
  })
  return { deleted: existing ? 1 : 0 }
}

/** route 用：店舖帳號只准 tick 自己綁定嘅店（role 判斷全部經 lib — guard 紀律） */
export { kioskClinicAllowed }
