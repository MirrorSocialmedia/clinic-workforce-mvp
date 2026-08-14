// ★ MD-E: POST /api/reconciliation/upload — Upload monthly payment report xlsx
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
		const { meta, rows } = parsePaymentReport(buf)

		// 搵 provider（由 meta.practitioner 配對 Provider.name）
		const provider = await resolveProvider(meta.practitioner)
		if (!provider) {
			return NextResponse.json(
				{ error: `搵唔到醫生: ${meta.practitioner}` },
				{ status: 404 },
			)
		}

		// 比對
		const result = await compareReport(provider.id, meta.month, rows)

		// 存入 ReconciliationImport
		const record = await prisma.reconciliationImport.create({
			data: {
				providerId: provider.id,
				periodMonth: meta.month,
				fileName: file.name,
				rowCount: rows.length,
				reportTotal: result.reportTotal,
				systemTotal: result.systemTotal,
				difference: result.difference,
				status: result.status,
				detailJson: buildDetail(result),
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
				notes: `上載月報對數: ${meta.month} — ${result.status}`,
				afterJson: JSON.stringify({
					providerId: provider.id,
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
			difference: result.difference,
			reportTotal: result.reportTotal,
			systemTotal: result.systemTotal,
		})
	} catch (e: any) {
		console.error('[reconciliation/upload] 失敗', e)
		const msg = e.message || 'upload failed'
		return NextResponse.json({ error: msg }, { status: 500 })
	}
}

// 由 Practitioner 名稱配對 Provider
async function resolveProvider(practitionerName: string): Promise<
	| { id: string; apricotId: string | null }
	| null
> {
	if (!practitionerName) return null

	// 嘗試由全名配對
	let provider = await prisma.provider.findFirst({
		where: { name: { contains: practitionerName } },
		select: { id: true, apricotId: true },
	})

	// 如果唔到，嘗試由醫生姓名中嘅簡寫配對
	if (!provider && practitionerName.includes('(')) {
		const shortName = practitionerName.match(/\(([^)]+)\)/)?.[1]?.trim()
		if (shortName) {
			provider = await prisma.provider.findFirst({
				where: { shortName },
				select: { id: true, apricotId: true },
			})
		}
	}

	return provider
}

function buildDetail(result: {
	reportTotal: number
	systemTotal: number
	difference: number
	status: string
	byDay: Array<{ date: string; report: number; system: number; diff: number }>
	byMethod: Array<{ method: string; amount: number }>
}): Record<string, any> {
	return {
		reportTotal: result.reportTotal,
		systemTotal: result.systemTotal,
		difference: result.difference,
		status: result.status,
		byDay: result.byDay,
		byMethod: result.byMethod,
	}
}
