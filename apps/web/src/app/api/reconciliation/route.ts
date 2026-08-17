// ★ MD-E: GET /api/reconciliation — List reconciliation status per provider per month
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(req: NextRequest) {
	const auth = await requireAuth(req, 'GET', req.url)
	if (isAuthError(auth)) return auth.error

	const { searchParams } = new URL(req.url)
	const periodMonth = searchParams.get('month')

	const where: { periodMonth?: string } = {}
	if (periodMonth) where.periodMonth = periodMonth

	const imports = await prisma.reconciliationImport.findMany({
		where,
		orderBy: [{ providerId: 'asc' }, { periodMonth: 'desc' }],
		include: {
			provider: { select: { id: true, name: true, shortName: true } },
		},
	})

	return jsonNoStore({
		imports: imports.map((r) => ({
			id: r.id,
			providerId: r.providerId,
			providerName: r.provider.name,
			providerShortName: r.provider.shortName,
			periodMonth: r.periodMonth,
			fileName: r.fileName,
			rowCount: r.rowCount,
			reportTotal: Number(r.reportTotal),
			reportCharges: r.reportCharges != null ? Number(r.reportCharges) : null,
			systemTotal: Number(r.systemTotal),
			difference: Number(r.difference),
			chargesVsPaid: r.chargesVsPaid != null ? Number(r.chargesVsPaid) : null,
			status: r.status,
			uploadedAt: r.uploadedAt,
			detailJson: r.detailJson,
		})),
	})
}
