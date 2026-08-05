export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { CONFIG } from '@/lib/config'

/**
 * POST /api/accounts/[id]/purge — 徹底清除帳號 (OWNER only)
 * Body: { confirmName: string } — must match user.name
 * Protections: no self-delete, no OWNER role, blocks same as preview
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const userId = params.id

  // ── Body ──
  let body: { confirmName?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  // ── Protection: no self-delete ──
  if (session.userId === userId) {
    return NextResponse.json({ error: '不能刪除自己的帳號' }, { status: 400 })
  }

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { employee: { select: { id: true } } },
    })

    if (!user) return NextResponse.json({ error: '帳號不存在' }, { status: 404 })

    // ── Protection: name confirm ──
    if (body.confirmName !== user.name) {
      return NextResponse.json({ error: '姓名不符，確認失敗' }, { status: 400 })
    }

    // ── Protection: no OWNER role ──
    if (user.role === 'OWNER') { // ROLE-OK: purge 唔准刪 OWNER（同 DELETE 一致）
      return NextResponse.json({ error: '不能刪除 OWNER 帳號' }, { status: 400 })
    }

    const empId = user.employee?.id ?? null

    // ── Blocks (same as preview) ──
    if (empId) {
      const payrollCount = await prisma.payrollItem.count({ where: { employeeId: empId } })
      if (payrollCount > 0) {
        return NextResponse.json({
          error: `此帳號有 ${payrollCount} 筆計糧記錄 — 請先刪除／重新生成相關計糧 run`,
        }, { status: 400 })
      }

      const approverCount = await prisma.shiftChangeRequest.count({
        where: {
          approverId: empId,
          NOT: [{ fromEmployeeId: empId }, { toEmployeeId: empId }],
        },
      })
      if (approverCount > 0) {
        return NextResponse.json({
          error: `此帳號曾批核他人換更 ${approverCount} 筆，清除會刪走他人記錄`,
        }, { status: 400 })
      }
    }

    // ── Collect counts BEFORE purge (for audit afterJson) ──
    const base = empId ? { employeeId: empId } : undefined
    const [
      cPunchRecord, cPunchVoid, cPunchCorrection, cShift, cShiftChangeRequest,
      cLeaveRequest, cLeaveBalance, cPayrollItem, cExpenseEntry,
      cFaceTemplate, cFaceEnrollCode, cAuditLog, cTimeBankEntry,
      cNotification, cQRTokenUsage, cEmployeeClinic, cPayRule,
      cUserClinic, cWageHistory, cTimeBank,
    ] = await Promise.all([
      base ? prisma.punchRecord.count({ where: base }) : Promise.resolve(0),
      empId ? prisma.punchVoid.count({ where: { punchRecord: { employeeId: empId } } }) : Promise.resolve(0),
      base ? prisma.punchCorrection.count({ where: base }) : Promise.resolve(0),
      base ? prisma.shift.count({ where: base }) : Promise.resolve(0),
      empId ? prisma.shiftChangeRequest.count({
        where: { OR: [{ fromEmployeeId: empId }, { toEmployeeId: empId }] },
      }) : Promise.resolve(0),
      base ? prisma.leaveRequest.count({ where: base }) : Promise.resolve(0),
      base ? prisma.leaveBalance.count({ where: base }) : Promise.resolve(0),
      base ? prisma.payrollItem.count({ where: base }) : Promise.resolve(0),
      base ? prisma.expenseEntry.count({ where: base }) : Promise.resolve(0),
      base ? prisma.faceTemplate.count({ where: base }) : Promise.resolve(0),
      base ? prisma.faceEnrollCode.count({ where: base }) : Promise.resolve(0),
      prisma.auditLog.count({
        where: { OR: [{ actorId: userId }, ...(empId ? [{ targetEmployeeId: empId }] : [])] },
      }),
      base ? prisma.timeBankEntry.count({ where: base }) : Promise.resolve(0),
      base ? prisma.notification.count({ where: base }) : Promise.resolve(0),
      base ? prisma.qRTokenUsage.count({ where: base }) : Promise.resolve(0),
      base ? prisma.employeeClinic.count({ where: base }) : Promise.resolve(0),
      base ? prisma.payRule.count({ where: base }) : Promise.resolve(0),
      prisma.userClinic.count({ where: { userId } }),
      base ? prisma.wageHistory.count({ where: base }) : Promise.resolve(0),
      base ? prisma.timeBank.count({ where: base }) : Promise.resolve(0),
    ])

    const allCounts = {
      punchRecord: cPunchRecord, punchVoid: cPunchVoid, punchCorrection: cPunchCorrection,
      shift: cShift, shiftChangeRequest: cShiftChangeRequest,
      leaveRequest: cLeaveRequest, leaveBalance: cLeaveBalance,
      payrollItem: cPayrollItem, expenseEntry: cExpenseEntry,
      faceTemplate: cFaceTemplate, faceEnrollCode: cFaceEnrollCode,
      auditLog: cAuditLog, timeBankEntry: cTimeBankEntry,
      notification: cNotification, qRTokenUsage: cQRTokenUsage,
      employeeClinic: cEmployeeClinic, payRule: cPayRule, userClinic: cUserClinic,
      wageHistory: cWageHistory, timeBank: cTimeBank,
    }

    // ── Purge transaction (FK order) ──
    await prisma.$transaction(async (tx) => {
      if (empId) {
        await tx.notification.deleteMany({ where: { employeeId: empId } })
        await tx.qRTokenUsage.deleteMany({ where: { employeeId: empId } })
        await tx.faceEnrollCode.deleteMany({ where: { employeeId: empId } })
        await tx.faceTemplate.deleteMany({ where: { employeeId: empId } })
        await tx.punchCorrection.deleteMany({ where: { employeeId: empId } })
        await tx.punchVoid.deleteMany({ where: { punchRecord: { employeeId: empId } } })
        await tx.punchRecord.deleteMany({ where: { employeeId: empId } })
        await tx.shiftChangeRequest.deleteMany({
          where: { OR: [{ fromEmployeeId: empId }, { toEmployeeId: empId }] },
        })
        await tx.shift.deleteMany({ where: { employeeId: empId } })
        await tx.leaveRequest.deleteMany({ where: { employeeId: empId } })
        await tx.leaveBalance.deleteMany({ where: { employeeId: empId } })
        await tx.expenseEntry.deleteMany({ where: { employeeId: empId } })
        await tx.timeBankEntry.deleteMany({ where: { employeeId: empId } })
        await tx.employeeClinic.deleteMany({ where: { employeeId: empId } })
        await tx.payRule.deleteMany({ where: { employeeId: empId } })
        await tx.wageHistory.deleteMany({ where: { employeeId: empId } })
        await tx.timeBank.deleteMany({ where: { employeeId: empId } })
      }
      await tx.auditLog.deleteMany({
        where: { OR: [{ actorId: userId }, ...(empId ? [{ targetEmployeeId: empId }] : [])] },
      })
      if (empId) await tx.employee.delete({ where: { id: empId } })
      await tx.userClinic.deleteMany({ where: { userId } })
      await tx.user.delete({ where: { id: userId } })
    })

    // ── Post-tx: write ACCOUNT_PURGE audit ──
    await prisma.auditLog.create({
      data: {
        action: 'ACCOUNT_PURGE',
        entity: 'ACCOUNT',
        entityId: userId,
        actorId: session.userId,
        // targetEmployeeId 唔寫 — 目標 employee 已刪除，寫咗必 FK violation
        afterJson: JSON.stringify({
          name: user.name,
          email: user.email,
          counts: allCounts,
        }),
      },
    })

    return NextResponse.json({ ok: true })
  })
}
