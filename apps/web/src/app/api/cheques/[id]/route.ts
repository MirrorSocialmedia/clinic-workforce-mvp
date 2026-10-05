// ============================================================
// ★ cwm-chequeprint-20261005：PATCH /api/cheques/:id — 確認／作廢／退號（只限老闆）
//   confirm：老闆睇過「印得好」
//   void   ：印壞或者唔用（要原因）；號碼唔會再用；計糧嘅支票號清返
//   release：送唔到打印機（實物支票冇用過）→ 刪記錄、退返號碼；只限最新一張、未確認、15 分鐘內
// ownership-ok: 支票紀錄全公司共用；RBAC 只准 OWNER（config.ts，冇 perm override）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { formatNo } from '@/lib/cheque-print/server'

const RELEASE_WINDOW_MS = 15 * 60 * 1000

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'PATCH', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-id', async () => {
    const b = await req.json().catch(() => ({} as any))
    const action = b?.action
    const c = await prisma.cheque.findUnique({ where: { id: params.id } })
    if (!c) return jsonNoStore({ error: '搵唔到呢張支票' }, { status: 404 })
    if (c.status === 'VOID') return jsonNoStore({ error: '呢張已經作廢' }, { status: 409 })

    // 計糧嘅支票號：仲係呢張先清（老闆可能人手改過）
    const clearPayrollNo = async (tx: any) => {
      if (c.sourceType !== 'PAYROLL_ITEM') return
      await tx.payrollItem.updateMany({ where: { id: c.sourceId, chequeNo: c.chequeNo }, data: { chequeNo: null } })
    }

    if (action === 'confirm') {
      await prisma.cheque.update({ where: { id: c.id }, data: { confirmedAt: new Date() } })
      await prisma.auditLog.create({
        data: { actorId: session.userId, action: 'CHEQUE_CONFIRM', entity: 'Cheque', entityId: c.id, clinicId: c.clinicId, notes: `#${c.chequeNo} 印得好` },
      })
      return jsonNoStore({ ok: true })
    }

    if (action === 'void') {
      const reason = typeof b?.reason === 'string' ? b.reason.trim().slice(0, 200) : ''
      if (!reason) return jsonNoStore({ error: '請寫作廢原因' }, { status: 400 })
      await prisma.$transaction(async tx => {
        await tx.cheque.update({ where: { id: c.id }, data: { status: 'VOID', voidReason: reason, voidedAt: new Date() } })
        await clearPayrollNo(tx)
        await tx.auditLog.create({
          data: {
            actorId: session.userId, action: 'CHEQUE_VOID', entity: 'Cheque', entityId: c.id, clinicId: c.clinicId,
            notes: `#${c.chequeNo} 作廢：${reason}`,
          },
        })
      })
      return jsonNoStore({ ok: true })
    }

    if (action === 'release') {
      if (c.confirmedAt) return jsonNoStore({ error: '已確認嘅票唔可以退號，請用作廢' }, { status: 409 })
      if (Date.now() - c.createdAt.getTime() > RELEASE_WINDOW_MS) return jsonNoStore({ error: '超過 15 分鐘，請用作廢' }, { status: 409 })
      const ok = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "ChequeAccount" WHERE id = ${c.accountId} FOR UPDATE`
        const acc = await tx.chequeAccount.findUnique({ where: { id: c.accountId } })
        if (!acc || acc.nextNo == null || formatNo(acc.nextNo - 1, acc.noWidth) !== c.chequeNo) return false
        await tx.cheque.delete({ where: { id: c.id } })
        await tx.chequeAccount.update({ where: { id: acc.id }, data: { nextNo: acc.nextNo - 1 } })
        await clearPayrollNo(tx)
        await tx.auditLog.create({
          data: {
            actorId: session.userId, action: 'CHEQUE_RELEASE', entity: 'Cheque', entityId: c.id, clinicId: c.clinicId,
            notes: `#${c.chequeNo} 送唔到打印機，退返號碼`,
          },
        })
        return true
      })
      if (!ok) return jsonNoStore({ error: '之後已經出咗其他票，呢張請用作廢' }, { status: 409 })
      return jsonNoStore({ ok: true })
    }

    return jsonNoStore({ error: 'action 唔啱' }, { status: 400 })
  })
}
