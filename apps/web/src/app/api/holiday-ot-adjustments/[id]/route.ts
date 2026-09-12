// ★ cwm-holidayot-20260911 C4：取消假期返工 OT 扣減。
//   同 C3 一樣三道守衛（有更／在場上限／凍結・已確認）—— 刪都要 invalidate（方向相反，同一個坑④）。
//   ★ 拍板④：只有 OWNER。
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { toHKDateStr, hkDateOnly } from '@/lib/hk-date'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  const { id } = params

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const row = await prisma.holidayOtAdjustment.findUnique({ where: { id } })
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const workDate = toHKDateStr(row.workDate)

    // --- C3①：嗰日有更 → 唔准（同 PUT 一致）---
    const dayStart = hkDateOnly(workDate)
    const dayEnd = new Date(Date.parse(`${workDate}T23:59:59+08:00`) + 999)
    const hasShift = await prisma.shift.findFirst({
      where: { employeeId: row.employeeId, date: { gte: dayStart, lte: dayEnd }, status: { not: 'CANCELLED' } },
      select: { id: true },
    })
    if (hasShift) {
      return NextResponse.json(
        { error: '嗰日有更表 —— 更表日嘅 OT 由「不扣飯鐘」設定處理，唔喺呢度扣' },
        { status: 400 },
      )
    }

    // --- C3③：該月帳本已凍結／計糧已確認 → 唔准刪（刪咗帳本同糧單會唱反調）---
    const pm = workDate.slice(0, 7)
    const [frozen, run] = await Promise.all([
      prisma.timeBankLedgerSnapshot.findUnique({
        where: { employeeId_periodMonth: { employeeId: row.employeeId, periodMonth: pm } },
      }),
      prisma.payrollRun.findFirst({
        where: { periodMonth: hkDateOnly(`${pm}-01`), status: 'FINALIZED' },
        select: { id: true },
      }),
    ])
    if (frozen) {
      return NextResponse.json({ error: `${pm} 時間帳戶帳本已凍結 —— 請先喺計糧退回草稿` }, { status: 409 })
    }
    if (run) {
      return NextResponse.json({ error: `${pm} 計糧已確認 —— 請先退回草稿` }, { status: 409 })
    }

    await prisma.$transaction(async (tx) => {
      await tx.holidayOtAdjustment.delete({ where: { id } })
      // ★★★ 刪都要 invalidate —— 方向相反，同一個坑④
      await invalidateTimeBankFrom(row.employeeId, row.workDate, tx)
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'HOLIDAY_OT_ADJUST_DELETE',
          entity: 'HolidayOtAdjustment',
          entityId: row.id,
          targetEmployeeId: row.employeeId,
          beforeJson: JSON.stringify({ deductMinutes: row.deductMinutes, reason: row.reason }),
          afterJson: 'null',
          notes: `移除假期返工 OT 扣減 ${workDate}（${row.deductMinutes} 分）。原原因：${row.reason}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })
    })

    return NextResponse.json({ ok: true })
  })
}
