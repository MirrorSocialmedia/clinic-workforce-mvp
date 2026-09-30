export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { shiftDeletedMsg, buildNotification } from '@/lib/notification-messages'
import { createNotification } from '@/lib/notification'
import { toHttpResponse } from '@/lib/emp-lock'
import { applyResignCutoff } from '@/lib/resign-cutoff'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') // ROLE-OK
    return NextResponse.json({ error: '僅老闆可辦理離職' }, { status: 403 })

  const { lastDay } = await req.json()
  const resolvedParams = await params
  const empId = resolvedParams.id

  const emp = await prisma.employee.findUnique({
    where: { id: empId },
  })

  if (!emp) return NextResponse.json({ error: '員工不存在' }, { status: 404 })

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      // ★ 2026-09-30 [cwm-restdebt] F2：三條離職路徑共用 applyResignCutoff（RS-21）——
      //   Employee RESIGNED + leaveDate + resignedAt、User RESIGNED + tokenVersion+1、
      //   取消之後更／假 + 還額、跨過離職日嘅假截斷還差額（RS-06）、停人臉模板
      const r = await applyResignCutoff(tx, empId, lastDay)
      // Audit log
      await tx.auditLog.create({
        data: {
          actorId: auth.session.userId,
          action: 'EMPLOYEE_RESIGN',
          entity: 'Employee',
          entityId: empId,
          targetEmployeeId: empId,
          notes: `離職：最後工作日=${lastDay}, 取消班次=${r.shiftsCancelled}, 取消假期=${r.leavesCancelled}, 跨日假截斷=${r.leavesTruncated}`,
          ipAddress: null,
          userAgent: null,
        } as any,
      })
      return r
    })
  } catch (e: any) {
    { const r = toHttpResponse(e); if (r) return r }   // ★ E-11：BUSY 等 → 409
    throw e
  }

  // ★ 取消未來更次／假期會改變應出勤日 → 清時間帳戶快取（2026-08-10）
  const cutoffDate = new Date(`${lastDay}T16:00:00Z`) // HK midnight of lastDay+1

  // ★ Notify employee about cancelled future shifts
  // ★ 2026-09-30 [cwm-restdebt] RS-17：只發【今次取消】嗰啲（applyResignCutoff 回傳）——
  //   舊版 route 外撈「全部 CANCELLED && date > cutoff」會重發以前已取消嘅更
  if (result.cancelledShifts.length > 0) {
    const clinics = await prisma.clinic.findMany({ select: { id: true, name: true } })
    const clinicNameMap = new Map(clinics.map(c => [c.id, c.name]))
    const items = result.cancelledShifts.map(s => shiftDeletedMsg(s, (cid) => clinicNameMap.get(cid) ?? ''))
    await createNotification(buildNotification(empId, items))
  }

  try {
    await invalidateTimeBankFrom(empId, cutoffDate, prisma)
  } catch (e) {
    console.error('[timebank-cache] invalidate failed on resign', { empId, cutoff: cutoffDate }, e)
  }

  return NextResponse.json({ ok: true, ...result })
}
