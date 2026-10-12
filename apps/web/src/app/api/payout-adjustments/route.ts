import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { writeInPeriod, PeriodLockedError } from '@/lib/payout/period-lock'
import { createVoidAdjustment } from '@/lib/payout/engine'
import { lockedRunFor, isMonthStr } from '@/lib/cost-entry/guards'
import { NextRequest } from 'next/server'
import { payoutClinicGuard, payoutClinicWhere } from '@/lib/payout/kiosk-scope'
import { validateAdjustmentInput } from '@/lib/payout/adjustment-crud'

export async function POST(req: NextRequest) {
	const auth = await requirePerm(req, 'provider_payout')
	if (isAuthError(auth)) return auth.error
	const { session } = auth
	const body = await req.json().catch(() => ({} as any))
	// ★ cwm-adjedit-20261013：驗證搬去 adjustment-crud（新增／修改共用；修正 0.07 之類浮點誤判）
	const v = validateAdjustmentInput(body)
	if (!v.ok) {
		const denied = body?.clinicId ? payoutClinicGuard(session, body.clinicId) : null // ★ cwm-kioskpayout-20261010
		if (denied) return denied
		return Response.json({ error: v.error }, { status: 400 })
	}
	const { providerId, clinicId, periodMonth, sourceMonth, reason, refCode, amount: amt, note } = v.data
	{ const denied = payoutClinicGuard(session, clinicId); if (denied) return denied } // ★ cwm-kioskpayout-20261010
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
			clinicId,
			notes: `新增調整記錄: ${periodMonth} — ${reason}${amt > 0 ? ' +' : ''}${amt}${refCode ? ` (${refCode})` : ''}`,
			afterJson: JSON.stringify({ providerId, periodMonth, amount: amt, reason }),
		},
	})
	return Response.json({ ok: true })
}

/**
 * ★ cwm-adjlist-20261012：GET /api/payout-adjustments?month=&providerId=&clinicId= — 之前嘅手動調整記錄
 *   月份篩「落喺邊個月」（periodMonth）；唔篩 = 最近 200 筆。權限同新增（provider_payout）；店舖帳號只見自己店。
 *   每筆帶醫生／診所名、錄入人、有冇入咗月結（runId → 月結狀態）。純讀。
 */
export async function GET(req: NextRequest) {
	const auth = await requirePerm(req, 'provider_payout')
	if (isAuthError(auth)) return auth.error
	const { session } = auth
	const sp = req.nextUrl.searchParams
	const month = sp.get('month')
	const providerId = sp.get('providerId')
	const clinicId = sp.get('clinicId')
	if (month && !isMonthStr(month)) return Response.json({ error: '月份格式錯（YYYY-MM）' }, { status: 400 })
	if (clinicId) { const denied = payoutClinicGuard(session, clinicId); if (denied) return denied }

	const where: any = { ...payoutClinicWhere(session) }
	if (month) where.periodMonth = month
	if (providerId) where.providerId = providerId
	if (clinicId) where.clinicId = clinicId
	const rows = await prisma.payoutAdjustment.findMany({
		where,
		orderBy: [{ createdAt: 'desc' }],
		take: 200,
		include: { run: { select: { id: true, status: true } } },
	})
	const [providers, clinics, users] = await Promise.all([
		prisma.provider.findMany({ where: { id: { in: [...new Set(rows.map(r => r.providerId))] } }, select: { id: true, name: true } }),
		prisma.clinic.findMany({ where: { id: { in: [...new Set(rows.map(r => r.clinicId).filter((x): x is string => !!x))] } }, select: { id: true, name: true, shortName: true } }),
		prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.createdBy))] } }, select: { id: true, name: true } }),
	])
	const pName = new Map(providers.map(p => [p.id, p.name]))
	const cName = new Map(clinics.map(c => [c.id, c.shortName || c.name]))
	const uName = new Map(users.map(u => [u.id, u.name]))
	return Response.json({
		adjustments: rows.map(r => ({
			id: r.id,
			providerId: r.providerId,
			providerName: pName.get(r.providerId) ?? '（已刪除醫生）',
			clinicId: r.clinicId,
			clinicName: r.clinicId ? (cName.get(r.clinicId) ?? '（已刪除診所）') : '—',
			periodMonth: r.periodMonth,
			sourceMonth: r.sourceMonth,
			reason: r.reason,
			refCode: r.refCode,
			amount: Number(r.amount),
			note: r.note,
			createdByName: uName.get(r.createdBy) ?? r.createdBy,
			createdAt: r.createdAt,
			// 入咗邊張月結（null = 未入；LOCKED = 已鎖定出糧）
			runStatus: r.run?.status ?? null,
		})),
	}, { headers: { 'Cache-Control': 'no-store' } })
}
