export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// POST /api/face/verify-punch — Verify face against punch record (shadow mode)
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  let form: FormData
  try { form = await req.formData() } catch {
    return NextResponse.json({ error: 'body aborted' }, { status: 400 })
  }
  const punchId = String(form.get('punchId') || '')
  const frame = form.get('frame') as File | null
  const result = String(form.get('result') || '')

  const employee = await prisma.employee.findUnique({ where: { userId: session.userId } })
  const punch = await prisma.punchRecord.findUnique({ where: { id: punchId } })
  if (!employee || !punch || punch.employeeId !== employee.id) {
    return NextResponse.json({ error: 'punch not found' }, { status: 404 })
  }

  const tmpl = await prisma.faceTemplate.findFirst({ where: { employeeId: employee.id, active: true } })
  if (!tmpl) {
   // Check for pending enrollment
   const pending = await prisma.faceTemplate.findFirst({ where: { employeeId: employee.id, active: false, approvedAt: null } })
   if (pending) {
    await prisma.punchRecord.update({ where: { id: punchId }, data: { faceStatus: 'PENDING_ENROLL' } })
    return NextResponse.json({ status: 'PENDING_ENROLL' })
   }
   await prisma.punchRecord.update({ where: { id: punchId }, data: { faceStatus: 'NOT_ENROLLED' } })
   return NextResponse.json({ status: 'NOT_ENROLLED' })
  }
  // result 優先分流 (NO_FACE 可能帶證據幀,不走此分支)
  if (result === 'NO_FACE') {
    const reason = String(form.get('reason') || '') || null
    let framePath: string | null = null
    if (frame) {
      try {
        const fd2 = new FormData(); fd2.append('file', frame)
        const r2 = await fetch(`${process.env.FACE_SERVICE_URL}/store/${punchId}`, { method: 'POST', body: fd2 })
        if (r2.ok) { const j = await r2.json(); framePath = j.framePath ?? null }
      } catch { /* 存證失敗不阻擋 */ }
    }
    await prisma.punchRecord.update({ where: { id: punchId }, data: { faceStatus: 'NO_FACE', faceReason: reason, faceFramePath: framePath } })
    return NextResponse.json({ status: 'NO_FACE' })
  }

  if (!frame) {
    const reason = String(form.get('reason') || '') || null
    await prisma.punchRecord.update({ where: { id: punchId }, data: { faceStatus: 'SKIPPED', faceReason: reason } })
    return NextResponse.json({ status: 'SKIPPED' })
  }

  try {
    const fd = new FormData()
    fd.append('file', frame)
    fd.append('embedding', tmpl.embedding)
    fd.append('punch_id', punchId)
    fd.append('threshold', process.env.FACE_THRESHOLD || '0.45')
    const res = await fetch(`${process.env.FACE_SERVICE_URL}/verify`, { method: 'POST', body: fd })
    const v = await res.json()
    await prisma.punchRecord.update({
      where: { id: punchId },
      data: {
        faceStatus: v.status,
        faceScore: v.score,
        faceLiveness: v.liveness,
        faceFramePath: v.framePath,
        faceReason: v.reason ?? null,
      },
    })

    // Audit
    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'FACE_VERIFY',
        entity: 'PunchRecord',
        entityId: punchId,
        afterJson: JSON.stringify({ status: v.status, score: v.score, liveness: v.liveness }),
        ipAddress: req.headers.get('x-forwarded-for') || null,
        userAgent: req.headers.get('user-agent') || null,
      },
    })

    return NextResponse.json({ status: v.status })
  } catch {
    try {
      await prisma.punchRecord.update({ where: { id: punchId }, data: { faceStatus: 'SKIPPED', faceReason: 'service_error' } })
    } catch {}
    return NextResponse.json({ status: 'SKIPPED' })
  }
}
