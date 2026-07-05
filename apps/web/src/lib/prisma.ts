import { PrismaClient } from '@prisma/client'
import { getAuditActorId } from './audit-context'

// Basic singleton Prisma client — no middleware
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const rawPrisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = rawPrisma
}

export const prisma = globalForPrisma.prisma
export default prisma

// ============================================================
// Audit log helper — wraps mutations with automatic audit logging
// ============================================================

const AUDIT_SKIP_ENTITIES = new Set(['AuditLog'])

interface AuditWrite {
  action: string
  entity: string
  entityId: string
  beforeJson?: string | null
  afterJson?: string | null
}

async function writeAuditLog(data: AuditWrite): Promise<void> {
  const actorId = getAuditActorId()
  if (!actorId) return

  // Use a fresh client to avoid recursion
  const freshClient = new PrismaClient()
  try {
    await freshClient.auditLog.create({
      data: {
        actorId,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId,
        beforeJson: data.beforeJson ?? null,
        afterJson: data.afterJson ?? null,
        ipAddress: (globalThis as any).__auditIp || null,
        userAgent: (globalThis as any).__auditUa || null,
      },
    })
  } catch (err) {
    console.error('⚠️ Failed to write audit log:', err)
  } finally {
    await freshClient.$disconnect()
  }
}

/**
 * Wrap a Prisma mutation with automatic audit logging.
 * Usage: await withAudit(prisma.clinic.create({ data: {...} }))
 */
export async function withAudit<T>(
  mutation: Promise<T>,
  entity: string,
  getEntityId: (result: T) => string = (r: any) => r?.id || ''
): Promise<T> {
  const actorId = getAuditActorId()
  if (!actorId || AUDIT_SKIP_ENTITIES.has(entity)) {
    return mutation
  }

  const result = await mutation
  const entityId = getEntityId(result)

  await writeAuditLog({
    action: 'MUTATE',
    entity,
    entityId,
    afterJson: JSON.stringify(result),
  })

  return result
}

/**
 * Explicit audit log creation (for login/logout etc.)
 */
export async function createAuditLog(data: {
  action: string
  entity: string
  entityId: string
  notes?: string | null
}): Promise<void> {
  const actorId = getAuditActorId()
  if (!actorId) return

  const freshClient = new PrismaClient()
  try {
    await freshClient.auditLog.create({
      data: {
        actorId,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId,
        notes: data.notes || null,
        ipAddress: (globalThis as any).__auditIp || null,
        userAgent: (globalThis as any).__auditUa || null,
      },
    })
  } catch (err) {
    console.error('⚠️ Failed to write audit log:', err)
  } finally {
    await freshClient.$disconnect()
  }
}
