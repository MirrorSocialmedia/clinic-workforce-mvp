export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

/**
 * GET /api/accounts/[id]/purge-preview
 * Returns per-table counts + blocks for the purge modal (OWNER only)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const userId = params.id

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { employee: { select: { id: true } } },
  })

  if (!user) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const empId = user.employee?.id ?? null

  // ── Count all related tables (parallel) ──
  const base = empId ? { employeeId: empId } : undefined

  const [
    punchRecord,
    punchVoid,
    punchCorrection,
    shift,
    shiftChangeRequest,
    leaveRequest,
    leaveBalance,
    payrollItem,
    expenseEntry,
    faceTemplate,
    faceEnrollCode,
    auditLog,
    timeBankEntry,
    notification,
    qRTokenUsage,
    employeeClinic,
    payRule,
    userClinic,
    wageHistory,
    timeBank,
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
      where: {
        OR: [
          { actorId: userId },
          ...(empId ? [{ targetEmployeeId: empId }] : []),
        ],
      },
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

  const counts = {
    punchRecord, punchVoid, punchCorrection, shift, shiftChangeRequest,
    leaveRequest, leaveBalance, payrollItem, expenseEntry,
    faceTemplate, faceEnrollCode, auditLog, timeBankEntry,
    notification, qRTokenUsage, employeeClinic, payRule, userClinic,
    wageHistory, timeBank,
  }

  // ── Blocks ──
  const blocks: Array<{ table: string; count: number; message: string }> = []

  // Block 1: PayrollItem > 0
  if (counts.payrollItem > 0) {
    blocks.push({
      table: 'PayrollItem',
      count: counts.payrollItem,
      message: `此帳號有 ${counts.payrollItem} 筆計糧記錄 — 請先刪除／重新生成相關計糧 run`,
    })
  }

  // Block 2: ShiftChangeRequest.approverId (this user as approver for OTHERS)
  if (empId) {
    const approverCount = await prisma.shiftChangeRequest.count({
      where: {
        approverId: empId,
        NOT: [{ fromEmployeeId: empId }, { toEmployeeId: empId }],
      },
    })
    if (approverCount > 0) {
      blocks.push({
        table: 'ShiftChangeRequest.approver',
        count: approverCount,
        message: `此帳號曾批核他人換更 ${approverCount} 筆，清除會刪走他人記錄`,
      })
    }
  }

  return jsonNoStore({
    user: {
      name: user.name,
      email: user.email,
      hasEmployee: !!empId,
    },
    counts,
    blocks,
  })
}
