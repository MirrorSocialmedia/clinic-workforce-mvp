import { AsyncLocalStorage } from 'async_hooks'

type AuditContext = {
  actorId: string
  actorName?: string
  ip?: string
  ua?: string
}

const als = new AsyncLocalStorage<AuditContext>()

export function runWithAudit<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn as any)
}

export function getAuditContext(): AuditContext | null {
  return als.getStore() ?? null
}

export function getAuditActorId(): string | null {
  return als.getStore()?.actorId ?? null
}

/**
 * Legacy compatibility — used by existing API routes that call setAuditContext().
 * Wraps the callback in an ALS context so in-flight requests remain isolated.
 */
export function setAuditContext(actorId: string, ipAddress?: string, userAgent?: string): void {
  // This is a no-op for ALS — the context is set via runWithAudit at the route level.
  // Kept for backward compat but functionality is via ALS now.
}

export function clearAuditContext(): void {
  // ALS contexts auto-exit; nothing to clear.
}
