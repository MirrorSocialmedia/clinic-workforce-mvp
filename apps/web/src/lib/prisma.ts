import { PrismaClient } from '@prisma/client'
import { getAuditContext } from './audit-context'

// ----------------------------------------------------------
// Singleton Prisma client — shared across all routes
// ----------------------------------------------------------

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const rawPrisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = rawPrisma
}

export const prisma = globalForPrisma.prisma ?? rawPrisma
export default prisma

// ============================================================
// Audit log helpers — uses shared prisma singleton + ALS context
// ============================================================

const AUDIT_SKIP_ENTITIES = new Set(['AuditLog'])

interface AuditWrite {
  action: string
  entity: string
  entityId: string
  beforeJson?: string | null
  afterJson?: string | null
  notes?: string | null
}

/**
 * Write an audit log entry using the shared singleton.
 * Uses the ALS audit context for actorId / ip / ua.
 */
export async function writeAuditLog(data: AuditWrite): Promise<void> {
  const ctx = getAuditContext()
  if (!ctx) return

  await prisma.auditLog.create({
    data: {
      actorId: ctx.actorId,
      action: data.action,
      entity: data.entity,
      entityId: data.entityId,
      beforeJson: data.beforeJson ?? null,
      afterJson: data.afterJson ?? null,
      notes: data.notes ?? null,
      ipAddress: ctx.ip || null,
      userAgent: ctx.ua || null,
    },
  })
}

/**
 * Wrap a Prisma mutation with automatic audit logging.
 * Uses the shared singleton (no new PrismaClient).
 * Usage: await withAudit(prisma.clinic.create({ data: {...} }))
 */
export async function withAudit<T>(
  mutation: Promise<T>,
  entity: string,
  getEntityId: (result: T) => string = (r: any) => r?.id || ''
): Promise<T> {
  const ctx = getAuditContext()
  if (!ctx || AUDIT_SKIP_ENTITIES.has(entity)) {
    return mutation
  }

  const result = await mutation
  const entityId = getEntityId(result)

  try {
    await writeAuditLog({
      action: 'MUTATE',
      entity,
      entityId,
      afterJson: JSON.stringify(result),
    })
  } catch (err) {
    // Audit write failure is non-fatal for the mutation itself,
    // but if called within a transaction, the rollback will propagate.
    console.error('⚠️ Failed to write audit log:', err)
  }

  return result
}

/**
 * Explicit audit log creation (for login/logout etc.)
 * Uses shared singleton — no new PrismaClient().
 */
export async function createAuditLog(data: {
  action: string
  entity: string
  entityId: string
  notes?: string | null
}): Promise<void> {
  const ctx = getAuditContext()
  if (!ctx) return

  await prisma.auditLog.create({
    data: {
      actorId: ctx.actorId,
      action: data.action,
      entity: data.entity,
      entityId: data.entityId,
      notes: data.notes || null,
      ipAddress: ctx.ip || null,
      userAgent: ctx.ua || null,
    },
  })
}
