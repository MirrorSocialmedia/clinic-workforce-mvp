export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { prisma } from '@/lib/prisma'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { revokeStaleEarlyOt } from '@/lib/early-in-ot'
import { toHKDateStr } from '@/lib/hk-date'
import { lockEmployee, toHttpResponse } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx } from '@/lib/payroll-lock'

// POST /api/punches/[id]/void — Void a punch record (OWNER/MANAGER)
export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { reason } = await req.json()
  const id = ctx.params.id

  if (!reason?.trim()) {
    return NextResponse.json({ error: '必須填寫作廢原因' }, { status: 400 })
  }

  // Check punch record exists
  const punch = await prisma.punchRecord.findUnique({ where: { id } })
  if (!punch) {
    return NextResponse.json({ error: '打卡記錄不存在' }, { status: 404 })
  }

  // ★ IDOR: MANAGER 只可以作廢自己店嘅打卡
  // ★ 用 resolveClinicScope 取代 assertClinicAccess（2026-08-03）
  // forPerms: 作廢打卡 → companyWide（考勤跨店）
  const allowedClinics = await resolveClinicScope(session, auth.perms ?? [], {
    companyWide: ['attendance_manage', 'scheduling'],
  })
  if (allowedClinics !== null && !allowedClinics.includes(punch.clinicId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Check not already voided
  const existingVoid = await prisma.punchVoid.findUnique({
    where: { punchRecordId: id },
  })
  if (existingVoid) {
    return NextResponse.json({ error: '此打卡記錄已被作廢' }, { status: 400 })
  }

  try {
    await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, punch.employeeId)
      // ★ Stage 4A（D1 硬鎖）：已出糧月份唔准作廢打卡
      await assertMonthsUnlockedTx(tx, {
        actorId: session.userId, employeeId: punch.employeeId, what: '作廢打卡',
        months: [toHKDateStr(punch.punchTime)],
      })
      await tx.punchVoid.create({ data: { punchRecordId: id, voidedBy: session.userId, reason } })
      await tx.auditLog.create({ data: {
        actorId: session.userId, action: 'VOID_PUNCH', entity: 'PunchRecord', entityId: id,
        targetEmployeeId: punch.employeeId, notes: `作廢打卡：${reason}` } })
      // ★ RC-07：指向呢張卡嘅 PENDING 修正已冇對象 → 標 REJECTED
      await tx.punchCorrection.updateMany({
        where: { punchRecordId: id, status: 'PENDING' },
        data: { status: 'REJECTED', approvedBy: session.userId },
      })
      await invalidateTimeBankFrom(punch.employeeId, punch.punchTime, tx)
      // ★ 2026-08-08: Revoke stale early-in OT if punches changed（Stage 2.4：入 tx，失敗 = rollback）
      await revokeStaleEarlyOt(punch.employeeId, toHKDateStr(punch.punchTime), session.userId, 'PUNCH_VOID', tx)
    })
  } catch (e: any) {
    { const r = toHttpResponse(e, '此打卡記錄已被作廢'); if (r) return r }
    throw e
  }

  return NextResponse.json({ ok: true })
}
