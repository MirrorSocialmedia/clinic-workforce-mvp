import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr, getMonthRange } from '@/lib/hk-date'

interface PreflightRun {
  id: string
  periodMonth: Date
  status: string
  items: Array<{
    employeeId: string
    storeBonus: number | null
    splitPay: number | null
    totalPayable: number | null
  }>
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const raw = await prisma.payrollRun.findUnique({
    where: { id: params.id },
    include: {
      items: {
        select: { employeeId: true, storeBonus: true, splitPay: true, totalPayable: true },
      },
    },
  }) as unknown as PreflightRun | null

  if (!raw) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const run = raw
  const pmStr = toHKDateStr(run.periodMonth).slice(0, 7)
  const { start, end } = getMonthRange(run.periodMonth)
  const empIds = run.items.map(i => i.employeeId)

  const [pendingCorrections, pendingLeaves, partialPunches, zeroBonus, negativeNet] = await Promise.all([
    prisma.punchCorrection.count({
      where: {
        employeeId: { in: empIds },
        status: 'PENDING',
        correctedTime: { gte: start, lte: end },
      },
    }),
    prisma.leaveRequest.count({
      where: {
        employeeId: { in: empIds },
        status: 'PENDING',
        startDate: { lte: end },
        endDate: { gte: start },
      },
    }),
    prisma.punchRecord.count({
      where: {
        employeeId: { in: empIds },
        punchTime: { gte: start, lte: end },
        punchType: 'CLOCK_IN',
      },
    }),
    Promise.resolve(run.items.filter(i => (i.storeBonus ?? 0) === 0).length),
    Promise.resolve(run.items.filter(i => (i.totalPayable ?? 0) <= 0).length),
  ])

  const blockers: string[] = []
  const warnings: string[] = []

  if (negativeNet > 0) blockers.push(`${negativeNet} 位員工實發 ≤ $0，請先檢查`)
  if (pendingCorrections > 0) warnings.push(`本月有 ${pendingCorrections} 筆補登申請未批 —— 批咗要重新生成先反映`)
  if (pendingLeaves > 0) warnings.push(`本月有 ${pendingLeaves} 筆假期申請未批`)
  if (zeroBonus > 0) warnings.push(`${zeroBonus} 位員工店舖獎金為 $0 —— 確認係咪冇獎金而唔係漏輸`)

  return NextResponse.json({
    periodMonth: pmStr,
    itemCount: run.items.length,
    blockers,
    warnings,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
