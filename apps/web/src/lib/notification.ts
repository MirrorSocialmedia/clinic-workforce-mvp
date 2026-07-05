import { prisma } from './prisma'

/**
 * Create a notification for an employee (uses a fresh client to avoid recursion)
 */
export async function createNotification(data: {
  employeeId: string
  type: string
  content: string
  relatedEntity?: string | null
  relatedId?: string | null
}): Promise<void> {
  try {
    const freshClient = new (require('@prisma/client').PrismaClient)()
    await freshClient.notification.create({
      data: {
        employeeId: data.employeeId,
        type: data.type,
        content: data.content,
        relatedEntity: data.relatedEntity ?? null,
        relatedId: data.relatedId ?? null,
      },
    })
    await freshClient.$disconnect()
  } catch (err) {
    console.error('⚠️ Failed to create notification:', err)
  }
}

/**
 * Get unread notification count for an employee
 */
export async function getUnreadCount(employeeId: string): Promise<number> {
  try {
    return await prisma.notification.count({
      where: {
        employeeId,
        isRead: false,
      },
    })
  } catch {
    return 0
  }
}
