import { PrismaClient } from '@prisma/client'
import { getAuditContext } from './audit-context'
import { fmtDate } from './hk-date'

// ----------------------------------------------------------
// Singleton Prisma client — shared across all routes
// ----------------------------------------------------------

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const base = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = base
}

// ============================================================
// Prisma Extension — Auto-audit all write operations
// ============================================================

const AUDIT_ENTITIES = new Set([
  'User', 'Clinic', 'Employee', 'PayRule', 'Shift', 'ShiftChangeRequest',
  'PunchCorrection', 'LeaveRequest', 'LeaveType', 'LeaveBalance',
  'ConsultationRevenue', 'PayrollRun', 'PayrollItem', 'DailyHash', 'TimeBank',
  // NOTE: AuditLog is intentionally excluded to prevent infinite recursion
  // NOTE: PunchRecord is excluded — punch route handles audit manually in $transaction
])

// Entities whose audit is written manually inside $transaction.
// Skip auto-audit in the extension for these to avoid double-write.
const MANUAL_TXN_ENTITIES = new Set([
  'ConsultationRevenue',
  'User',
  'PayrollRun',
  'PayrollItem',
])

const WRITE_OPS = new Set([
  'create', 'update', 'delete', 'upsert',
  'createMany', 'updateMany', 'deleteMany',
])

function safeStringify(o: unknown): string | null {
  try { return JSON.stringify(o) } catch { return null }
}

const extended = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const isWrite = WRITE_OPS.has(operation)
        const shouldAudit = isWrite && model && AUDIT_ENTITIES.has(model)

        if (!shouldAudit) {
          return query(args)
        }

        // FIX #1: Skip auto-audit for entities that write audit manually inside $transaction
        if (MANUAL_TXN_ENTITIES.has(model)) {
          return query(args)
        }

        // D2: Capture before/after diff for UPDATE operations
        if (operation === 'update') {
          try {
            const where = (args as any)?.where
            if (where) {
              const before = await (base as any)[model].findUnique({ where })
              const result = await query(args)

              // Compute diff
              const changes: Record<string, { from: unknown; to: unknown }> = {}
              if (before && result) {
                for (const key of Object.keys(before)) {
                  if ((before as any)[key] !== (result as any)[key]) {
                    changes[key] = { from: (before as any)[key], to: (result as any)[key] }
                  }
                }
              }

              // Generate human-readable notes
              const parts: string[] = []
              for (const [key, diff] of Object.entries(changes)) {
                const fromVal = typeof diff.from === 'object' ? JSON.stringify(diff.from) : String(diff.from)
                const toVal = typeof diff.to === 'object' ? JSON.stringify(diff.to) : String(diff.to)
                parts.push(`${key} ${fromVal.slice(0, 30)} → ${toVal.slice(0, 30)}`)
              }

              // FIX 1a: For LeaveRequest, prepend leave type name to notes
              let notes = parts.join('; ')
              if (model === 'LeaveRequest' && result) {
                const lr = result as any
                if (lr.leaveTypeId) {
                  const lt = await base.leaveType.findUnique({ where: { id: lr.leaveTypeId } })
                  notes = `${lt?.name ?? '假期'}：${notes}`
                }
              }

              // Write audit log with diff
              const ctx = getAuditContext()
              if (ctx) {
                await base.auditLog.create({
                  data: {
                    actorId: ctx.actorId,
                    action: operation.toUpperCase(),
                    entity: model,
                    entityId: String((result as any)?.id ?? (where as any)?.id ?? ''),
                    beforeJson: safeStringify(before),
                    afterJson: safeStringify(result),
                    notes,
                    ipAddress: ctx.ip ?? null,
                    userAgent: ctx.ua ?? null,
                  },
                })
              }

              return result
            }
          } catch {
            // If diff capture fails, fall through to standard audit
          }
        }

        const result = await query(args)

        const ctx = getAuditContext()
        if (ctx) {
          let entityId = (result as any)?.id ?? (args as any)?.where?.id ?? 'batch'

          // FIX #4: For batch operations, resolve affected IDs for precise audit
          let notes: string | null = null
          if (['updateMany', 'deleteMany'].includes(operation)) {
            const where = (args as any)?.where
            if (where) {
              try {
                const affected = await (base as any)[model].findMany({
                  where,
                  select: { id: true },
                })
                const ids = affected.map((r: any) => r.id)
                if (ids.length > 0) {
                  notes = `Batch ${operation}: affected IDs = [${ids.join(', ')}]`
                  entityId = ids.join(', ')
                }
              } catch {
                // Fallback: keep entityId='batch'
              }
            }
          }

          // FIX 1a: For LeaveRequest CREATE/DELETE, resolve leave type name + employee name
          if (model === 'LeaveRequest' && ['create', 'delete'].includes(operation)) {
            try {
              let lr: any = null
              if (operation === 'create') {
                lr = result
              } else {
                // For delete, we need to fetch before deletion (but Prisma extension runs after)
                // Use args to reconstruct — but delete already happened. Use the result if available.
                // Actually for delete, result is the deleted record
                lr = result
              }
              if (lr && lr.leaveTypeId) {
                const lt = await base.leaveType.findUnique({ where: { id: lr.leaveTypeId } })
                const emp = await base.employee.findUnique({ where: { id: lr.employeeId }, include: { user: { select: { name: true } } } })
                const dateStr = lr.startDate ? fmtDate(lr.startDate) : ''
                notes = `${lt?.name ?? '假期'}：${emp?.user?.name ?? ''} ${dateStr}`.trim()
              }
            } catch {
              // Fallback: leave notes as-is
            }
          }

          // Use base (raw) client for audit writes to avoid re-triggering the extension
          await base.auditLog.create({
            data: {
              actorId: ctx.actorId,
              action: operation.toUpperCase(),
              entity: model,
              entityId: String(entityId),
              afterJson: safeStringify(result),
              notes,
              ipAddress: ctx.ip ?? null,
              userAgent: ctx.ua ?? null,
            },
          })
        }

        return result
      },
    },
  },
})

// ============================================================
// Exports
// ============================================================

// Extended client — auto-audit enabled (default for all routes)
export const prisma = extended as unknown as PrismaClient
// Raw client — no auto-audit (use inside $transaction or for AuditLog writes)
export const basePrisma = base
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
 * Write an audit log entry using the raw singleton (bypasses extension).
 * Uses the ALS audit context for actorId / ip / ua.
 */
export async function writeAuditLog(data: AuditWrite): Promise<void> {
  const ctx = getAuditContext()
  if (!ctx) return

  await base.auditLog.create({
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
 * Uses the raw singleton (no new PrismaClient).
 * Audit failures now throw instead of being swallowed.
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
    // Audit write failure = transaction rollback
    // No longer silent console.error
    throw new Error(`Audit write failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return result
}

/**
 * Explicit audit log creation (for login/logout etc.)
 * Uses raw singleton — bypasses extension, no new PrismaClient().
 */
export async function createAuditLog(data: {
  action: string
  entity: string
  entityId: string
  notes?: string | null
}): Promise<void> {
  const ctx = getAuditContext()
  if (!ctx) return

  await base.auditLog.create({
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
