import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { writeInPeriod, PeriodLockedError } from '@/lib/payout/period-lock'
import { createVoidAdjustment } from '@/lib/payout/engine'
import { lockedRunFor, isMonthStr } from '@/lib/cost-entry/guards'
import { NextRequest } from 'next/server'
import { payoutClinicGuard } from '@/lib/payout/kiosk-scope'

export async function POST(req: NextRequest) {
	const auth = await requirePerm(req, 'provider_payout')
	if (isAuthError(auth)) return auth.error
	const { session } = auth
	const body = await req.json().catch(() => ({} as any))
	const { providerId, clinicId, periodMonth, sourceMonth, reason, refCode, amount, note } = body
	if (!providerId || !clinicId || !periodMonth || !reason || amount == null) {
		return Response.json({ error: 'providerId, clinicId, periodMonth, reason, amount 都係必填' }, { status: 400 })
	}
	{ const denied = payoutClinicGuard(session, clinicId); if (denied) return denied } // ★ cwm-kioskpayout-20261010
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
	// ★ cwm-payaudit-20261006：$0、錯月份、錯原因、唔存在嘅醫生／診所、已鎖月份 —— 全部擋
	//   （已鎖月份嘅調整永遠唔會被任何月結單撈到 → 醫生收唔到，又冇人知）
	if (amt === 0 || Math.round(amt * 100) !== amt * 100) {
		return Response.json({ error: '金額唔可以係 $0，最多兩個小數位' }, { status: 400 })
	}
	if (!isMonthStr(periodMonth) || (sourceMonth && !isMonthStr(sourceMonth))) {
		return Response.json({ error: '月份格式錯（YYYY-MM）' }, { status: 400 })
	}
	if (!['VOID', 'REFUND', 'MANUAL'].includes(reason)) {
		return Response.json({ error: '原因只可以係 VOID / REFUND / MANUAL' }, { status: 400 })
	}
	const [prov, clin] = await Promise.all([
		prisma.provider.findUnique({ where: { id: providerId }, select: { id: true } }),
		prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } }),
	])
	if (!prov || !clin) {
		return Response.json({ error: '醫生或者診所唔存在' }, { status: 400 })
	}
	if (await lockedRunFor(prisma, providerId, clinicId, periodMonth)) {
		return Response.json({ error: `${periodMonth} 嘅月結已經鎖定，調整唔會計入。請揀下一個未鎖定嘅月份` }, { status: 409 })
	}

	// ★ P3-deploy J2: 接返 return value，填 entityId
	// ★ cwm-payaudit-20261006：期間鎖入面寫（同鎖月結一前一後）
	let adj: any
	try {
		adj = await writeInPeriod(prisma, { providerId, clinicId, periodMonth }, (tx: any) => createVoidAdjustment(
			providerId,
			sourceMonth || periodMonth,
			periodMonth,
			amt,
			reason as 'VOID' | 'REFUND' | 'MANUAL',
			refCode || null,
			note || '',
			session.userId,
			clinicId,
			tx,
		))
	} catch (e) {
		if (e instanceof PeriodLockedError) return Response.json({ error: `${e.periodMonth} 嘅月結已經鎖定，調整唔會計入。請揀下一個未鎖定嘅月份` }, { status: 409 })
		throw e
	}
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
