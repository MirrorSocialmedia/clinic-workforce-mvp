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
	// ★ P3-deploy J4: 金額守衛
	if (!Number.isFinite(amt)) {
		return Response.json({ error: '金額異常' }, { status: 400 })
	}
	if (Math.abs(amt) > 1_000_000) {
		return Response.json({ error: '金額異常' }, { status: 400 })
	}
	if (reason === 'VOID' && amt > 0) {
		return Response.json({ error: '作廢回沖金額必須係負數' }, { status: 400 })
	}

	// ★ P3-deploy J2: 接返 return value，填 entityId
	const adj = await createVoidAdjustment(
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
			entityId: adj.id,
			notes: `新增調整記錄: ${periodMonth} — ${reason}${amt > 0 ? ' +' : ''}${amt}${refCode ? ` (${refCode})` : ''}`,
			afterJson: JSON.stringify({ providerId, periodMonth, amount: amt, reason }),
		},
	})
	return Response.json({ ok: true })
}
