export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// PUT /api/notifications/[id]/read — Mark notification as read
// All roles
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const notification = await prisma.notification.findUnique({
    where: { id: params.id },
  })

  if (!notification) return NextResponse.json({ error: 'Notification not found' }, { status: 404 })

  // Only the owner can read
  if (notification.employeeId !== employee.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.notification.update({
    where: { id: params.id },
    data: { isRead: true },
  })

  return NextResponse.json({ success: true })
}
