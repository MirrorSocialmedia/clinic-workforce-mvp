import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { toHKDateStr, getMonthRange } from '@/lib/hk-date'

interface PreflightRun {
  id: string
  periodMonth: Date
  clinicId: string | null
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

  // ★ Cross-clinic guard (2026-08-03): 被限制範圍嘅人唔可以預覽跨店計糧單
  const allowed = await resolveClinicScope(auth.session, auth.perms ?? [], {
    homeOnly: ['payroll_view', 'payroll_generate'],
  })
  if (allowed !== null) {
    if (!raw.clinicId) {
      return NextResponse.json({ error: '你冇權限預覽跨店計糧單' }, { status: 403 })
    }
    if (!allowed.includes(raw.clinicId)) {
      return NextResponse.json({ error: '你冇權限預覽呢間診所嘅計糧單' }, { status: 403 })
    }
  }

  const run = raw
  const pmStr = toHKDateStr(run.periodMonth).slice(0, 7)
  const { start, end } = getMonthRange(run.periodMonth)
  const empIds = run.items.map(i => i.employeeId)

  const [pendingCorrections, pendingLeaves, partialPunches, zeroBonus, negativeNet, zeroNet] = await Promise.all([
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
    Promise.resolve(run.items.filter(i => (i.totalPayable ?? 0) < 0).length),
    Promise.resolve(run.items.filter(i => (i.totalPayable ?? 0) === 0).length),
  ])

  const blockers: string[] = []
  const warnings: string[] = []

  // ★ 月中 preview 提醒 —— absentDays 只計已收工嘅更次（collectWorkData:2258），
  // 所以未到嘅日子唔會扣錢，但都要話畀用家知呢張計糧單未完整。
  const nowTs = Date.now()
  const pendingShifts = await prisma.shift.count({
    where: {
      employeeId: { in: empIds },
      status: 'CONFIRMED',
      date: { gte: start, lte: end },
      endTime: { gt: new Date(nowTs) },
    },
  })
  if (pendingShifts > 0) {
    warnings.push(
      `本月仲有 ${pendingShifts} 個更次未收工 —— 呢張計糧單未完整，` +
      `建議月結後重新生成再確認。`,
    )
  }

  if (negativeNet > 0) blockers.push(`${negativeNet} 位員工實發為負數，請檢查扣減項是否過多`)
  if (zeroNet > 0) warnings.push(`${zeroNet} 位員工實發為 $0（當月無工作記錄）—— 確認係咪應該包含喺呢張計糧單`)
  if (partialPunches > 0) warnings.push(`${partialPunches} 筆打卡記錄未配對到排班（缺卡/多卡）`)
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
