import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/notifications — List notifications
// All roles — employees see only own; managers see all
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  // Employees see only their own notifications
  const where: any = { employeeId: employee.id }

  const notifications = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  // Unread count
  const unreadCount = await prisma.notification.count({
    where: { employeeId: employee.id, isRead: false },
  })

  return NextResponse.json({ notifications, unreadCount })
}
