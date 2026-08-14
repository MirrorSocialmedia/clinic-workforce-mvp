// ★ MD-E: Compare Apricot monthly payment report against system PaymentAllocation
// 容差 $1。MISMATCH 唔擋生成月結，只警告。

import { prisma } from '@/lib/prisma'
import { ParsedRow } from './parsePaymentReport'

// ★ Re-export ACTIVE_ALLOCATION filter (same as payout engine)
const ACTIVE_ALLOCATION = { isVoid: false, isSuperseded: false } as const

function round2(v: number): number {
	return Math.round(v * 100) / 100
}

function sum(nums: number[]): number {
	return nums.reduce((a, b) => a + b, 0)
}

function groupBy<T>(items: T[], fn: (item: T) => string): Record<string, T[]> {
	const map: Record<string, T[]> = {}
	for (const item of items) {
		const key = fn(item)
		if (!map[key]) map[key] = []
		map[key].push(item)
	}
	return map
}

interface CompareResult {
	reportTotal: number
	systemTotal: number
	difference: number
	status: 'MATCH' | 'MISMATCH'
	byDay: Array<{ date: string; report: number; system: number; diff: number }>
	byMethod: Array<{ method: string; amount: number }>
}

export async function compareReport(
	providerId: string,
	periodMonth: string,
	rows: ParsedRow[],
): Promise<CompareResult> {
	// 1) 攞 provider 嘅 apricotId
	const provider = await prisma.provider.findUnique({
		where: { id: providerId },
		select: { apricotId: true },
	})
	if (!provider?.apricotId) {
		throw new Error(`Provider ${providerId} 冇設定 apricotId`)
	}

	// 2) 攞系統數 — PaymentAllocation.rawAmount（扣手續費前）
	const allocs = await prisma.paymentAllocation.findMany({
		where: {
			...ACTIVE_ALLOCATION,
			providerExtId: provider.apricotId,
			periodMonth,
			countAsIncome: true,
		},
		select: {
			amount: true,
			methodNorm: true,
			paidAt: true,
		},
	})

	const systemTotal = round2(sum(allocs.map((a) => Number(a.amount))))
	const reportTotal = round2(sum(rows.map((r) => r.amount)))
	const difference = round2(reportTotal - systemTotal)
	const status = Math.abs(difference) <= 1 ? 'MATCH' : 'MISMATCH'

	// 3) 逐日對比
	const reportByDay = groupBy(rows, (r) => r.date)
	const systemByDay = groupBy(
		allocs,
		(a) => a.paidAt.toISOString().split('T')[0],
	)

	const allDates = new Set([
		...Object.keys(reportByDay),
		...Object.keys(systemByDay),
	])
	const byDay: Array<{ date: string; report: number; system: number; diff: number }> = []
	for (const date of allDates) {
		const reportSum = round2(
			sum((reportByDay[date] || []).map((r) => r.amount)),
		)
		const systemSum = round2(
			sum((systemByDay[date] || []).map((a) => Number(a.amount))),
		)
		byDay.push({ date, report: reportSum, system: systemSum, diff: round2(reportSum - systemSum) })
	}
	byDay.sort((a, b) => a.date.localeCompare(b.date))

	// 4) 逐方式對比（系統）
	const byMethod: Array<{ method: string; amount: number }> = []
	const methodGroups = groupBy(allocs, (a) => a.methodNorm)
	for (const [method, items] of Object.entries(methodGroups)) {
		byMethod.push({ method, amount: round2(sum(items.map((a) => Number(a.amount)))) })
	}
	byMethod.sort((a, b) => b.amount - a.amount)

	return { reportTotal, systemTotal, difference, status, byDay, byMethod }
}
