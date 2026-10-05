// ============================================================
// ★ cwm-chequeprint-20261005：PUT /api/cheques/lab-amounts — Lab 月結金額（人手跟月結單入；隨時改）
//   body { labId, clinicId, month, amount|null, statementRef?, note? }；amount null = 刪除
//   已出票（未作廢）就唔准改 —— 要先作廢張票
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { isMonth } from '@/lib/cheque-print/server'

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-lab-amounts', async () => {
    const b = await req.json().catch(() => ({} as any))
    const { labId, clinicId, month } = b ?? {}
    if (typeof labId !== 'string' || typeof clinicId !== 'string' || !isMonth(month)) {
      return jsonNoStore({ error: '參數唔啱' }, { status: 400 })
    }
    const [lab, clinic] = await Promise.all([
      prisma.lab.findUnique({ where: { id: labId }, select: { name: true } }),
      prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true } }),
    ])
    if (!lab || !clinic) return jsonNoStore({ error: '搵唔到 Lab 或者診所' }, { status: 404 })

    const before = await prisma.labChequeAmount.findUnique({ where: { labId_clinicId_periodMonth: { labId, clinicId, periodMonth: month } } })
    if (before) {
      const issued = await prisma.cheque.findFirst({ where: { sourceType: 'LAB_AMOUNT', sourceId: before.id, status: { not: 'VOID' } }, select: { chequeNo: true } })
      if (issued) return jsonNoStore({ error: `已經出咗票 #${issued.chequeNo}，要改金額請先作廢張票` }, { status: 409 })
    }

    const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
    let after: any = null
    if (b.amount === null || b.amount === '') {
      if (before) await prisma.labChequeAmount.delete({ where: { id: before.id } })
    } else {
      const amount = Math.round(Number(b.amount) * 100) / 100
      if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e9) return jsonNoStore({ error: '金額要大過 0' }, { status: 400 })
      const data = { amount, statementRef: text(b.statementRef, 40), note: text(b.note, 200), updatedBy: session.userId }
      after = await prisma.labChequeAmount.upsert({
        where: { labId_clinicId_periodMonth: { labId, clinicId, periodMonth: month } },
        create: { labId, clinicId, periodMonth: month, ...data },
        update: data,
      })
    }
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'LAB_CHEQUE_AMOUNT_UPDATE', entity: 'LabChequeAmount', entityId: after?.id ?? before?.id ?? `${labId}|${clinicId}|${month}`,
        clinicId, notes: `${lab.name} · ${clinic.name} · ${month}`,
        beforeJson: before ? JSON.stringify({ amount: String(before.amount), statementRef: before.statementRef, note: before.note }) : null,
        afterJson: after ? JSON.stringify({ amount: String(after.amount), statementRef: after.statementRef, note: after.note }) : null,
      },
    })
    return jsonNoStore({ ok: true, id: after?.id ?? null })
  })
}
