export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { SENSITIVE_AUDIT_SPEC } from '@/lib/sensitive-audit'

// GET /api/audit-logs/sensitive-summary?days=7
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const url = new URL(req.url)
  const days = parseInt(url.searchParams.get('days') || '7')
  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Build OR conditions from spec
  const conditions: any[] = SENSITIVE_AUDIT_SPEC.map(spec => ({
    action: spec.action,
    ...(spec.entity ? { entity: spec.entity } : {}),
  }))

  const logs = await prisma.auditLog.findMany({
    where: {
      OR: conditions,
      createdAt: { gte: fromDate },
    },
    include: {
      actor: { select: { name: true, role: true } },
      targetEmployee: {
        select: {
          id: true,
          user: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Build label map
  const labelMap = new Map<string, string>()
  for (const spec of SENSITIVE_AUDIT_SPEC) {
    const key = spec.entity ? `${spec.action}::${spec.entity}` : spec.action
    labelMap.set(key, spec.label)
  }

  // Normalize action names
  const normalize = (log: any) => {
    const key = log.entity ? `${log.action}::${log.entity}` : log.action
    return labelMap.get(key) || log.action
  }

  // Group by actor
  const byActor = new Map<string, { name: string; role: string; count: number; byAction: Record<string, number>; logs: any[] }>()
  for (const log of logs) {
    const actorName = log.actor?.name || 'Unknown'
    const actorRole = log.actor?.role || ''
    const label = normalize(log)
    const actorId = log.actorId || '__system__'
    const existing = byActor.get(actorId)
    if (!existing) {
      byActor.set(actorId, { name: actorName, role: actorRole, count: 1, byAction: { [label]: 1 }, logs: [{ ...log, label }] })
    } else {
      existing.count++
      existing.byAction[label] = (existing.byAction[label] || 0) + 1
      existing.logs.push({ ...log, label })
    }
  }

  const actors = Array.from(byActor.values()).sort((a, b) => b.count - a.count)

  return NextResponse.json(actors, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}
