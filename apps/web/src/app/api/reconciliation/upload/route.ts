// ★ MD-E: POST /api/reconciliation/upload — Upload monthly payment report xlsx
// ★ GET /api/reconciliation/upload/parse — Parse-only preview (returns meta)
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { parsePaymentReport, type ParsedRow } from '@/lib/reconciliation/parsePaymentReport'
import { compareReport } from '@/lib/reconciliation/compare'

export async function POST(req: NextRequest) {
	const auth = await requireAuth(req, 'POST', req.url)
	if (isAuthError(auth)) return auth.error
	const { session } = auth

	const formData = await req.formData()
	const file = formData.get('file') as File | null
	const providerId = formData.get('providerId') as string | null
	const periodMonth = formData.get('periodMonth') as string | null

	if (!file) {
		return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
	}

	// Size + MIME 限制
	if (file.size > 5 * 1024 * 1024) {
		return NextResponse.json({ error: 'File too large' }, { status: 413 })
	}
	if (!file.name.toLowerCase().endsWith('.xlsx')) {
		return NextResponse.json({ error: 'Only .xlsx' }, { status: 415 })
	}

	try {
		// 解析
		const buf = Buffer.from(await file.arrayBuffer())
		const { meta, rows, skipped } = parsePaymentReport(buf)

		// 月份驗證：UI 傳入嘅月份要同報表一致
		if (periodMonth && meta.month !== periodMonth) {
			return NextResponse.json({
				error: `報表月份（${meta.month}）同你揀嘅月份（${periodMonth}）唔同，請確認上載咗正確嘅檔案`,
			}, { status: 422 })
		}

		// 搵 provider（由 meta.practitioner 配對 Provider.name）
		const provider = await resolveProvider(meta.practitioner, providerId || undefined)

		// ★ cwm-recon-clinic-20260909 A2：搵診所 —— 搵唔到一律 throw，唔准 fallback
		const clinic = await resolveClinic(meta.clinic)

		// 比對
		const result = await compareReport(provider.id, meta.month, rows, clinic.apricotClinicId!)

		// 存入 ReconciliationImport
		const record = await prisma.reconciliationImport.create({
			data: {
				providerId: provider.id,
				clinicId: clinic.id, // ★ cwm-recon-clinic-20260909 A3：schema 一早有位，之前冇填
				periodMonth: meta.month,
				fileName: file.name,
				rowCount: rows.length,
				reportTotal: result.reportTotal,
				systemTotal: result.systemTotal,
				difference: result.difference,
				status: result.status,
				detailJson: buildDetail(result, skipped), // ★ MD-AC1: 跳過行數入 detailJson（唔改 schema）
				reportCharges: result.reportCharges,
				chargesVsPaid: result.chargesVsPaid,
				uploadedBy: session.userId,
			},
		})

		// Audit
		await prisma.auditLog.create({
			data: {
				actorId: session.userId,
				action: 'RECONCILIATION_IMPORT',
				entity: 'ReconciliationImport',
				entityId: record.id,
				notes: `上載月報對數: ${clinic.shortName || clinic.name} ${meta.month} — ${result.status}`
					+ (skipped > 0 ? `（跳過 ${skipped} 行）` : ''), // ★ A3：notes 帶診所名
				afterJson: JSON.stringify({
					providerId: provider.id,
					clinicId: clinic.id, // ★ A3
					periodMonth: meta.month,
					reportTotal: result.reportTotal,
					systemTotal: result.systemTotal,
					difference: result.difference,
					status: result.status,
				}),
			},
		})

		return NextResponse.json({
			success: true,
			status: result.status,
			clinic: clinic.shortName || clinic.name, // ★ A3：return 帶診所名
			skipped, // ★ MD-AC1: UI 顯示「跳過 N 行」
			difference: result.difference,
			reportTotal: result.reportTotal,
			reportCharges: result.reportCharges,
			chargesVsPaid: result.chargesVsPaid,
			systemTotal: result.systemTotal,
		})
	} catch (e: any) {
		const msg = e?.message ?? 'upload failed'
		const isUserError = /^REPORT_/.test(msg)
		if (!isUserError) console.error('[reconciliation/upload] 失敗', e)
		return NextResponse.json({ error: msg }, { status: isUserError ? 422 : 500 })
	}
}

// 由 Practitioner 名稱配對 Provider
async function resolveProvider(practitionerName: string, hintProviderId?: string) {
	// ① UI 有畀 providerId 就直接用（最可靠）
	if (hintProviderId) {
		const p = await prisma.provider.findUnique({
			where: { id: hintProviderId },
			select: { id: true, apricotId: true, shortName: true },
		})
		if (p) return p
	}

	// ② 由 "(TSE)" 抽 code
	const code = practitionerName.match(/\(([^)]+)\)\s*$/)?.[1]?.trim()
	if (!code) throw new Error(`REPORT_PRACTITIONER_UNPARSEABLE: ${practitionerName}`)

	const matches = await prisma.provider.findMany({
		where: { shortName: code },
		select: { id: true, apricotId: true, shortName: true },
		orderBy: { id: 'asc' }, // ★ 唯一 tiebreaker
	})

	if (matches.length === 0) throw new Error(`REPORT_PROVIDER_NOT_FOUND: ${code}`)
	if (matches.length > 1) throw new Error(`REPORT_PROVIDER_AMBIGUOUS: ${code} 對到 ${matches.length} 個醫生`)
	return matches[0]
}

/**
 * ★ cwm-recon-clinic-20260909 A2：由報表 meta.clinic 搵返 Clinic。
 * ★★★ 搵唔到／冇 apricotClinicId 一律 throw —— 【唔准】fallback 去「全部診所」。
 *    今次個 bug 就係因為 meta.clinic 讀咗但冇用，靜靜對晒全部診所，
 *    畫面照樣出一個「差異」數字，冇人知係口徑錯。寧願上載失敗都唔好出錯數。
 * ★ 錯誤訊息用 REPORT_ 開頭 → upload catch 會當用戶錯誤回 422，唔會當 500。
 */
async function resolveClinic(metaClinic: string) {
	const key = (metaClinic || '').trim()
	if (!key) {
		throw new Error('REPORT_CLINIC_MISSING: 報表冇 Clinic 欄，判斷唔到係邊間診所嘅數')
	}
	const clinics = await prisma.clinic.findMany({
		select: { id: true, name: true, shortName: true, apricotClinicId: true },
	})
	const norm = (s: string | null) => (s ?? '').trim().toLowerCase()
	const hit =
		clinics.find(c => c.apricotClinicId && norm(c.apricotClinicId) === norm(key)) ??
		clinics.find(c => c.shortName && norm(c.shortName) === norm(key)) ??
		clinics.find(c => norm(c.name) === norm(key))

	if (!hit) {
		throw new Error(
			`REPORT_CLINIC_UNKNOWN: 報表寫住 Clinic「${key}」，但系統搵唔到對應診所。` +
			`已知診所：${clinics.map(c => c.shortName || c.name).join('／')}`,
		)
	}
	if (!hit.apricotClinicId) {
		throw new Error(
			`REPORT_CLINIC_NO_APRICOT_ID: 診所「${hit.shortName || hit.name}」冇設定 apricotClinicId，` +
			`對唔到 PaymentAllocation.clinicExtId。請先喺診所設定補返。`,
		)
	}
	return hit
}

function buildDetail(result: {
	reportTotal: number
	reportCharges: number
	clinicExtId: string // ★ cwm-recon-clinic-20260909 A1
	systemTotal: number
	difference: number
	chargesVsPaid: number
	status: string
	byDay: Array<{ date: string; report: number; system: number; diff: number }>
	byMethod: Array<{ method: string; amount: number }>
}, skipped = 0): Record<string, any> {
	return {
		reportTotal: result.reportTotal,
		reportCharges: result.reportCharges,
		clinicExtId: result.clinicExtId, // ★ A1：今次對數收窄咗邊間（debug 用）
		systemTotal: result.systemTotal,
		difference: result.difference,
		chargesVsPaid: result.chargesVsPaid,
		status: result.status,
		byDay: result.byDay,
		byMethod: result.byMethod,
		skipped, // ★ MD-AC1
	}
}
