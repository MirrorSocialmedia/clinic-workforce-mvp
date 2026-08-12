export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/notifications — List notifications
// All roles — employees see only own; managers see all
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  // ★ 冇 Employee 記錄（純 admin 帳號）唔係錯誤 —— 回空清單
  if (!employee) return NextResponse.json({ notifications: [], unreadCount: 0 })

  const where: any = { employeeId: employee.id }

  const notifications = await prisma.notification.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], // ★ unique tiebreaker for stable pagination
    take: 100,
  })

  const unreadCount = await prisma.notification.count({
    where: { employeeId: employee.id, isRead: false },
  })

  return NextResponse.json({ notifications, unreadCount })
}
