// ★ H1b: Parse-only preview endpoint — returns meta without saving
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { parsePaymentReport } from '@/lib/reconciliation/parsePaymentReport'
import { groupByPractitioner, resolvePractitioners } from '@/lib/reconciliation/clinic-report'
import { resolveClinic } from '@/lib/reconciliation/resolve-clinic'
import { payoutClinicGuard } from '@/lib/payout/kiosk-scope'

export async function POST(req: NextRequest) {
	const auth = await requireAuth(req, 'POST', req.url)
	if (isAuthError(auth)) return auth.error

	const formData = await req.formData()
	const file = formData.get('file') as File | null

	if (!file) {
		return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
	}
	if (file.size > 5 * 1024 * 1024) {
		return NextResponse.json({ error: 'File too large' }, { status: 413 })
	}
	if (!file.name.toLowerCase().endsWith('.xlsx')) {
		return NextResponse.json({ error: 'Only .xlsx' }, { status: 415 })
	}

	try {
		const buf = Buffer.from(await file.arrayBuffer())
		const { meta, rows, skipped, hasPractitionerColumn } = parsePaymentReport(buf)
		// ★ cwm-reconclinic-20261006：全店報表 → 回傳逐個名＋已記住／單號建議嘅醫生
		if (hasPractitionerColumn && !meta.practitioner.trim()) {
			const clinic = await resolveClinic(meta.clinic)
			{ const denied = payoutClinicGuard(auth.session!, clinic.id); if (denied) return denied } // ★ cwm-kioskpayout-20261010
			const practitioners = await resolvePractitioners(groupByPractitioner(rows))
			return NextResponse.json({
				mode: 'CLINIC', meta, clinic: clinic.shortName || clinic.name,
				rowCount: rows.length, skipped, practitioners,
			})
		}
		return NextResponse.json({
			meta,
			rowCount: rows.length,
			skipped, // ★ MD-AC1: 跳過行數回報
		})
	} catch (e: any) {
		const msg = e?.message ?? 'parse failed'
		const isUserError = /^REPORT_/.test(msg) // 格式問題 = 用戶錯誤，唔好當 server error
		if (!isUserError) console.error('[reconciliation/parse] 失敗', e)
		return NextResponse.json({ error: msg }, { status: isUserError ? 422 : 500 })
	}
}
