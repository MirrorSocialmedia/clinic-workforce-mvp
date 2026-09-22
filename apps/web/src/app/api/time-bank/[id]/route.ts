// ownership-ok: RBAC matrix 控制
import { NextRequest, NextResponse } from 'next/server'
import { prisma, writeAuditLog, slimForAudit } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/time-bank/[id] — Single time bank record
// ============================================================
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const record = await prisma.timeBank.findUnique({
    where: { id: params.id },
    include: {
      employee: {
        select: {
          homeClinicId: true,
          user: { select: { id: true, name: true } },
        },
      },
    },
  })

  if (!record) {
    return NextResponse.json({ error: 'Time bank record not found' }, { status: 404 })
  }

  // ★ IDOR: MANAGER 只可以睇自己店員工嘅 timebank
  const denied = assertClinicAccess(scope, session, record.employee?.homeClinicId)
  if (denied) return denied

  return jsonNoStore({ timeBank: record })
}

// ============================================================
// PATCH /api/time-bank/[id] — Manual adjustment
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PATCH', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()

      const existing = await prisma.timeBank.findUnique({ where: { id: params.id }, include: { employee: true } })
      if (!existing) {
        return NextResponse.json({ error: 'Time bank record not found' }, { status: 404 })
      }

      // ★ IDOR: MANAGER 只可以改自己店員工嘅 timebank
      const denied = assertClinicAccess(scope, session, existing.employee?.homeClinicId)
      if (denied) return denied

      const updateData: any = {}
      if (body.otMinutes !== undefined) updateData.otMinutes = body.otMinutes
      if (body.lateMinutes !== undefined) updateData.lateMinutes = body.lateMinutes
      if (body.balance !== undefined) updateData.balance = body.balance
      if (body.carriedFrom !== undefined) updateData.carriedFrom = body.carriedFrom
      if (body.monthEndNote !== undefined) updateData.monthEndNote = body.monthEndNote

      const updated = await prisma.timeBank.update({
        where: { id: params.id },
        data: updateData,
      })

      // ★ cwm-consist S6 CA-09a：TimeBank 已移出 AUDIT_ENTITIES（cache 讀寫唔入審計）——
      //   人手改呢條路自己寫 audit（欄位口徑同舊 auto-audit 一致）
      const diffParts: string[] = []
      for (const key of Object.keys(existing)) {
        if (key === 'employee' || key === 'updatedAt') continue
        const a = (existing as any)[key], b = (updated as any)[key]
        // ★ A-8：Date 要比數值（!== 比 reference → periodMonth／createdAt 永遠當改咗）
        const same = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b
        if (!same) {
          const f = (existing as any)[key], t = (updated as any)[key]
          diffParts.push(`${key} ${String(typeof f === 'object' ? JSON.stringify(f) : f).slice(0, 30)} → ${String(typeof t === 'object' ? JSON.stringify(t) : t).slice(0, 30)}`)
        }
      }
      // ★ A-8：資料已 commit —— audit 寫失敗唔好變 500（用戶會以為冇改到再改多次），留 log
      await writeAuditLog({
        action: 'UPDATE',
        entity: 'TimeBank',
        entityId: params.id,
        beforeJson: JSON.stringify(slimForAudit(existing)),
        afterJson: JSON.stringify(slimForAudit(updated)),
        notes: diffParts.join('; ') || null,
      }).catch(e => console.error('[time-bank/[id]] audit write failed (UPDATE)', params.id, e))

      return NextResponse.json({ success: true, timeBank: updated })
    } catch (error) {
      console.error('Time bank update error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

// ============================================================
// DELETE /api/time-bank/[id] — Delete time bank record
// Roles: OWNER, MANAGER
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const existing = await prisma.timeBank.findUnique({ where: { id: params.id }, include: { employee: true } })
      if (!existing) {
        return NextResponse.json({ error: 'Time bank record not found' }, { status: 404 })
      }

      // ★ IDOR: MANAGER 只可以刪自己店員工嘅 timebank
      const denied = assertClinicAccess(scope, session, existing.employee?.homeClinicId)
      if (denied) return denied

      await prisma.timeBank.delete({ where: { id: params.id } })

      // ★ cwm-consist S6 CA-09a：TimeBank 已移出 AUDIT_ENTITIES —— 人手刪呢條路自己寫 audit
      await writeAuditLog({
        action: 'DELETE',
        entity: 'TimeBank',
        entityId: params.id,
        beforeJson: JSON.stringify(slimForAudit(existing)),
        afterJson: null,
        notes: null,
      }).catch(e => console.error('[time-bank/[id]] audit write failed (DELETE)', params.id, e))   // ★ A-8

      return NextResponse.json({ success: true })
    } catch (error) {
      console.error('Time bank delete error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
