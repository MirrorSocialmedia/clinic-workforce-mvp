export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { CONFIG } from '@/lib/config'

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

  // ★ 決定 10：上傳限制
  const MAX_FRAME_BYTES = 2 * 1024 * 1024
  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp']
  for (const f of frames) {
    if (f.size > MAX_FRAME_BYTES) {
      return NextResponse.json({ error: 'frame too large' }, { status: 413 })
    }
    if (!ALLOWED_MIME.includes(f.type)) {
      return NextResponse.json({ error: 'unsupported frame type' }, { status: 415 })
    }
  }

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

  let data: any
  try {
    const res = await fetch(`${CONFIG.FACE_SERVICE_URL}/embed`, {
      method: 'POST',
      body: fd,
      // ★ 用 EMBED 專用 timeout，唔好用打卡嗰個 5 秒
      signal: AbortSignal.timeout(CONFIG.FACE_EMBED_TIMEOUT_MS),
    })
    data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok) {
      await prisma.faceTemplate.delete({ where: { id: template.id } })
      return NextResponse.json(
        { error: data?.error || `特徵提取失敗（${res.status}）` },
        { status: 422 },
      )
    }
  } catch (e: any) {
    // ★ 超時 / 連線失敗一樣要清走佔位 template，
    //   否則會變成「老闆見到申請但冇參考照」嘅孤兒記錄。
    await prisma.faceTemplate.delete({ where: { id: template.id } }).catch(() => {})
    const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return NextResponse.json(
      {
        error: isTimeout
          ? '人臉分析超時，請喺光線充足嘅地方、面向鏡頭再試一次'
          : '人臉服務暫時無法連線，請稍後再試',
        reason: isTimeout ? 'FACE_TIMEOUT' : 'FACE_UNAVAILABLE',
      },
      { status: isTimeout ? 504 : 503 },
    )
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
      targetEmployeeId: employee.id,
      notes: `Face enrollment completed via code ${code}`,
      ipAddress: req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
    },
  })

  return NextResponse.json({ ok: true })
}
