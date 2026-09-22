import { PrismaClient } from '@prisma/client'
import { getAuditContext, runWithAudit } from './audit-context'
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
  'ConsultationRevenue', 'PayrollRun', 'PayrollItem', 'DailyHash',
  'ExpenseEntry',
  // NOTE: AuditLog is intentionally excluded to prevent infinite recursion
  // NOTE: PunchRecord is excluded — punch route handles audit manually in $transaction
  // NOTE: TimeBank is excluded — cwm-consist S6 CA-09a：TimeBank 係 cache（payroll-engine 重算寫入），
  //   cache 讀寫唔應該入審計；人手改嘅路（time-bank/[id] route）自己寫 audit
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

/** 審計日誌只保留關鍵欄位，過濾 ID 雜訊 */
const AUDIT_FIELD_WHITELIST = new Set([
  'name', 'amount', 'description', 'periodMonth', 'status', 'role', 'payType',
  'date', 'startTime', 'endTime', 'punchType', 'punchTime', 'minutes', 'days',
  'entitled', 'remaining', 'used', 'year', 'reason', 'totalPayable',
  'leaveTypes', 'count', 'target', 'balance', 'otMinutes', 'lateMinutes',
  // ★ cwm-attexempt-20260914 F：免考勤開關入 audit（beforeJson/afterJson 帶到新欄）
  'attendanceExempt',
  'earlyLeaveMinutes', 'makeupMinutes', 'carriedFrom', 'monthEndNote',
  'initMinutes', 'balanceMinutes', 'otBalanceMinutes', 'delta',
  'startDate', 'endDate', 'voidReason', 'voidNote', 'punchNote',
  'shiftDate', 'shiftStart', 'shiftEnd', 'note',
])

export function slimForAudit(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  const out: any = {}
  for (const [k, v] of Object.entries(obj)) {
    if (AUDIT_FIELD_WHITELIST.has(k) && v != null) out[k] = v
  }
  return out
}

// ============================================================
// ★ cwm-consistency Stage 2.1：audit 同主操作「同生同死」
//   ① 主操作 query(args) 永遠只執行一次（舊版 audit 失敗會 fall-through 再跑一次 → increment 雙扣）
//   ② 喺 interactive tx 入面 → audit 用同一個 tx client 寫（rollback 就一齊冇；唔再借第二條 connection）
//   ③ autocommit（冇 tx）→ 主操作已 commit，audit 失敗只 log，唔可以回 500 呃 UI 話「失敗」
//   ④ updateMany / deleteMany 嘅受影響 ID 喺主操作【之前】解析（tx 內 delete 咗就搵唔返）
// ============================================================
const extended = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const isWrite = WRITE_OPS.has(operation)
        if (!isWrite || !model || !AUDIT_ENTITIES.has(model) || MANUAL_TXN_ENTITIES.has(model)) {
          return query(args)
        }

        const ctx = getAuditContext()
        if (!ctx) return query(args)

        const txDb: any = (ctx as any).tx ?? null
        const db: any = txDb ?? base
        const where = (args as any)?.where

        // ── 主操作之前：before 快照 / 受影響 ID（best effort，唔影響主操作）
        let before: any = null
        let batchIds: string[] | null = null
        try {
          if (operation === 'update' && where) {
            before = await db[model].findUnique({ where })
          } else if ((operation === 'updateMany' || operation === 'deleteMany') && where) {
            batchIds = (await db[model].findMany({ where, select: { id: true } })).map((r: any) => r.id)
          }
        } catch { /* 快照失敗唔阻主操作 */ }

        // ── 主操作：只跑一次
        const result = await query(args)

        // ── audit
        try {
          let notes: string | null = null
          let entityId = String((result as any)?.id ?? where?.id ?? 'batch')
          if (operation === 'update' && before && result) {
            const parts: string[] = []
            for (const key of Object.keys(before)) {
              if ((before as any)[key] !== (result as any)[key]) {
                const f = (before as any)[key], t = (result as any)[key]
                parts.push(`${key} ${String(typeof f === 'object' ? JSON.stringify(f) : f).slice(0, 30)} → ${String(typeof t === 'object' ? JSON.stringify(t) : t).slice(0, 30)}`)
              }
            }
            notes = parts.join('; ')
          }
          if (batchIds && batchIds.length > 0) {
            notes = `Batch ${operation}: affected IDs = [${batchIds.join(', ')}]`
            entityId = batchIds.join(', ')
          }
          if (model === 'LeaveRequest' && result && (result as any).leaveTypeId) {
            const lr = result as any
            const lt = await db.leaveType.findUnique({ where: { id: lr.leaveTypeId } })
            if (operation === 'update') {
              notes = `${lt?.name ?? '假期'}：${notes ?? ''}`
            } else if (operation === 'create' || operation === 'delete') {
              const emp = await db.employee.findUnique({ where: { id: lr.employeeId }, include: { user: { select: { name: true } } } })
              notes = `${lt?.name ?? '假期'}：${emp?.user?.name ?? ''} ${lr.startDate ? fmtDate(lr.startDate) : ''}`.trim()
            }
          }
          await db.auditLog.create({
            data: {
              actorId: ctx.actorId,
              action: operation.toUpperCase(),
              entity: model,
              entityId,
              beforeJson: before ? safeStringify(slimForAudit(before)) : null,
              afterJson: safeStringify(slimForAudit(result)),
              notes,
              ipAddress: ctx.ip ?? null,
              userAgent: ctx.ua ?? null,
            },
          })
        } catch (e) {
          if (txDb) throw e   // tx 內：audit 失敗 → 成個 tx rollback（冇 audit 就冇操作）
          console.error(`[audit] write failed AFTER autocommit ${model}.${operation} — data committed, audit missing`, e)
        }
        return result
      },
    },
  },
})

// ★ Stage 2.1：interactive $transaction 自動將 tx client 放入 ALS → extension 用佢寫 audit
//   陣列式 $transaction([...]) 維持原樣（見 2.2）
const txAware = new Proxy(extended as any, {
  get(target, prop, receiver) {
    if (prop === '$transaction') {
      return (arg: any, opts?: any) => {
        if (typeof arg !== 'function') return target.$transaction(arg, opts)
        return target.$transaction((tx: any) => {
          const ctx = getAuditContext()
          return ctx ? runWithAudit({ ...ctx, tx } as any, () => arg(tx)) : arg(tx)
        }, opts)
      }
    }
    return Reflect.get(target, prop, receiver)
  },
})

// ============================================================
// Exports
// ============================================================

// Extended client — auto-audit enabled (default for all routes)
export const prisma = txAware as unknown as PrismaClient
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
      afterJson: JSON.stringify(slimForAudit(result)),
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
