import { NextRequest } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// PATCH /api/cost-cases/:id/status — 成本個案「已完成」綠剔（2026-09-02 cwm-costnote）
// Roles: OWNER, MANAGER (cost_entry via perm override)
// Body: { status: 'DONE' | 'PRICED' | 'PENDING' }
//
// ★ 拍板③：已鎖定（lockedByRunId）【可以】標完成 — DONE 純狀態標記，
//   payout/engine.ts 只 filter VOID（:219 :233 :395），唔睇 DONE → 金額零影響。
//   ⚠️ 所以呢條 route 特登【唔加】lockedByRunId 守衛（同 PUT [id]/route.ts:29 唔同）。
// ★ VOID 個案唔可以改狀態（400）。
// ★ 取消完成由前端決定回復值：有 finalCost → PRICED，冇 → PENDING（MD §4.2）。
// ============================================================
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePerm(req, 'cost_entry')
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { id } = await params

  const existing = await prisma.costCase.findUnique({
    where: { id },
    select: { id: true, status: true, lockedByRunId: true, finalCost: true, clinicId: true },
  })
  if (!existing) return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })

  const body = await req.json()
  const { status } = body
  // ★ 只准 DONE ⇄ PRICED/PENDING — 唔可以經呢條 route 作廢或者改重做
  if (!['DONE', 'PRICED', 'PENDING'].includes(status)) {
    return jsonNoStore({ error: 'status 只准 DONE / PRICED / PENDING' }, { status: 400 })
  }
  if (existing.status === 'VOID') {
    return jsonNoStore({ error: '已作廢個案唔可以改狀態' }, { status: 400 })
  }

  const updated = await prisma.costCase.update({
    where: { id },
    data: { status },
    select: { id: true, status: true },
  })

  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_STATUS',
      entity: 'CostCase',
      entityId: id,
      clinicId: existing.clinicId,
      notes: `成本個案狀態 ${existing.status} → ${status}${existing.lockedByRunId ? '（已鎖定）' : ''}`,
    },
  } as any)

  return jsonNoStore({ ok: true, ...updated })
}
