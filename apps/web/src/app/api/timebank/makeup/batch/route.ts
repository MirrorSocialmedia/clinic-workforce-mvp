export const dynamic = 'force-dynamic'
// ★ cwm-attbatch-20260927：早退批量補鐘（spec §5）
// 逐筆獨立 transaction（D5）＋嚴格驗證（D6：重算實際早退分鐘 > 0 且 = 前端送嘅分鐘）
// 同單筆共用：emp-lock / payroll-lock / timebank-makeup（computeActualMakeupMinutes、makeupEntryDate、makeupNote）
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import prisma from '@/lib/prisma'
import { lockEmployee, HttpError, isLockBusy } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx, findLockedMonths } from '@/lib/payroll-lock'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { getMonthRange } from '@/lib/hk-date'
import { flagIfSelfEdit } from '@/lib/self-edit-flag'
import { computeActualMakeupMinutes, isHourlyForMonth, makeupEntryDate, makeupNote } from '@/lib/timebank-makeup'

type FailCode = 'NOT_FOUND' | 'HOURLY' | 'PAYROLL_LOCKED' | 'NO_SHIFT' | 'NO_EARLY_LEAVE' | 'STALE' | 'BUSY' | 'ERROR'

type BatchResult = {
  employeeId: string
  date: string
  minutes: number
  status: 'SUCCESS' | 'WOULD_SUCCEED' | 'SKIPPED' | 'FAILED'
  code?: FailCode
  message?: string
  actualMinutes?: number | null
}

// tx 內「已有補鐘紀錄」→ 跳過（唔係錯誤）
class SkipError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

const pairKey = (employeeId: string, date: string) => `${employeeId}|${date.slice(0, 7)}`

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  // ★ 權限同單筆一致（D3：沿用 timebank_ops，唔限診所範圍）
  if (!(perms ?? []).includes('timebank_ops')) {
    return NextResponse.json(
      { error: 'Forbidden (missing permission: timebank_ops)' },
      { status: 403 },
    )
  }

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: '請求格式錯誤（JSON）' }, { status: 400 })
  }
  const { batchId, dryRun, reason, items } = body

  // ── 整批驗證（§5.3）：任何一項唔過 → 400，唔寫任何嘢 ──
  if (typeof batchId !== 'string' || batchId.length < 1 || batchId.length > 64) {
    return NextResponse.json({ error: 'batchId 必須係 1–64 字字串' }, { status: 400 })
  }
  if (typeof dryRun !== 'boolean') {
    return NextResponse.json({ error: 'dryRun 必須係 boolean' }, { status: 400 })
  }
  const reasonTrimmed = typeof reason === 'string' ? reason.trim() : ''
  if (!dryRun && (reasonTrimmed.length < 1 || reasonTrimmed.length > 200)) {
    return NextResponse.json({ error: '原因為必填' }, { status: 400 })
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) {
    return NextResponse.json({ error: '一次過最多 200 筆，請分批' }, { status: 400 })
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it || typeof it.employeeId !== 'string' || it.employeeId.length === 0) {
      return NextResponse.json({ error: `第 ${i + 1} 筆：employeeId 必須係非空字串` }, { status: 400 })
    }
    if (typeof it.date !== 'string' || !DATE_RE.test(it.date) || !isRealDate(it.date)) {
      return NextResponse.json({ error: `第 ${i + 1} 筆：date 必須係真實日期（YYYY-MM-DD）` }, { status: 400 })
    }
    if (!Number.isInteger(it.minutes) || it.minutes < 1 || it.minutes > 1440) {
      return NextResponse.json({ error: `第 ${i + 1} 筆：minutes 必須係 1–1440 嘅整數` }, { status: 400 })
    }
  }
  {
    const seen = new Set<string>()
    for (const it of items) {
      const k = `${it.employeeId}|${it.date}`
      if (seen.has(k)) {
        return NextResponse.json({ error: `同一員工同一日重複（${it.employeeId}, ${it.date}）` }, { status: 400 })
      }
      seen.add(k)
    }
  }

  // §5.4：按 employeeId、再按 date 排序，然後順序（唔好 Promise.all）逐筆處理
  const sortedItems = [...items].sort((a: any, b: any) =>
    a.employeeId.localeCompare(b.employeeId) || a.date.localeCompare(b.date))

  // §5.6 預載：員工存在 + 時薪判斷（迴圈之前先按 distinct 預載，唔逐筆查）
  const empIds = [...new Set(sortedItems.map((it: any) => it.employeeId))]
  const empRows = await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true } })
  const empIdSet = new Set(empRows.map((r: any) => r.id))

  const hourlyCache = new Map<string, boolean>()
  for (const pk of [...new Set(sortedItems.map((it: any) => pairKey(it.employeeId, it.date)))]) {
    const [empId, ym] = pk.split('|')
    const { start: monthStart, end: monthEnd } = getMonthRange(new Date(`${ym}-15T00:00:00+08:00`))
    hourlyCache.set(pk, await isHourlyForMonth(prisma, empId, monthStart, monthEnd))
  }

  const actorId = session.userId
  const results: BatchResult[] = []
  // 每筆成功 → 記低 employeeId → 最早成功日期（commit 之後 invalidate 用）
  const successByEmp = new Map<string, string>()

  for (const it of sortedItems) {
    const base = { employeeId: it.employeeId, date: it.date, minutes: it.minutes }

    // ① 員工存在？
    if (!empIdSet.has(it.employeeId)) {
      results.push({ ...base, status: 'FAILED', code: 'NOT_FOUND', message: '搵唔到員工' })
      continue
    }
    // ② 時薪？
    if (hourlyCache.get(pairKey(it.employeeId, it.date))) {
      results.push({ ...base, status: 'FAILED', code: 'HOURLY', message: '時薪員工不適用' })
      continue
    }

    if (dryRun) {
      // ③ 已有 MAKEUP/EARLY_LEAVE 同日紀錄？
      const dateStart = new Date(it.date + 'T00:00:00+08:00')
      const dateEnd = new Date(it.date + 'T23:59:59+08:00')
      const existing = await prisma.timeBankEntry.findFirst({
        where: { employeeId: it.employeeId, type: 'MAKEUP', targetType: 'EARLY_LEAVE', date: { gte: dateStart, lte: dateEnd } },
      })
      if (existing) {
        results.push({ ...base, status: 'SKIPPED', message: '已補鐘，會跳過' })
        continue
      }
      // ④ 計糧已鎖？（唯讀查詢，唔寫 audit —— 試算唔應該留紀錄）
      const locked = await findLockedMonths(it.employeeId, [it.date])
      if (locked.length > 0) {
        results.push({ ...base, status: 'FAILED', code: 'PAYROLL_LOCKED', message: `${locked.join('、')} 計糧已確認，要先退回草稿` })
        continue
      }
      // ⑤ 重算（D6 嚴格：null / 0 / ≠ 前端分鐘 → 失敗）
      const actual = await computeActualMakeupMinutes(prisma, it.employeeId, it.date, 'EARLY_LEAVE')
      if (actual === null) {
        results.push({ ...base, status: 'FAILED', code: 'NO_SHIFT', message: '當日搵唔到更' })
        continue
      }
      if (actual === 0) {
        results.push({ ...base, status: 'FAILED', code: 'NO_EARLY_LEAVE', message: '當日已無早退（打卡可能已改正）' })
        continue
      }
      if (actual !== it.minutes) {
        results.push({ ...base, status: 'FAILED', code: 'STALE', message: `早退分鐘已變為 ${actual} 分，請刷新再試`, actualMinutes: actual })
        continue
      }
      results.push({ ...base, status: 'WOULD_SUCCEED' })
      continue
    }

    // ── 寫入：逐筆獨立 transaction（D5）──
    try {
      const entry = await prisma.$transaction(async (tx: any) => {
        await lockEmployee(tx, it.employeeId)
        await assertMonthsUnlockedTx(tx, { actorId, employeeId: it.employeeId, months: [it.date], what: '批量補鐘' })
        // ③ 鎖內再查（同補鐘紀錄一齊 commit 口徑）
        const dateStart = new Date(it.date + 'T00:00:00+08:00')
        const dateEnd = new Date(it.date + 'T23:59:59+08:00')
        const existing = await tx.timeBankEntry.findFirst({
          where: { employeeId: it.employeeId, type: 'MAKEUP', targetType: 'EARLY_LEAVE', date: { gte: dateStart, lte: dateEnd } },
        })
        if (existing) throw new SkipError()
        // ⑤ 鎖內用最新打卡重算（D6 嚴格）
        const actual = await computeActualMakeupMinutes(tx, it.employeeId, it.date, 'EARLY_LEAVE')
        if (actual === null) throw new HttpError(409, '當日搵唔到更', { code: 'NO_SHIFT' })
        if (actual === 0) throw new HttpError(409, '當日已無早退（打卡可能已改正）', { code: 'NO_EARLY_LEAVE' })
        if (actual !== it.minutes) throw new HttpError(409, `早退分鐘已變為 ${actual} 分，請刷新再試`, { code: 'STALE', actualMinutes: actual })
        // 補鐘紀錄 + 審計同生同死（§7 不變式 5）
        const beforeAgg = await tx.timeBankEntry.aggregate({ where: { employeeId: it.employeeId }, _sum: { minutes: true } })
        const created = await tx.timeBankEntry.create({
          data: {
            employeeId: it.employeeId,
            date: makeupEntryDate(it.date),
            type: 'MAKEUP',
            minutes: -it.minutes,
            targetType: 'EARLY_LEAVE',
            note: makeupNote('EARLY_LEAVE', it.minutes),
            createdBy: actorId,
          },
        })
        const afterAgg = await tx.timeBankEntry.aggregate({ where: { employeeId: it.employeeId }, _sum: { minutes: true } })
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'TIMEBANK_MAKEUP',
            entity: 'TimeBank',
            entityId: it.employeeId,
            targetEmployeeId: it.employeeId,
            beforeJson: JSON.stringify({ balanceMinutes: beforeAgg._sum.minutes ?? 0 }),
            afterJson: JSON.stringify({ balanceMinutes: afterAgg._sum.minutes ?? 0 }),
            notes: JSON.stringify({
              delta: -it.minutes, date: it.date, reason: reasonTrimmed,
              targetType: 'EARLY_LEAVE', batchId, source: 'BATCH',
            }),
          },
        } as any)
        return created
      }, { timeout: 8000 })

      results.push({ ...base, status: 'SUCCESS' })
      const prev = successByEmp.get(it.employeeId)
      if (!prev || it.date < prev) successByEmp.set(it.employeeId, it.date)
      void entry
    } catch (e: any) {
      if (e instanceof SkipError || e?.code === 'P2002') {
        // 撞 TimeBankEntry_makeup_once = 已經有人補咗（§7 不變式 1：重送 → SKIPPED，唔會 500）
        results.push({ ...base, status: 'SKIPPED', message: '已補鐘，會跳過' })
        continue
      }
      if (e instanceof HttpError && e.extra?.code === 'PAYROLL_LOCKED') {
        const months = Array.isArray(e.extra?.months) ? (e.extra.months as string[]).join('、') : ''
        results.push({ ...base, status: 'FAILED', code: 'PAYROLL_LOCKED', message: `${months} 計糧已確認，要先退回草稿` })
        continue
      }
      if (e instanceof HttpError && e.extra?.code) {
        const code = e.extra.code as FailCode
        results.push({
          ...base, status: 'FAILED', code, message: e.message,
          ...(code === 'STALE' ? { actualMinutes: (e.extra?.actualMinutes as number) ?? null } : {}),
        })
        continue
      }
      if (isLockBusy(e)) {
        results.push({ ...base, status: 'FAILED', code: 'BUSY', message: '該員工資料正喺度處理緊' })
        continue
      }
      // 其他：log 唔中斷迴圈（§5.4：一筆失敗唔影響其他筆）
      console.error(`[makeup-batch] 逐筆失敗（唔中斷迴圈） employeeId=${it.employeeId} date=${it.date}`, e)
      results.push({ ...base, status: 'FAILED', code: 'ERROR', message: '系統錯誤' })
    }
  }

  // ── commit 之後（全部逐筆完成後先做，dry-run 唔做；§5.4）──
  if (!dryRun) {
    // 1) 每個有成功嘅員工 invalidate 一次（最早成功日期；try/catch 同單筆一致）
    for (const [empId, earliestDate] of successByEmp) {
      try {
        await invalidateTimeBankFrom(empId, earliestDate, prisma)
      } catch (e) {
        console.error(`[timebank-cache] batch invalidate failed employeeId=${empId} date=${earliestDate}`, e)
      }
    }
    // 2) 每筆成功 call flagIfSelfEdit（同單筆 P1-6 口徑）
    for (const r of results) {
      if (r.status !== 'SUCCESS') continue
      await flagIfSelfEdit({
        actorUserId: actorId,
        targetEmployeeId: r.employeeId,
        what: '批量補鐘',
        detail: { date: r.date, minutes: -r.minutes, targetType: 'EARLY_LEAVE', batchId },
        req,
      })
    }
  }

  const summary = {
    success: results.filter(r => r.status === 'SUCCESS' || r.status === 'WOULD_SUCCEED').length,
    skipped: results.filter(r => r.status === 'SKIPPED').length,
    failed: results.filter(r => r.status === 'FAILED').length,
  }

  // 3) 批次總結 audit（tx 外，try/catch）
  if (!dryRun) {
    try {
      await prisma.auditLog.create({
        data: {
          actorId,
          action: 'TIMEBANK_MAKEUP_BATCH',
          entity: 'TimeBank',
          entityId: batchId,
          notes: JSON.stringify({
            reason: reasonTrimmed,
            requested: items.length,
            success: summary.success, skipped: summary.skipped, failed: summary.failed,
            failures: results.filter(r => r.status === 'FAILED').map(r => ({ employeeId: r.employeeId, date: r.date, code: r.code })),
          }),
        },
      } as any)
    } catch (e) {
      console.error('[makeup-batch] 批次總結 audit 失敗', e)
    }
  }

  return NextResponse.json({ batchId, dryRun, summary, results })
}
