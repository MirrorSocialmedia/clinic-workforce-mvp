// Audit logging context (set by API routes before Prisma mutations)
let currentActorId: string | null = null

export function setAuditContext(actorId: string, ipAddress?: string, userAgent?: string) {
  currentActorId = actorId
  ;(globalThis as any).__auditIp = ipAddress || null
  ;(globalThis as any).__auditUa = userAgent || null
}

export function clearAuditContext() {
  currentActorId = null
  delete (globalThis as any).__auditIp
  delete (globalThis as any).__auditUa
}

export function getAuditActorId(): string | null {
  return currentActorId
}
