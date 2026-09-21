import { basePrisma } from './prisma'

// ★ Stage 2.3：共用 prisma 嘅 base client（同一 connection pool，唔再各自 new PrismaClient）
//   仍係 raw client（無 audit extension）—— 通知唔係審計實體，唔會遞迴
const rawClient = basePrisma

export async function createNotification(data: {
  employeeId: string; type: string; content: string;
  relatedEntity?: string | null; relatedId?: string | null; details?: string | null;
}, db?: { notification: { create: (a: any) => Promise<unknown> } }): Promise<void> {
  if (db) { await db.notification.create({ data: { ...data } }); return }
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
