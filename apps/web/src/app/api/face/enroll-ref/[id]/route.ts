export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { CONFIG } from '@/lib/config'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
 const auth = await requireAuth(req, 'GET', req.url)
 if (isAuthError(auth)) return auth.error
 const { session, scope } = auth

 const template = await prisma.faceTemplate.findUnique({ where: { id: params.id } })
 if (!template || !template.refFrameId) return NextResponse.json(
  { error: '此登記無參考照（舊版登記），請拒絕並讓員工重新登記' }, { status: 404 })

 // ★ IDOR: MANAGER 只可以睇自己店員工嘅人臉
 const emp = await prisma.employee.findUnique({
   where: { id: template.employeeId },
   select: { homeClinicId: true },
 })
 const denied = assertClinicAccess(scope, session, emp?.homeClinicId)
 if (denied) return denied

 // Audit log
 await prisma.auditLog.create({
  data: {
   actorId: auth.session.userId,
   action: 'FACE_REF_VIEW',
   entity: 'FaceTemplate',
   entityId: template.id,
   targetEmployeeId: template.employeeId,
   notes: `參考照查看: ${template.employeeId}`,
  },
 })

 // 從 face-service 拿參考照
 try {
  const res = await fetch(`${CONFIG.FACE_SERVICE_URL}/frame/${template.refFrameId}`, {
    signal: AbortSignal.timeout(CONFIG.FACE_TIMEOUT_MS),
  })
  if (!res.ok) return NextResponse.json({ error: 'Frame not found' }, { status: 404 })
  const buf = await res.arrayBuffer()
  return new NextResponse(buf, { headers: { 'Content-Type': 'image/jpeg' } })
 } catch {
  return NextResponse.json({ error: 'Face service unavailable' }, { status: 503 })
 }
}
