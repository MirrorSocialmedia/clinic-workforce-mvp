export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

export async function GET(req: NextRequest, { params }: { params: { templateId: string } }) {
 const auth = requireAuth(req, 'GET', req.url)
 if (isAuthError(auth)) return auth.error

 const template = await prisma.faceTemplate.findUnique({ where: { id: params.templateId } })
 if (!template || !template.refFrameId) return NextResponse.json(
  { error: '此登記無參考照（舊版登記），請拒絕並讓員工重新登記' }, { status: 404 })

 // Audit log
 await prisma.auditLog.create({
  data: {
   actorId: auth.session.userId,
   action: 'FACE_REF_VIEW',
   entity: 'FaceTemplate',
   entityId: template.id,
   notes: `參考照查看: ${template.employeeId}`,
  },
 })

 // 從 face-service 拿參考照
 try {
  const url = process.env.NEXT_PUBLIC_FACE_SERVICE_URL || 'http://face:8000'
  const res = await fetch(`${url}/frame/${template.refFrameId}`)
  if (!res.ok) return NextResponse.json({ error: 'Frame not found' }, { status: 404 })
  const buf = await res.arrayBuffer()
  return new NextResponse(buf, { headers: { 'Content-Type': 'image/jpeg' } })
 } catch {
  return NextResponse.json({ error: 'Face service unavailable' }, { status: 503 })
 }
}
