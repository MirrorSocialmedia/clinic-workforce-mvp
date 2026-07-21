export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
 const auth = await requireAuth(req, 'POST', req.url)
 if (isAuthError(auth)) return auth.error

 const body = await req.json().catch(() => ({}))
 const action = body.action as 'approve' | 'reject'
 if (!['approve', 'reject'].includes(action)) return NextResponse.json({ error: 'Invalid action' }, { status: 400 })

 const template = await prisma.faceTemplate.findUnique({
  where: { id: params.id },
  include: { employee: { select: { userId: true } } },
 })
 if (!template) return NextResponse.json({ error: '登記不存在' }, { status: 404 })
 if (template.employee.userId === auth.session.userId) {
  return NextResponse.json({ error: '不能核准自己的臉部登記，請由另一位管理員處理' }, { status: 400 })
 }

 // 刪除參考照
 if (template.refFrameId) {
  try {
   const url = process.env.NEXT_PUBLIC_FACE_SERVICE_URL || 'http://face:8000'
   await fetch(`${url}/frame/${template.refFrameId}`, { method: 'DELETE' })
  } catch { /* ignore */ }
 }

 if (action === 'approve') {
  // Atomic switch: deactivate old active template, activate new one
  await prisma.$transaction([
    prisma.faceTemplate.updateMany({
      where: { employeeId: template.employeeId, active: true },
      data: { active: false },
    }),
    prisma.faceTemplate.update({
      where: { id: params.id },
      data: { active: true, approvedAt: new Date(), approvedBy: auth.session.userId, refFrameId: null },
    }),
  ])
  await prisma.auditLog.create({
   data: {
    actorId: auth.session.userId,
    action: 'FACE_ENROLL_APPROVE',
    entity: 'FaceTemplate',
    entityId: template.id,
    targetEmployeeId: template.employeeId,
    notes: `核准員工 ${template.employeeId} 臉部登記（原子切換，舊模板停用保留）`,
   },
  })
 } else {
  await prisma.faceTemplate.delete({ where: { id: params.id } })
  await prisma.auditLog.create({
   data: {
    actorId: auth.session.userId,
    action: 'FACE_ENROLL_REJECT',
    entity: 'FaceTemplate',
    entityId: template.id,
    targetEmployeeId: template.employeeId,
    notes: `拒絕員工 ${template.employeeId} 臉部登記`,
   },
  })
 }

 return NextResponse.json({ ok: true })
}
