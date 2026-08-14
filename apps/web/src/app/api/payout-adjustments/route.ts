import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { createVoidAdjustment } from '@/lib/payout/engine'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
	const auth = await requirePerm(req, 'provider_payout')
	if (isAuthError(auth)) return auth.error
	const { session } = auth
	const body = await req.json()
	const { providerId, periodMonth, sourceMonth, reason, refCode, amount, note } = body
	if (!providerId || !periodMonth || !reason || amount == null) {
		return Response.json({ error: 'Missing required fields' }, { status: 400 })
	}
	const amt = Number(amount)
	await createVoidAdjustment(
		providerId,
		sourceMonth || periodMonth,
		periodMonth,
		amt,
		reason as 'VOID' | 'REFUND' | 'MANUAL',
		refCode || null,
		note || '',
		session.userId,
	)
	// Audit log
	await prisma.auditLog.create({
		data: {
			actorId: session.userId,
			action: 'PAYOUT_ADJUST_CREATE',
			entity: 'PayoutAdjustment',
			entityId: '',
			notes: `新增調整記錄: ${periodMonth} — ${reason}`,
			afterJson: JSON.stringify({ providerId, periodMonth, amount: amt, reason }),
		},
	})
	return Response.json({ ok: true })
}
