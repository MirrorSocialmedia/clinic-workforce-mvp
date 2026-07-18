export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// POST /api/face/enroll — Employee face enrollment via multipart form
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const form = await req.formData()
  const code = String(form.get('code') || '')
  const frames = form.getAll('frames') as File[]
  if (frames.length < 3) return NextResponse.json({ error: '至少需要 3 幀' }, { status: 400 })

  const employee = await prisma.employee.findUnique({ where: { userId: session.userId } })
  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const ec = await prisma.faceEnrollCode.findUnique({ where: { code } })
  if (!ec || ec.employeeId !== employee.id || ec.usedAt || ec.expiresAt < new Date()) {
    return NextResponse.json({ error: '登記碼無效或已過期' }, { status: 400 })
  }

  // ① 先建 pending 模板（embedding 佔位），拿 id
  const template = await prisma.faceTemplate.create({
    data: {
      employeeId: employee.id,
      embedding: '',
      active: false,
      enrolledBy: ec.createdBy,
      consentAt: new Date(),
      consentVersion: 'v2',
    },
  })

  // ② embed 請求帶 store_ref（face-service 存參考照）
  const fd = new FormData()
  frames.forEach(f => fd.append('files', f))
  fd.append('store_ref', template.id)
  const res = await fetch(`${process.env.FACE_SERVICE_URL}/embed`, { method: 'POST', body: fd })
  const data = await res.json()
  if (!res.ok || !data.ok) {
    await prisma.faceTemplate.delete({ where: { id: template.id } }) // 失敗清佔位
    return NextResponse.json({ error: data.error || '特徵提取失敗' }, { status: 422 })
  }

  // ③ 成功回寫 embedding + refFrameId（核銷 code 照舊）
  await prisma.$transaction([
    prisma.faceTemplate.update({
      where: { id: template.id },
      data: { embedding: JSON.stringify(data.embedding), refFrameId: `ref_${template.id}` },
    }),
    prisma.faceEnrollCode.update({ where: { id: ec.id }, data: { usedAt: new Date() } }),
  ] as const)

  // Audit
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'FACE_ENROLL',
      entity: 'FaceTemplate',
      entityId: employee.id,
      notes: `Face enrollment completed via code ${code}`,
      ipAddress: req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
    },
  })

  return NextResponse.json({ ok: true })
}
