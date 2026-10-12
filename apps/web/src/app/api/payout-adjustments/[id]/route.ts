/**
 * ★ cwm-adjedit-20261013
 * PUT    /api/payout-adjustments/[id] — 修改手動調整（只限未入月結）
 * DELETE /api/payout-adjustments/[id] — 刪除手動調整（只限未入月結）
 * 權限同新增（provider_payout）；店舖帳號只可以處理自己店。規則見 lib/payout/adjustment-crud.ts。
 * // ownership-ok: 月結調整屬 provider_payout 權限範圍
 */
import { NextRequest } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { payoutClinicAllowed } from '@/lib/payout/kiosk-scope'
import { validateAdjustmentInput, updateAdjustment, deleteAdjustment, AdjustmentError } from '@/lib/payout/adjustment-crud'

const NO_STORE = { 'Cache-Control': 'no-store' }

function errorResponse(e: unknown): Response {
	if (e instanceof AdjustmentError) return Response.json({ error: e.message }, { status: e.status, headers: NO_STORE })
	throw e
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
	const auth = await requirePerm(req, 'provider_payout')
	if (isAuthError(auth)) return auth.error
	const { session } = auth
	const body = await req.json().catch(() => ({} as any))
	const v = validateAdjustmentInput(body)
	if (!v.ok) return Response.json({ error: v.error }, { status: 400, headers: NO_STORE })
	try {
		const adj = await updateAdjustment(prisma, params.id, v.data, session.userId, (c) => payoutClinicAllowed(session, c))
		return Response.json({ ok: true, id: adj?.id ?? params.id }, { headers: NO_STORE })
	} catch (e) {
		return errorResponse(e)
	}
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
	const auth = await requirePerm(req, 'provider_payout')
	if (isAuthError(auth)) return auth.error
	const { session } = auth
	try {
		await deleteAdjustment(prisma, params.id, session.userId, (c) => payoutClinicAllowed(session, c))
		return Response.json({ ok: true }, { headers: NO_STORE })
	} catch (e) {
		return errorResponse(e)
	}
}
