export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'

// PUT /api/shift-changes/[id] — ★ Stage 1.10（D4 拍板：停用）
//   UI 已冇入口（scheduling SHOW_LEGACY_CALENDAR=false :3953），舊 approve 路徑冇 status guard、唔 atomic（審計 RC-10）。
//   唔留一條冇人測嘅寫入路徑：一律 410。將來要重開，按審計 §8 Stage 1.10 嘅 claim 寫法重寫。
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  void params
  return NextResponse.json({ error: '更表交換功能已停用' }, { status: 410 })
}

// DELETE（員工取消 PENDING 申請）保留：只會將 PENDING → REJECTED，冇副作用
// DELETE /api/shift-changes/[id] — cancel pending request
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope, perms } = auth

  try {
    const id = params.id
    const changeRequest = await prisma.shiftChangeRequest.findUnique({
      where: { id },
      include: { shift: { select: { clinicId: true } } },
    })
    if (!changeRequest) return NextResponse.json({ error: 'Change request not found' }, { status: 404 })

    // ★ 有編更權限就可以審批任何店嘅換更（同排班一致）
    if (!(perms ?? []).includes('scheduling')) {
      const denied = assertClinicAccess(scope, session, changeRequest.shift?.clinicId)
      if (denied) return denied
    }

    const emp = await prisma.employee.findUnique({ where: { userId: session.userId } })
    if (!emp || emp.id !== changeRequest.fromEmployeeId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (changeRequest.status !== 'PENDING') {
      return NextResponse.json({ error: 'Can only cancel pending requests' }, { status: 409 })
    }

    await prisma.shiftChangeRequest.update({ where: { id }, data: { status: 'REJECTED' } })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Cancel shift change error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
