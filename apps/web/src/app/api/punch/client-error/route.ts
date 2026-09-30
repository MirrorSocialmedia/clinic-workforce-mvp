export const dynamic = 'force-dynamic'
// ★ 2026-09-30 C5：打卡失敗客戶端上報（失敗嗰陣網絡唔通 → 下一次成功先送）
//   之前診斷只能靠一張截圖推理；有呢個之後可以直接查邊部機、咩錯、等咗幾耐、係咪 PWA、網絡類型。
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json().catch(() => null)
  const events = Array.isArray(body?.events) ? body.events.slice(0, 10) : []
  if (events.length === 0) return NextResponse.json({ ok: true })

  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null)
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  const clean = events.map((e: any) => ({
    stage: str(e?.stage, 30),
    errName: str(e?.errName, 60),
    type: str(e?.type, 12),
    elapsedMs: int(e?.elapsedMs),
    at: int(e?.at) != null ? new Date(int(e?.at)!).toISOString() : null,
    online: e?.online === true,
    standalone: e?.standalone === true,
    conn: str(e?.conn, 10),
  }))

  const emp = await prisma.employee.findUnique({ where: { userId: session.userId }, select: { id: true } })
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'PUNCH_CLIENT_ERROR',
      entity: 'PunchAttempt',
      entityId: session.userId,
      targetEmployeeId: emp?.id ?? null,
      afterJson: JSON.stringify(clean),
      ipAddress: req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
    },
  })
  return NextResponse.json({ ok: true })
}
