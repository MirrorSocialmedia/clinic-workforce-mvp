export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { CONFIG } from '@/lib/config'

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

 // ★ 決定（2026-07-29）：核准後永久保留參考照，作為「該次登記經核准」嘅憑證。
 //   拒絕嘅情況仍然即刻刪 —— 冇核准就冇保留嘅理由。
 if (action === 'approve') {
  // Atomic switch: deactivate old active template, activate new one
  await prisma.$transaction([
    prisma.faceTemplate.updateMany({
      where: { employeeId: template.employeeId, active: true },
      data: { active: false },
    }),
    prisma.faceTemplate.update({
      where: { id: params.id },
      data: {
       active: true,
       approvedAt: new Date(),
       approvedBy: auth.session.userId,
       // ★ 唔再清 refFrameId —— 永久保留參考照
      },
    }),
  ])
  await prisma.auditLog.create({
   data: {
    actorId: auth.session.userId,
    action: 'FACE_ENROLL_APPROVE',
    entity: 'FaceTemplate',
    entityId: template.id,
    targetEmployeeId: template.employeeId,
    notes: `核准員工 ${template.employeeId} 臉部登記（原子切換，舊模板停用保留；參考照永久保留）`,
   },
  })
 } else {
  // 拒絕：刪相 + 刪記錄
  if (template.refFrameId) {
   try {
    await fetch(`${CONFIG.FACE_SERVICE_URL}/frame/${template.refFrameId}?allow_ref=1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(CONFIG.FACE_TIMEOUT_MS),
     })
   } catch { /* ignore */ }
  }
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
