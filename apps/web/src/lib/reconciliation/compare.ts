// ★ MD-E: Compare Apricot monthly payment report against system PaymentAllocation
// 容差 $1。MISMATCH 唔擋生成月結，只警告。

import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
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
	reportCharges: number // ★ AA2: Total Charges
	clinicExtId: string // ★ cwm-recon-clinic-20260909 A1：今次對數收窄咗邊間（方便畫面顯示同 debug）
	systemTotal: number
	difference: number
	chargesVsPaid: number // ★ AA2: charges - paid 差額
	status: 'MATCH' | 'MISMATCH'
	byDay: Array<{ date: string; report: number; system: number; diff: number }>
	byMethod: Array<{ method: string; amount: number }>
}

export async function compareReport(
	providerId: string,
	periodMonth: string,
	rows: ParsedRow[],
	// ★ cwm-recon-clinic-20260909 A1：報表係【一間】診所，系統一定要收窄到同一間。
	//   ★★★ 必填，唔准 optional —— optional 嘅話將來新 caller 唔傳就靜靜變返「全部診所」，
	//      呢個正正就係今次個 bug。做成必填，TS 會逼所有 caller 交代。
	clinicExtId: string,
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
			clinicExtId, // ★ A1：收窄到報表嗰間診所
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

	// ★ AA2: 對數用 Total Paid（實收）做主
	const totalPaid = round2(sum(rows.map((r) => r.paid ?? r.charges ?? r.amount ?? 0)))
	const totalCharges = round2(sum(rows.map((r) => r.charges ?? r.paid ?? r.amount ?? 0)))
	const reportTotal = totalPaid // ★ 對數用實收
	const chargesVsPaid = round2(totalCharges - totalPaid)

	const difference = round2(reportTotal - systemTotal)
	const status = Math.abs(difference) <= 1 ? 'MATCH' : 'MISMATCH'

	// 3) 逐日對比（用 paid 欄）
	const reportByDay = groupBy(rows, (r) => r.date)
	const systemByDay = groupBy(
		allocs,
		(a) => toHKDateStr(a.paidAt),
	)

	const allDates = new Set([
		...Object.keys(reportByDay),
		...Object.keys(systemByDay),
	])
	const byDay: Array<{ date: string; report: number; system: number; diff: number }> = []
	for (const date of allDates) {
		const reportSum = round2(
			sum((reportByDay[date] || []).map((r) => r.paid ?? r.charges ?? r.amount ?? 0)),
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

	return { reportTotal, reportCharges: totalCharges, clinicExtId, systemTotal, difference, chargesVsPaid, status, byDay, byMethod }
}
