export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// PUT /api/notifications/[id]/read — Mark notification as read
// All roles
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const notification = await prisma.notification.findUnique({
    where: { id: params.id },
  })

  if (!notification) return NextResponse.json({ error: 'Notification not found' }, { status: 404 })

  if (notification.employeeId !== employee.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.notification.update({
    where: { id: params.id },
    data: { isRead: true },
  })

  return NextResponse.json({ success: true })
}
