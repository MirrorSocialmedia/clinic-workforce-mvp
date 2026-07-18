import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/time-bank/[id] — Single time bank record
// ============================================================
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const record = await prisma.timeBank.findUnique({
    where: { id: params.id },
    include: {
      employee: {
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
  })

  if (!record) {
    return NextResponse.json({ error: 'Time bank record not found' }, { status: 404 })
  }

  return NextResponse.json({ timeBank: record })
}

// ============================================================
// PATCH /api/time-bank/[id] — Manual adjustment
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PATCH', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()

      const existing = await prisma.timeBank.findUnique({ where: { id: params.id } })
      if (!existing) {
        return NextResponse.json({ error: 'Time bank record not found' }, { status: 404 })
      }

      const updateData: any = {}
      if (body.otMinutes !== undefined) updateData.otMinutes = body.otMinutes
      if (body.lateMinutes !== undefined) updateData.lateMinutes = body.lateMinutes
      if (body.balance !== undefined) updateData.balance = body.balance
      if (body.carriedFrom !== undefined) updateData.carriedFrom = body.carriedFrom
      if (body.monthEndNote !== undefined) updateData.monthEndNote = body.monthEndNote

      const updated = await prisma.timeBank.update({
        where: { id: params.id },
        data: updateData,
      })

      return NextResponse.json({ success: true, timeBank: updated })
    } catch (error) {
      console.error('Time bank update error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

// ============================================================
// DELETE /api/time-bank/[id] — Delete time bank record
// Roles: OWNER, MANAGER
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const existing = await prisma.timeBank.findUnique({ where: { id: params.id } })
      if (!existing) {
        return NextResponse.json({ error: 'Time bank record not found' }, { status: 404 })
      }

      await prisma.timeBank.delete({ where: { id: params.id } })

      return NextResponse.json({ success: true })
    } catch (error) {
      console.error('Time bank delete error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
