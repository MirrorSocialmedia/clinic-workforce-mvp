export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { CONFIG } from '@/lib/config'
import { jsonNoStore } from '@/lib/api-response'

// GET /api/face/review/[punchId] — Return frame image + audit
// POST /api/face/review/[punchId] — Confirm or flag the punch
// Roles: OWNER, MANAGER

// GET: 返回 frame 圖片（每次載入即 audit）
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const punchId = params.id
  const punch = await prisma.punchRecord.findUnique({ where: { id: punchId } })
  if (!punch || !punch.faceFramePath) {
    return jsonNoStore({ error: 'frame not found' }, { status: 404 })
  }

  // ★ 2026-08-05：對齊 08-03 決定 — 覆核係考勤操作，MANAGER 全公司
  const allowed = await resolveClinicScope(session, [], { companyWide: ['attendance_manage'] })
  if (allowed !== null && !allowed.includes(punch.clinicId)) {
    return jsonNoStore({ error: 'Forbidden' }, { status: 403 })
  }

  // Audit: 記錄誰看了覆核圖
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'FACE_FRAME_VIEW',
      entity: 'PunchRecord',
      entityId: punchId,
      targetEmployeeId: punch.employeeId,
      afterJson: JSON.stringify({ faceScore: punch.faceScore }),
      ipAddress: req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
    },
  })

  const res = await fetch(`${CONFIG.FACE_SERVICE_URL}/frame/${punchId}`, {
    signal: AbortSignal.timeout(CONFIG.FACE_TIMEOUT_MS),
  })
  if (!res.ok) return jsonNoStore({ error: 'frame fetch failed' }, { status: 404 })
  const buffer = await res.arrayBuffer()
  return new Response(buffer, {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store, must-revalidate' },
  })
}

// POST: 處置
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const punchId = params.id
  const body = await req.json().catch(() => ({}))
  const { action } = body // 'confirm' | 'flag'

  const punch = await prisma.punchRecord.findUnique({ where: { id: punchId } })
  if (!punch) return jsonNoStore({ error: 'not found' }, { status: 404 })

  // ★ 2026-08-05：對齊 08-03 決定 — 覆核係考勤操作，MANAGER 全公司
  const allowed = await resolveClinicScope(session, [], { companyWide: ['attendance_manage'] })
  if (allowed !== null && !allowed.includes(punch.clinicId)) {
    return jsonNoStore({ error: 'Forbidden' }, { status: 403 })
  }

  if (action === 'confirm') {
    // 確認本人：刪除 frame，置 null
    await fetch(`${CONFIG.FACE_SERVICE_URL}/frame/${punchId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(CONFIG.FACE_TIMEOUT_MS),
    })
    await prisma.punchRecord.update({
      where: { id: punchId },
      data: { faceReviewedAt: new Date(), faceReviewedBy: session.userId, faceFramePath: null },
    })
  } else if (action === 'flag') {
    // 有疑點：保留 frame 至 30 天期滿，notes 追加標記
    await prisma.punchRecord.update({
      where: { id: punchId },
      data: {
        faceReviewedAt: new Date(),
        faceReviewedBy: session.userId,
        notes: `${punch.notes || ''}\n臉部覆核：有疑點 (${new Date().toISOString()})`.trim(),
      },
    })
  }

  // Audit
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'FACE_REVIEW_ACTION',
      entity: 'PunchRecord',
      entityId: punchId,
      targetEmployeeId: punch.employeeId,
      afterJson: JSON.stringify({ action }),
      ipAddress: req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
    },
  })

  return jsonNoStore({ ok: true })
}
