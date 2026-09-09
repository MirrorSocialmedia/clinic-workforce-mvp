export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, canSeeConfidential } from '@/lib/scope-helpers'
import { getMonthRange, periodMonthKey, toHKDateStr, hkDaysInMonth, addDaysStr } from '@/lib/hk-date'
import { estimateScheduledHours } from '@/lib/shift-punch-match'
import { PAY_RULE_LATEST } from '@/lib/pay-rule-latest'
// ★ cwm-tbledger-20260909 S5（F 章）：時間帳戶明細統一讀共用 ledger builder（同員工總覽同一把尺）
import { buildTimeBankLedger, type LedgerMonth } from '@/lib/timebank-ledger'

// GET /api/payroll-runs/[id]/employee/[empId] — Single employee payroll detail
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; empId: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const item = await prisma.payrollItem.findUnique({
    where: { runId_employeeId: { runId: params.id, employeeId: params.empId } },
    include: {
      run: {
        include: {
          clinic: {
            select: {
              id: true,
              name: true,
              company: { select: { name: true, logoData: true, legalName: true } },
            },
          },
        },
      },
      employee: {
        select: {
          payConfidential: true,
          homeClinicId: true,
          user: { select: { id: true, name: true, phone: true, fullName: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
          // ★ cwm-tbfix-20260910 P1-2：最新生效 pay rule 統一口徑（lib/pay-rule-latest）
          payRules: PAY_RULE_LATEST,
        },
      },
    },
  })

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // ★ 診所範圍檢查 —— 唔可以用 assertClinicAccess（佢對 scope='self' 一律 403，
  //   令靠 payroll_* 權限放行嘅 EMPLOYEE 入唔到）。
  //   改用 resolveClinicScope：OWNER/MANAGER → null（全公司）、
  //   有權限嘅 EMPLOYEE → [主屬店]。（2026-08-03）
  // ★ Cross-clinic guard (2026-08-03): 被限制範圍嘅人唔可以查看跨店計糧單
  const allowedClinics = await resolveClinicScope(session, auth.perms ?? [], {
    homeOnly: ['payroll_view', 'payroll_generate'],
  })
  if (allowedClinics !== null) {
    if (!item.run?.clinicId) {
      return NextResponse.json({ error: '你冇權限查看跨店計糧單' }, { status: 403 })
    }
    if (!allowedClinics.includes(item.run.clinicId)) {
      return NextResponse.json({ error: '你冇權限查看呢間診所嘅計糧單' }, { status: 403 })
    }
  }

  // ★ 保密判斷（訊息要同診所範圍分開）
  const emp = { payConfidential: item.employee.payConfidential, homeClinicId: item.employee.homeClinicId }
  if (!(await canSeeConfidential(session, auth.perms ?? [], emp))) {
    return NextResponse.json({ error: '此員工薪資已設保密' }, { status: 403 })
  }

  const detail = item.detailJson ? JSON.parse(item.detailJson) : null

  const periodStart = new Date(item.run.periodMonth)
  const { end: periodEnd } = getMonthRange(periodStart)

  const punches = await prisma.punchRecord.findMany({
    where: { employeeId: params.empId, punchTime: { gte: periodStart, lte: periodEnd }, void: { is: null } },
    include: { clinic: { select: { id: true, name: true, shortName: true } } },
    orderBy: { punchTime: 'asc' },
    take: 100,
  })

  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId: params.empId, status: 'APPROVED',
      startDate: { lte: periodEnd }, endDate: { gte: periodStart },
    },
    include: { leaveType: { select: { name: true, isPaid: true, systemKey: true } } },
  })

  const corrections = await prisma.punchCorrection.findMany({
    where: {
      employeeId: params.empId, status: 'APPROVED',
      correctedTime: { gte: periodStart, lte: periodEnd },
    },
    orderBy: { correctedTime: 'asc' },
  })

  // ★ 2026-08-15: 編更差額資料（改用 estimateScheduledHours 扣午飯）
  const [shifts, payRules] = await Promise.all([
    prisma.shift.findMany({
      where: { employeeId: params.empId, date: { gte: periodStart, lte: periodEnd }, status: { not: 'CANCELLED' } },
      select: { employeeId: true, date: true, startTime: true, endTime: true, status: true, template: { select: { deductLunch: true } } },
    }),
    prisma.payRule.findMany({
      // ★ cwm-tbfix-20260910 P1-2：同上面 relation select 同一口徑（lib/pay-rule-latest）
      where: { employeeId: params.empId, ...PAY_RULE_LATEST.where },
      orderBy: PAY_RULE_LATEST.orderBy,
      take: PAY_RULE_LATEST.take,
      select: { employeeId: true, configJson: true },
    }),
  ])

  // ★ Build lunch minutes map from PayRule config
  const lunchMinutesMap = new Map<string, number>()
  for (const r of payRules) {
    try {
      const cfg = JSON.parse(r.configJson || '{}')
      lunchMinutesMap.set(r.employeeId, cfg?.modifiers?.lunch_break?.defaultMinutes ?? 60)
    } catch {
      lunchMinutesMap.set(r.employeeId, 60)
    }
  }

  // 取 APPROVED 假期（去重）
  const periodStartStr = toHKDateStr(periodStart)
  const periodEndStr = toHKDateStr(periodEnd)
  const leaveDates = new Set<string>()
  for (const lr of leaves) {
    let d = toHKDateStr(lr.startDate)
    const end = toHKDateStr(lr.endDate)
    while (d <= end) {
      if (d >= periodStartStr && d <= periodEndStr) leaveDates.add(d)
      d = addDaysStr(d, 1)
    }
  }

  const daysInMonth = hkDaysInMonth(periodStart)
  const expectedMinutes = (daysInMonth - leaveDates.size) * 9 * 60 // 9h default

  const leaveDateSet = new Set(
    Array.from(leaveDates).map(d => `${params.empId}:${d}`)
  )

  const perDay = estimateScheduledHours(shifts as any, id => lunchMinutesMap.get(id) ?? 60)
  let rosterSpanMinutes = 0
  for (const [, days] of perDay) {
    for (const d of days) {
      if (leaveDateSet.has(`${params.empId}:${d.date}`)) continue
      rosterSpanMinutes += d.hours * 60
    }
  }
  rosterSpanMinutes = Math.round(rosterSpanMinutes)

  // ★ cwm-tbledger-20260909 S5（F 章）：時間帳戶明細統一讀共用 ledger builder ——
  //   舊嘅「自己查 TimeBankEntry（TB_DISPLAY_TYPES）＋ live TimeBank 對數」兩套並存 = 坑②，此處收埋。
  //   同員工總覽（S3 讀取 API）同一把尺：
  //   · 有 TimeBankLedgerSnapshot（finalize 凍結）→ 讀凍結 lines（frozen:true）＝「証明」口徑；
  //   · 冇 snapshot → buildTimeBankLedger 即時算（frozen:false）＝舊 live 口徑（未 finalize 月行為不變）。
  //   帳本行齊晒：推導行（原始遲到/早退，同糧單七種一致）＋實體行（RESTDAY_GRANT 唔喺 ledger，
  //   假期另一本帳）＋informational 0 分行（遲到/早退補鐘已抵銷）＋RECONCILE 未分類差額。
  const pmKey = periodMonthKey(item.run.periodMonth)
  let ledger: LedgerMonth | null = null
  try {
    // ★ 補丁A：時薪唔設時間帳戶 → ledger 維持 null（UI 卡片 fallback 返 detailJson、新行唔渲染）。
    //   時薪員工冇 TimeBankEntry，live build 會回全 0 帳本，誤畫「兩清」卡。
    const cfg = payRules[0]?.configJson ? (JSON.parse(payRules[0].configJson) as any) : {}
    if (cfg?.base_type !== 'hourly') {
      const snap = await prisma.timeBankLedgerSnapshot.findUnique({
        where: { employeeId_periodMonth: { employeeId: params.empId, periodMonth: pmKey } },
      })
      if (snap) {
        let snapLines: any[] = []
        try { snapLines = JSON.parse(snap.linesJson) } catch { snapLines = [] }
        const snapSum = snapLines.reduce((s: number, l: any) => s + (Number(l.minutes) || 0), 0)
        ledger = {
          periodMonth: pmKey,
          opening: snap.opening,
          closing: snap.closing,
          lines: snapLines,
          // 凍結後都要重算對數 —— snapshot 加唔埋就標紅（唔好盲信）
          reconciles: snap.opening + snapSum === snap.closing,
          frozen: true,
          frozenAt: snap.frozenAt.toISOString(),
          engineVersion: snap.engineVersion,
        }
      } else {
        ledger = await buildTimeBankLedger(prisma, params.empId, pmKey, cfg)
      }
    }
  } catch (e) {
    // 即時算失敗唔阻擋頁面 —— ledger=null → 時間帳戶明細區塊隱藏（舊 D3 退化語義）
    console.error('[payroll-emp-detail] timebank ledger 解析失敗，明細區塊退化隱藏', e)
  }

  // ★ PunchCorrection has clinicId but no Clinic relation — fetch clinic names separately
  const clinicIds = [...new Set(corrections.map((c: any) => c.clinicId).filter(Boolean))]
  const clinicsMap = new Map<string, { name: string; shortName: string | null }>()
  if (clinicIds.length > 0) {
    const clinics = await prisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: { id: true, name: true, shortName: true },
    })
    for (const c of clinics) clinicsMap.set(c.id, { name: c.name, shortName: c.shortName })
  }

  return NextResponse.json({
    item,
    detail, punches, leaves, corrections,
    clinicsMap: Object.fromEntries(clinicsMap),
    periodMonth: periodMonthKey(item.run.periodMonth),
    // ★ 編更差額
    rosterSpanMinutes,
    expectedMinutes,
    rosterDiffMinutes: rosterSpanMinutes - expectedMinutes,
    // ★ cwm-tbledger-20260909 S5（F 章）：時間帳戶帳本（snapshot 優先 + 對數行 reconciles）
    timeBankLedger: ledger,
  }, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}
