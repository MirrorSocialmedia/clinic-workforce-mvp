// ★ MD-E: POST /api/reconciliation/upload — Upload monthly payment report xlsx
// ★ GET /api/reconciliation/upload/parse — Parse-only preview (returns meta)
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { parsePaymentReport, type ParsedRow } from '@/lib/reconciliation/parsePaymentReport'
import { compareReport } from '@/lib/reconciliation/compare'
import { apricotIdsOfProvider } from '@/lib/apricot-accounts'
import { resolveClinic } from '@/lib/reconciliation/resolve-clinic'
import { groupByPractitioner, resolvePractitioners, missingProviders, SKIP_PROVIDER, BLANK_PRACTITIONER } from '@/lib/reconciliation/clinic-report'

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
		const { meta, rows, skipped, blankRows, hasPractitionerColumn } = parsePaymentReport(buf)

		// 月份驗證：UI 傳入嘅月份要同報表一致
		if (periodMonth && meta.month !== periodMonth) {
			return NextResponse.json({
				error: `報表月份（${meta.month}）同你揀嘅月份（${periodMonth}）唔同，請確認上載咗正確嘅檔案`,
			}, { status: 422 })
		}

		// ★ cwm-reconclinic-20261006：全店報表（逐行 Practitioner、頂部冇 Practitioner）→ 逐個醫生對
		if (hasPractitionerColumn && !meta.practitioner.trim() && !providerId) {
			return await handleClinicWide({
				fileName: file.name, meta, rows, skipped, blankRows,
				mappingRaw: formData.get('mapping') as string | null,
				remember: formData.get('remember') === '1',
				actorId: session.userId,
			})
		}

		// 搵 provider（由 meta.practitioner 配對 Provider.name）
		const provider = await resolveProvider(meta.practitioner, providerId || undefined)

		// ★ G 章（防呆）：一個醫生多個 Apricot 帳號 → 報表可能只包咗部分 ID。
		//   ⚠️ 唔改 upsert —— 讀唔到報表包咗邊幾個帳號，改累加會令重複上載變雙倍。
		const apricotIds = await apricotIdsOfProvider(prisma, provider.id)
		const multiAccountWarning = apricotIds.length > 1
			? `⚠️ ${provider.name} 有 ${apricotIds.length} 個 Apricot 帳號 —— 請確認報表已剔齊全部`
			: null

		// ★ cwm-recon-clinic-20260909 A2：搵診所 —— 搵唔到一律 throw，唔准 fallback
		const clinic = await resolveClinic(meta.clinic)

		// 比對
		const result = await compareReport(provider.id, meta.month, rows, clinic.apricotClinicId!)

		// 存入 ReconciliationImport
		// ★ E：同一 provider+clinic+month 再上載 = 覆蓋（upsert），唔會堆新行
		//   clinicId 必唔係 null —— resolveClinic 搵唔到一律 throw（唔准 fallback）
		const detail = buildDetail(result, skipped, blankRows)
		const record = await prisma.reconciliationImport.upsert({
			where: {
				providerId_clinicId_periodMonth: {
					providerId: provider.id,
					clinicId: clinic.id,
					periodMonth: meta.month,
				},
			},
			update: {
				fileName: file.name,
				rowCount: rows.length,
				reportTotal: result.reportTotal,
				systemTotal: result.systemTotal,
				difference: result.difference,
				status: result.status,
				detailJson: detail,
				reportCharges: result.reportCharges,
				chargesVsPaid: result.chargesVsPaid,
				uploadedBy: session.userId,
				uploadedAt: new Date(), // ★ E：覆蓋時更新時間戳
			},
			create: {
				providerId: provider.id,
				clinicId: clinic.id, // ★ cwm-recon-clinic-20260909 A3：schema 一早有位，之前冇填
				periodMonth: meta.month,
				fileName: file.name,
				rowCount: rows.length,
				reportTotal: result.reportTotal,
				systemTotal: result.systemTotal,
				difference: result.difference,
				status: result.status,
				detailJson: detail, // ★ MD-AC1: 跳過行數入 detailJson（唔改 schema）
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
					+ (skipped > 0 ? `（解析失敗 ${skipped} 行）` : '')
					+ (blankRows > 0 ? `（空行 ${blankRows} 行）` : ''), // ★ B3：空行唔係警告，同 skipped 分開顯示
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
			multiAccountWarning, // ★ G 章：多帳號防呆（純警告，唔擋對數）
			blankRows, // ★ cwm-recon-clinic-20260909 B3: UI 顯示「空行 N」（唔係警告）
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

/**
 * ★ cwm-reconclinic-20261006：全店報表 —— 按 Practitioner 分組，每個醫生照用 compareReport，結果逐個醫生存（同單一醫生上載一樣）。
 *   名 → 醫生：已記住（ProviderReportName）優先；其餘要 mapping（UI 用單號建議預填），未齊 → 409 NEEDS_MAPPING，唔會靜靜跳過。
 *   「唔屬任何醫生」（SKIP）嘅組唔對數，但金額照列返出嚟。
 */
async function handleClinicWide(input: {
	fileName: string
	meta: { practitioner: string; clinic: string; month: string }
	rows: ParsedRow[]
	skipped: number
	blankRows: number
	mappingRaw: string | null
	remember: boolean
	actorId: string
}) {
	const { fileName, meta, rows, skipped, blankRows, actorId } = input
	const clinic = await resolveClinic(meta.clinic)
	const groups = groupByPractitioner(rows)
	const resolved = await resolvePractitioners(groups)

	let mapping: Record<string, string> = {}
	if (input.mappingRaw) {
		try { mapping = JSON.parse(input.mappingRaw) ?? {} } catch { throw new Error('REPORT_MAPPING_INVALID: 醫生對應資料格式唔啱') }
	}
	const chosen = new Map<string, string>() // nameNorm → providerId | SKIP
	for (const r of resolved) {
		const pick = r.providerId ?? mapping[r.nameNorm]
		if (pick) chosen.set(r.nameNorm, pick)
	}
	const missingNames = resolved.filter(r => !chosen.has(r.nameNorm))
	if (missingNames.length > 0) {
		return NextResponse.json({
			error: `報表入面有 ${missingNames.length} 個名未對應醫生`,
			code: 'NEEDS_MAPPING', practitioners: resolved, clinic: clinic.shortName || clinic.name, month: meta.month,
		}, { status: 409 })
	}
	const providerIds = Array.from(new Set(Array.from(chosen.values()).filter(v => v !== SKIP_PROVIDER)))
	const providers = await prisma.provider.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true, shortName: true } })
	if (providers.length !== providerIds.length) throw new Error('REPORT_MAPPING_INVALID: 揀咗嘅醫生唔存在')
	const providerById = new Map(providers.map(p => [p.id, p]))
	// 寫任何嘢之前先擋：冇綁 Apricot 帳號嘅醫生對唔到數（唔好對咗一半先爆）
	const bound = await prisma.apricotPractitioner.findMany({
		where: { providerId: { in: providerIds }, kind: 'PROVIDER' }, select: { providerId: true },
	})
	const unbound = providers.filter(p => !bound.some(b => b.providerId === p.id))
	if (unbound.length) {
		throw new Error(`REPORT_PROVIDER_NO_APRICOT_ID: ${unbound.map(p => p.name).join('、')} 未綁 Apricot 帳號，請先喺醫生管理補返，或者揀「唔屬任何醫生」`)
	}

	// 記住新對應（只記人手確認／建議嘅；已記住嘅唔郁；SKIP 唔記）
	if (input.remember) {
		for (const r of resolved) {
			const pid = chosen.get(r.nameNorm)
			if (r.providerId || !pid || pid === SKIP_PROVIDER || r.name === BLANK_PRACTITIONER) continue
			await prisma.providerReportName.upsert({
				where: { nameNorm: r.nameNorm },
				create: { nameNorm: r.nameNorm, name: r.name, providerId: pid, createdBy: actorId },
				update: {},
			})
		}
	}

	const results: any[] = []
	for (const pid of providerIds) {
		const names = groups.filter(g => chosen.get(g.nameNorm) === pid)
		const pRows = names.flatMap(g => g.rows)
		const result = await compareReport(pid, meta.month, pRows, clinic.apricotClinicId!)
		const detail = { ...buildDetail(result, 0, 0), clinicWide: true, reportNames: names.map(g => g.name) }
		const data = {
			fileName, rowCount: pRows.length, reportTotal: result.reportTotal, systemTotal: result.systemTotal,
			difference: result.difference, status: result.status, detailJson: detail,
			reportCharges: result.reportCharges, chargesVsPaid: result.chargesVsPaid, uploadedBy: actorId,
		}
		const record = await prisma.reconciliationImport.upsert({
			where: { providerId_clinicId_periodMonth: { providerId: pid, clinicId: clinic.id, periodMonth: meta.month } },
			update: { ...data, uploadedAt: new Date() },
			create: { providerId: pid, clinicId: clinic.id, periodMonth: meta.month, ...data },
		})
		await prisma.auditLog.create({
			data: {
				actorId, action: 'RECONCILIATION_IMPORT', entity: 'ReconciliationImport', entityId: record.id,
				notes: `上載月報對數（全店）: ${clinic.shortName || clinic.name} ${meta.month} ${providerById.get(pid)?.name ?? ''} — ${result.status}`,
				afterJson: JSON.stringify({ providerId: pid, clinicId: clinic.id, periodMonth: meta.month, reportTotal: result.reportTotal, systemTotal: result.systemTotal, difference: result.difference, status: result.status }),
			},
		})
		results.push({
			providerId: pid, providerName: providerById.get(pid)?.name ?? '', reportNames: names.map(g => g.name),
			status: result.status, reportTotal: result.reportTotal, systemTotal: result.systemTotal, difference: result.difference,
		})
	}

	const skippedGroups = groups.filter(g => chosen.get(g.nameNorm) === SKIP_PROVIDER).map(g => ({ name: g.name, total: g.total, count: g.rows.length }))
	const missing = await missingProviders(clinic.apricotClinicId!, meta.month, new Set(providerIds))
	const round2 = (n: number) => Math.round(n * 100) / 100
	return NextResponse.json({
		success: true, mode: 'CLINIC', clinic: clinic.shortName || clinic.name, month: meta.month,
		results, skippedGroups, missing, skipped, blankRows,
		totals: {
			report: round2(results.reduce((a, r) => a + r.reportTotal, 0)),
			system: round2(results.reduce((a, r) => a + r.systemTotal, 0) + missing.reduce((a, m) => a + m.systemTotal, 0)),
			skippedReport: round2(skippedGroups.reduce((a, g) => a + g.total, 0)),
		},
	})
}

// 由 Practitioner 名稱配對 Provider
async function resolveProvider(practitionerName: string, hintProviderId?: string) {
	// ① UI 有畀 providerId 就直接用（最可靠）
	if (hintProviderId) {
		const p = await prisma.provider.findUnique({
			where: { id: hintProviderId },
			select: { id: true, name: true, shortName: true },
		})
		if (p) return p
	}

	// ② 由 "(TSE)" 抽 code
	const code = practitionerName.match(/\(([^)]+)\)\s*$/)?.[1]?.trim()
	if (!code) throw new Error(`REPORT_PRACTITIONER_UNPARSEABLE: ${practitionerName}`)

	const matches = await prisma.provider.findMany({
		where: { shortName: code },
		select: { id: true, name: true, shortName: true },
		orderBy: { id: 'asc' }, // ★ 唯一 tiebreaker
	})

	if (matches.length === 0) throw new Error(`REPORT_PROVIDER_NOT_FOUND: ${code}`)
	if (matches.length > 1) throw new Error(`REPORT_PROVIDER_AMBIGUOUS: ${code} 對到 ${matches.length} 個醫生`)
	return matches[0]
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
	byMethod: Array<{ method: string; report: number; system: number; diff: number }> // ★ C2
	nonIncomeTotal: number // ★ cwm-reconkiosk-20260910 A1：純顯示欄
	nonIncomeMethods: string[]
	payoutBasisTotal: number
}, skipped = 0, blankRows = 0): Record<string, any> {
	return {
		reportTotal: result.reportTotal,
		reportCharges: result.reportCharges,
		clinicExtId: result.clinicExtId, // ★ A1：今次對數收窄咗邊間（debug 用）
		systemTotal: result.systemTotal,
		// ★ cwm-reconxlsx-fix-20260910 B：freeSpTotal / reportTotalAdjusted 已剷（兩邊都包 FREE SP，唔使調整）
		difference: result.difference,
		chargesVsPaid: result.chargesVsPaid,
		status: result.status,
		byDay: result.byDay,
		byMethod: result.byMethod,
		// ★ cwm-reconkiosk-20260910 A1：對數包咗但月結排走嘅部分（純顯示）
		nonIncomeTotal: result.nonIncomeTotal,
		nonIncomeMethods: result.nonIncomeMethods,
		payoutBasisTotal: result.payoutBasisTotal,
		skipped, // ★ MD-AC1
		blankRows, // ★ cwm-recon-clinic-20260909 B3
	}
}
