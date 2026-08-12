import { PrismaClient } from '@prisma/client'

// ★ 唔經 lib/prisma.ts —— 避開 audit extension 造成遞迴
// 但要 singleton，唔可以每次 new（會打爆 connection pool）
const g = globalThis as any
const rawClient: PrismaClient = g.__notificationPrisma ?? new PrismaClient()
if (process.env.NODE_ENV !== 'production') g.__notificationPrisma = rawClient

export async function createNotification(data: {
  employeeId: string; type: string; content: string;
  relatedEntity?: string | null; relatedId?: string | null; details?: string | null;
}): Promise<void> {
  try {
    await rawClient.notification.create({ data: { ...data } })
  } catch (err) {
    console.error('⚠️ Failed to create notification:', err)
  }
}

// ★ 批次版：一條 SQL 插晒
export async function createNotifications(rows: Array<{
  employeeId: string; type: string; content: string;
  relatedEntity?: string | null; relatedId?: string | null; details?: string | null;
}>): Promise<void> {
  if (rows.length === 0) return
  try {
    await rawClient.notification.createMany({
      data: rows.map(r => ({
        employeeId: r.employeeId, type: r.type, content: r.content,
        relatedEntity: r.relatedEntity ?? null, relatedId: r.relatedId ?? null,
        details: r.details ?? null,
      })),
    })
  } catch (err) {
    console.error('⚠️ Failed to create notifications (batch):', err)
  }
}

/**
 * Get unread notification count for an employee
 */
export async function getUnreadCount(employeeId: string): Promise<number> {
  try {
    return await rawClient.notification.count({
      where: { employeeId, isRead: false },
    })
  } catch {
    return 0
  }
}
