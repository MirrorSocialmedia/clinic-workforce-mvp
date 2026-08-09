export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { toHKDateStr, fmtTime, getMonthRange } from '@/lib/hk-date'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { getEffectivePunches } from '@/lib/punch-query'
import { computeAbsentDeductMinutes } from '@/lib/absent-deduct-minutes'
import { matchPunchesToShifts } from '@/lib/shift-punch-match'
import { computeEarlyInOt, readEarlyInOtCfg } from '@/lib/early-in-ot'

// GET /api/payroll-runs/exceptions — Attendance exceptions report + timebank summaries
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const periodMonth = searchParams.get('periodMonth')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')

  let monthStart: Date
  let monthEnd: Date

  if (startDate && endDate) {
    monthStart = new Date(startDate + 'T00:00:00+08:00')
    monthEnd = new Date(endDate + 'T23:59:59+08:00')
  } else if (periodMonth) {
    // ★ 用 +08:00 建構，避免 server UTC 差 8 小時（P2-15）
    const md = new Date(`${periodMonth}-01T00:00:00+08:00`)
    const range = getMonthRange(md)
    monthStart = range.start
    monthEnd = range.end
  } else {
    return NextResponse.json({ error: 'periodMonth (YYYY-MM) or startDate/endDate is required' }, { status: 400 })
  }

  const monthDate = monthStart

  // ★ 診所範圍檢查 —— 用 resolveClinicScope 取代硬編碼 scope 判斷，
  //   令靠管理權限放行嘅 EMPLOYEE（scope='self'）都可以見到自己店嘅異常報告。（2026-08-03）
  // ★ exceptions 同時畀考勤頁同計糧異常報表用，統一全公司範圍（2026-08-03）——
  // 異常報告只含遲到/缺勤/OT 分鐘，唔含薪金，所以範圍寬啲可以接受。
  // ⚠️ 如果將來加咗金額欄位，就要分開兩個用途。
  let scopedClinicId: string | undefined = clinicId || undefined
  let scopedClinicIds: string[] | undefined
  const allowedClinics = await resolveClinicScope(session, auth.perms ?? [], {
    companyWide: ['attendance_manage', 'scheduling'],
    homeOnly: ['payroll_view', 'payroll_generate'],
  })

  if (allowedClinics !== null) {
    // OWNER/MANAGER 以外嘅範圍限制
    if (allowedClinics.length === 0) {
      return NextResponse.json({ exceptions: [], summary: {} })
    }
    if (clinicId) {
      if (!allowedClinics.includes(clinicId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      scopedClinicId = clinicId
    } else {
      scopedClinicIds = allowedClinics
      scopedClinicId = undefined
    }
  }
  // ★ scope='all' 且 allowedClinics=null → 唔限制（OWNER）

  // ★ C3: Parallelize 5 independent queries
  const correctionWhere: any = {
    status: 'APPROVED',
    correctedTime: { gte: monthStart, lte: monthEnd },
  }
  if (scopedClinicId) correctionWhere.clinicId = scopedClinicId
  else if (scopedClinicIds !== undefined) correctionWhere.clinicId = { in: scopedClinicIds }
  if (employeeId) correctionWhere.employeeId = employeeId

  const shiftWhere: any = {
    date: { gte: monthStart, lte: monthEnd },
    status: 'CONFIRMED',
  }
  // ★ 調鋪斷鏈修復：shiftWhere 加 secondaryClinicId OR
  if (scopedClinicId) {
    shiftWhere.OR = [{ clinicId: scopedClinicId }, { secondaryClinicId: scopedClinicId }]
  } else if (scopedClinicIds !== undefined) {
    shiftWhere.OR = [
      { clinicId: { in: scopedClinicIds } },
      { secondaryClinicId: { in: scopedClinicIds } },
    ]
  }
  if (employeeId) shiftWhere.employeeId = employeeId

  // ★ 打卡按「員工範圍」收窄，唔按打卡地點 —— 調鋪日對面店嘅打卡照拉到
  let scopedEmployeeIds: string[] | undefined = undefined
  if (scopedClinicId || scopedClinicIds !== undefined) {
    const links = await prisma.employeeClinic.findMany({
      where: {
        clinicId: scopedClinicId ? scopedClinicId : { in: scopedClinicIds! },
      },
      select: { employeeId: true },
    })
    scopedEmployeeIds = [...new Set(links.map(l => l.employeeId))]
  }

  const [activeRules, effectivePunches, rawPunches, corrections, shifts] = await Promise.all([
    prisma.payRule.findMany({
      where: {
        isActive: true,
        effectiveFrom: { lte: monthEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: { employeeId: true, configJson: true },
    }),
    getEffectivePunches(monthStart, monthEnd, {
      clinicId: undefined,
      clinicIds: undefined,
      employeeId: employeeId || undefined,
      employeeIds: employeeId ? undefined : scopedEmployeeIds, // ★ 按員工範圍收窄
    }),
    prisma.punchRecord.findMany({
      where: {
        punchTime: { gte: monthStart, lte: monthEnd },
        void: { is: null },
        ...(employeeId ? { employeeId } : scopedEmployeeIds ? { employeeId: { in: scopedEmployeeIds } } : {}),
      },
      include: {
        employee: {
          include: {
            user: { select: { name: true } },
            clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
          },
        },
      },
      orderBy: { punchTime: 'asc' },
    }),
    prisma.punchCorrection.findMany({
      where: correctionWhere,
      include: {
        employee: {
          include: {
            user: { select: { name: true } },
            clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
          },
        },
      },
    }),
    prisma.shift.findMany({
      where: shiftWhere,
      select: {
        id: true,
        employeeId: true,
        clinicId: true,
        secondaryClinicId: true,
        date: true,
        startTime: true,
        endTime: true,
        status: true,
        templateId: true, // ★ 2026-08-07 deductLunch gate
        employee: {
          include: {
            user: { select: { name: true } },
            clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
          },
        },
        clinic: { select: { id: true, name: true } },
      },
    }),
  ])

  // Build lookup maps from parallel results
  const seen = new Set<string>()
  const hourlyEmpIds = new Set<string>()
  const ruleByEmp = new Map<string, any>()
  for (const r of activeRules) {
    if (seen.has(r.employeeId)) continue
    seen.add(r.employeeId)
    let cfg: any = {}
    try {
      cfg = JSON.parse(r.configJson || '{}')
      if (cfg?.base_type === 'hourly') {
        hourlyEmpIds.add(r.employeeId)
      }
    } catch { /* 壞 JSON 當非時薪 */ }
    ruleByEmp.set(r.employeeId, cfg)
  }

  const rawByTime = new Map<string, typeof rawPunches[0]>()
  for (const rp of rawPunches) {
    const k = `${toHKDateStr(rp.punchTime)}:${rp.clinicId}:${rp.employeeId}:${rp.punchType}`
    rawByTime.set(k, rp)
  }

  // ★ leaves depends on shifts + effectivePunches → must stay sequential
  const allShiftAndPunchEmpIds = [...new Set([
    ...shifts.map(s => s.employeeId),
    ...effectivePunches.map(ep => ep.raw.employeeId),
  ])]
  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId: { in: allShiftAndPunchEmpIds },
      status: 'APPROVED',
      startDate: { lte: monthEnd }, // TZ-OK：LeaveRequest 用 UTC 午夜儲存
      endDate: { gte: monthStart },
    },
    select: { employeeId: true, startDate: true, endDate: true },
  })

  const leaveDateSet = new Set<string>()
  for (const lv of leaves) {
    let cur = toHKDateStr(lv.startDate)
    const last = toHKDateStr(lv.endDate)
    while (cur <= last) {
      leaveDateSet.add(`${lv.employeeId}:${cur}`)
      cur = toHKDateStr(new Date(new Date(`${cur}T00:00:00+08:00`).getTime() + 86400000))
    }
  }

  const exceptions: Array<{
    employeeId: string; employeeName: string; clinicName: string;
    date: string; type: 'LATE' | 'EARLY_LEAVE' | 'ABSENT' | 'CORRECTION' | 'OT' | 'EARLY_IN';
    detail: string; punchTime?: string; correctionTime?: string;
    lateMinutes?: number; earlyMinutes?: number; otMinutes?: number;
    madeUp?: boolean;
    lunchLate?: boolean; // ★ 2026-08-07: lunch超時產生的LATE標記
    payType?: 'HOURLY' | 'MONTHLY';
    // ABSENT-specific fields
    otDeducted?: boolean;
    shiftMinutes?: number;
    deductedLunch?: boolean; // ★ 2026-08-08: ABSENT 午飯標示
    // ★ 2026-08-06: 假期返工標記
    leaveWork?: boolean;
    // ★ 2026-08-08: EARLY_IN-specific fields
    earlyInMinutes?: number;
    earlyOtApproved?: boolean;
    earlyOtMinutes?: number;
    earlyOtPreview?: number;
    earlyOtStale?: boolean;
  }> = []

  // ★ 2026-08-07: Build templateId → deductLunch map for gate logic
  const templateDeductLunch = new Map<string, boolean>()
  {
    const templateIds = [...new Set(shifts.map(s => s.templateId).filter((id): id is string => id !== null && id !== undefined))]
    if (templateIds.length > 0) {
      const templates = await prisma.shiftTemplate.findMany({
        where: { id: { in: templateIds } },
        select: { id: true, deductLunch: true },
      })
      templates.forEach(t => templateDeductLunch.set(t.id, t.deductLunch))
    }
  }

  // Build employee info map from raw punches for display names
  const empInfo = new Map<string, { name: string; clinics: Array<{ clinicId: string; clinicName: string }> }>()
  for (const rp of rawPunches) {
    const existing = empInfo.get(rp.employeeId)
    if (!existing) {
      empInfo.set(rp.employeeId, {
        name: rp.employee?.user?.name || '—',
        clinics: rp.employee?.clinics?.map(c => ({ clinicId: c.clinicId, clinicName: c.clinic?.name || c.clinicId })) || [],
      })
    }
  }

  const clockIns = effectivePunches.filter(ep => ep.punchType === 'CLOCK_IN')
  const clockOuts = effectivePunches.filter(ep => ep.punchType === 'CLOCK_OUT')

  // Helper: get employee info for a given employeeId
  function getEmpInfo(eid: string) {
    return empInfo.get(eid) || { name: '—', clinics: [] }
  }
  function getClinicName(eid: string, cid: string) {
    return getEmpInfo(eid).clinics.find(c => c.clinicId === cid)?.clinicName || cid
  }

  // ★ 統一查員工名 —— exceptions / empInfo 都係由「有活動」嘅記錄砌成，
  //   零異常（例如準時返工、或者啱初始化時間帳戶）就攞唔到名，
  //   之前會 fallback 成 'Unknown'（2026-08-03）。
  //   提前喺 exception loops 之前查詢，確保 ABSENT/CORRECTION/summaries 都有名。
  const allEmpIds = [...new Set([
    ...shifts.map(s => s.employeeId),
    ...corrections.map(c => c.employeeId),
    ...rawPunches.map(p => p.employeeId),
  ])]
  const empNames = new Map<string, string>()
  if (allEmpIds.length > 0) {
    const emps = await prisma.employee.findMany({
      where: { id: { in: allEmpIds } },
      select: { id: true, user: { select: { name: true } } },
    })
    emps.forEach(e => empNames.set(e.id, e.user?.name ?? '—'))
  }

  // Detect LATE from effective clock-in punches vs shift start
  for (const ep of clockIns) {
    const punchDateStr = toHKDateStr(ep.effectiveTime)
    // ⚠️ TODO: 改用 matchPunchesToShifts（lib/shift-punch-match.ts）——
    //   而家用 .find() 攞第一張，分更日會配對錯更次。
    //   同 calculateTimeBank 的結果可能不一致。
    const matchingShift = shifts.find(s =>
      s.employeeId === ep.raw.employeeId &&
      toHKDateStr(new Date(s.date)) === punchDateStr &&
      (s.clinicId === ep.clinicId || s.secondaryClinicId === ep.clinicId)
    )
    if (matchingShift) {
      const shiftStart = new Date(matchingShift.startTime)
      if (ep.effectiveTime.getTime() > shiftStart.getTime()) {
        const lateMins = Math.floor((ep.effectiveTime.getTime() - shiftStart.getTime()) / 60000)
        if (lateMins > 0) {
          exceptions.push({
            employeeId: ep.raw.employeeId, employeeName: getEmpInfo(ep.raw.employeeId).name,
            clinicName: getClinicName(ep.raw.employeeId, ep.clinicId),
            date: punchDateStr,
            type: 'LATE',
            lateMinutes: lateMins,
            detail: `遲到 ${lateMins} 分鐘 (排班 ${fmtTime(shiftStart.toISOString())})`,
            punchTime: ep.effectiveTime.toISOString(),
          })
        }
      }
    }
  }

  // Detect EARLY_LEAVE from effective clock-out punches vs shift end
  for (const ep of clockOuts) {
    const punchDateStr = toHKDateStr(ep.effectiveTime)
    // ⚠️ TODO: 改用 matchPunchesToShifts（lib/shift-punch-match.ts）——
    //   而家用 .find() 攞第一張，分更日會配對錯更次。
    //   同 calculateTimeBank 的結果可能不一致。
    const matchingShift = shifts.find(s =>
      s.employeeId === ep.raw.employeeId &&
      toHKDateStr(new Date(s.date)) === punchDateStr &&
      (s.clinicId === ep.clinicId || s.secondaryClinicId === ep.clinicId)
    )
    if (matchingShift) {
      const shiftEnd = new Date(matchingShift.endTime)
      if (ep.effectiveTime.getTime() < shiftEnd.getTime()) {
        const earlyMins = Math.floor((shiftEnd.getTime() - ep.effectiveTime.getTime()) / 60000)
        if (earlyMins > 0) {
          exceptions.push({
            employeeId: ep.raw.employeeId, employeeName: getEmpInfo(ep.raw.employeeId).name,
            clinicName: getClinicName(ep.raw.employeeId, ep.clinicId),
            date: punchDateStr,
            type: 'EARLY_LEAVE',
            earlyMinutes: earlyMins,
            detail: `早退 ${earlyMins} 分鐘 (${fmtTime(shiftEnd.toISOString())})`,
            punchTime: ep.effectiveTime.toISOString(),
          })
        }
      }
    }
  }

  // ★ C2: otMin/otRound derived from ruleByEmp (already loaded above) — skip duplicate payRule query
  const otMinByEmp = new Map<string, number>()
  const otRoundByEmp = new Map<string, number>()
  for (const [empId, cfg] of ruleByEmp) {
    otMinByEmp.set(empId, cfg?.modifiers?.overtime?.ot_min_minutes ?? 0)
    otRoundByEmp.set(empId, cfg?.modifiers?.overtime?.ot_round_minutes ?? 0)
  }

  // ★ 2026-08-06: lunch config from ruleByEmp (Fix 2 + Fix 4 shared)
  const lunchDefaultByEmp = new Map<string, number>()
  const lunchEnabledByEmp = new Map<string, boolean>()
  for (const [empId, cfg] of ruleByEmp) {
    const lunch = cfg?.modifiers?.lunch_break ?? {}
    lunchEnabledByEmp.set(empId, !!lunch.enabled)
    lunchDefaultByEmp.set(empId, lunch.defaultMinutes ?? 60)
  }

  // ★ 2026-08-06: lunch pair detection (Fix 2)
  // Group effective punches by employee+HK date for LUNCH_START/LUNCH_END pairs
  const lunchPunchesByEmpDate = new Map<string, any[]>()
  for (const ep of effectivePunches) {
    if (ep.punchType !== 'LUNCH_START' && ep.punchType !== 'LUNCH_END') continue
    const key = `${ep.raw.employeeId}|${toHKDateStr(ep.effectiveTime)}`
    if (!lunchPunchesByEmpDate.has(key)) lunchPunchesByEmpDate.set(key, [])
    lunchPunchesByEmpDate.get(key)!.push(ep)
  }

  // ★ 2026-08-07: Build emp+date → deductLunch map for gate
  const empDateDeductsLunch = new Map<string, boolean>()
  for (const shift of shifts) {
    const ds = toHKDateStr(new Date(shift.date))
    const key = `${shift.employeeId}|${ds}`
    if (!empDateDeductsLunch.has(key)) empDateDeductsLunch.set(key, false)
    const ded = shift.templateId
      ? templateDeductLunch.get(shift.templateId) !== false
      : true // no template = deduct
    if (ded) empDateDeductsLunch.set(key, true)
  }

  for (const [key, lunchPunches] of lunchPunchesByEmpDate) {
    const [empId, dateStr] = key.split('|')
    // ★ 2026-08-07: deductLunch gate — skip lunch OT/LATE detection if day doesn't deduct
    const dayDed = empDateDeductsLunch.get(`${empId}|${dateStr}`) ?? true
    if (!dayDed) continue
    const lunchCfg = ruleByEmp.get(empId)?.modifiers?.lunch_break
    if (!lunchCfg?.enabled) continue

    const ls = lunchPunches
      .filter((p: any) => p.punchType === 'LUNCH_START')
      .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
    const le = lunchPunches
      .filter((p: any) => p.punchType === 'LUNCH_END')
      .sort((a: any, b: any) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]
    if (!ls || !le) continue

    const actualMins = Math.floor((le.effectiveTime.getTime() - ls.effectiveTime.getTime()) / 60000)
    if (actualMins <= 0) continue
    const minMins = lunchCfg.minMinutes ?? 30
    const effectiveMins = Math.max(actualMins, minMins)
    const defaultMins = lunchCfg.defaultMinutes ?? 60

    if (effectiveMins < defaultMins) {
      const shortfall = defaultMins - effectiveMins
      exceptions.push({
        employeeId: empId, employeeName: empNames.get(empId) ?? '—',
        clinicName: getEmpInfo(empId).clinics[0]?.clinicName || '—',
        date: dateStr, type: 'OT',
        otMinutes: shortfall,
        detail: `午休提早返 ${shortfall} 分鐘 (OT)`,
        punchTime: le.effectiveTime.toISOString(),
      })
    } else if (effectiveMins > defaultMins) {
      const excess = effectiveMins - defaultMins
      exceptions.push({
        employeeId: empId, employeeName: empNames.get(empId) ?? '—',
        clinicName: getEmpInfo(empId).clinics[0]?.clinicName || '—',
        date: dateStr, type: 'LATE',
        lunchLate: true, // ★ 2026-08-07: lunch超時產生的LATE
        lateMinutes: excess,
        detail: `午休超時 ${excess} 分鐘`,
        punchTime: le.effectiveTime.toISOString(),
      })
    }
  }

  // OT 偵測：下班晚於排班結束 (use effectiveTime) — with per-day threshold
  for (const ep of clockOuts) {
    const punchDateStr = toHKDateStr(ep.effectiveTime)
    // ⚠️ TODO: 改用 matchPunchesToShifts（lib/shift-punch-match.ts）——
    //   而家用 .find() 攞第一張，分更日會配對錯更次。
    //   同 calculateTimeBank 的結果可能不一致。
    const matchingShift = shifts.find(
      s =>
        s.employeeId === ep.raw.employeeId &&
        toHKDateStr(new Date(s.date)) === punchDateStr &&
        (s.clinicId === ep.clinicId || s.secondaryClinicId === ep.clinicId)
    )
    if (matchingShift) {
      const shiftEnd = new Date(matchingShift.endTime)
      if (ep.effectiveTime.getTime() > shiftEnd.getTime()) {
        const otMins = Math.floor((ep.effectiveTime.getTime() - shiftEnd.getTime()) / 60000)
        const minReq = otMinByEmp.get(ep.raw.employeeId) ?? 0
        const roundReq = otRoundByEmp.get(ep.raw.employeeId) ?? 0
        if (otMins > 0 && otMins >= minReq) {
          const displayOt = roundReq > 0 ? Math.floor(otMins / roundReq) * roundReq : otMins
          exceptions.push({
            employeeId: ep.raw.employeeId, employeeName: getEmpInfo(ep.raw.employeeId).name,
            clinicName: getClinicName(ep.raw.employeeId, ep.clinicId),
            date: punchDateStr,
            type: 'OT',
            otMinutes: displayOt,
            detail: `OT ${displayOt} 分鐘`,
            punchTime: ep.effectiveTime.toISOString(),
          })
        }
      }
    }
  }

  // ★ 2026-08-06: Leave-work OT detection (Fix 3 display)
  // APPROVED leave day + complete punch pair (IN+OUT) → OT
  // Single punch (only IN or only OUT) → no OT, marked incomplete
  const leavePunchesByEmpDate = new Map<string, any[]>()
  for (const ep of effectivePunches) {
    if (ep.punchType !== 'CLOCK_IN' && ep.punchType !== 'CLOCK_OUT') continue
    const key = `${ep.raw.employeeId}|${toHKDateStr(ep.effectiveTime)}`
    if (!leavePunchesByEmpDate.has(key)) leavePunchesByEmpDate.set(key, [])
    leavePunchesByEmpDate.get(key)!.push(ep)
  }

  for (const [key, punches] of leavePunchesByEmpDate) {
    const [empId, dateStr] = key.split('|')
    if (!leaveDateSet.has(`${empId}:${dateStr}`)) continue

    const hasIn = punches.some((p: any) => p.punchType === 'CLOCK_IN')
    const hasOut = punches.some((p: any) => p.punchType === 'CLOCK_OUT')

    if (hasIn && hasOut) {
      // Complete pair → OT
      const firstIn = punches.filter((p: any) => p.punchType === 'CLOCK_IN')
        .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
      const lastOut = punches.filter((p: any) => p.punchType === 'CLOCK_OUT')
        .sort((a: any, b: any) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]
      const pairMins = Math.floor((lastOut.effectiveTime.getTime() - firstIn.effectiveTime.getTime()) / 60000)
      if (pairMins <= 0) continue

      const minReq = otMinByEmp.get(empId) ?? 0
      const roundReq = otRoundByEmp.get(empId) ?? 0
      let displayOt = pairMins
      if (displayOt >= minReq) {
        displayOt = roundReq > 0 ? Math.floor(displayOt / roundReq) * roundReq : displayOt
      } else {
        displayOt = 0
      }

      exceptions.push({
        employeeId: empId, employeeName: empNames.get(empId) ?? '—',
        clinicName: getEmpInfo(empId).clinics[0]?.clinicName || '—',
        date: dateStr, type: 'OT',
        otMinutes: displayOt,
        detail: `假期返工 OT ${displayOt} 分鐘`,
        punchTime: lastOut.effectiveTime.toISOString(),
        leaveWork: true,
      })
    } else {
      // Single punch → incomplete, no OT
      exceptions.push({
        employeeId: empId, employeeName: empNames.get(empId) ?? '—',
        clinicName: getEmpInfo(empId).clinics[0]?.clinicName || '—',
        date: dateStr, type: 'OT',
        otMinutes: 0,
        detail: '假期返工·打卡不完整',
        punchTime: punches[0].effectiveTime.toISOString(),
        leaveWork: true,
      })
    }
  }

  // Detect ABSENT from shifts with no effective punches
  // ★ 未收工嘅更次唔可以當缺勤。
  // 用 endTime 唔用 date —— 今日 09:00-18:00 嘅更，喺 14:00 睇仲未收工，
  // 員工可能仲喺度返緊工，只係未打落班卡。
  // 如果用 `date < today`，今日已收工嘅早更（09:00-13:00，而家 15:00）
  // 就會漏咗，要等到聽日先標到。
  // ★ 2026-08-08: 按日 group + 用 computeAbsentDeductMinutes lib（單一來源），
  //   解決孖更日出現兩行 ABSENT（每行各扣一次午飯）嘅問題。
  const nowTs = Date.now()

  // Phase 1: Group absent shifts by employeeId + date
  const absentByDay = new Map<string, Array<typeof shifts[number]>>()
  for (const shift of shifts) {
    const shiftEnd = shift.endTime instanceof Date ? shift.endTime : new Date(shift.endTime)
    if (shiftEnd.getTime() > nowTs) continue // ★ 未收工，跳過

    const shiftDayStr = toHKDateStr(new Date(shift.date))
    const hasPunch = effectivePunches.some(ep =>
      ep.raw.employeeId === shift.employeeId &&
      toHKDateStr(ep.effectiveTime) === shiftDayStr &&
      // ★ 調鋪：主店同副店嘅打卡都算（同 payroll-engine:2200 一致）
      (ep.clinicId === shift.clinicId || ep.clinicId === shift.secondaryClinicId)
    )
    if (hasPunch) continue
    if (leaveDateSet.has(`${shift.employeeId}:${shiftDayStr}`)) continue // ★ 有假期

    const key = `${shift.employeeId}:${shiftDayStr}`
    if (!absentByDay.has(key)) absentByDay.set(key, [])
    absentByDay.get(key)!.push(shift)
  }

  // Phase 2: One ABSENT row per day, using shared lib
  for (const [key, dayShifts] of absentByDay) {
    const [empId, dateStr] = key.split(':')
    const clinicName = dayShifts.length === 1
      ? dayShifts[0].clinic?.name || '—'
      : `${dayShifts[0].clinic?.name || '—'}（${dayShifts.length} 更）`

    const { minutes: deductedMinutes, deductedLunch } = computeAbsentDeductMinutes(
      dayShifts.map(s => ({
        startTime: s.startTime,
        endTime: s.endTime,
        template: s.templateId
          ? { deductLunch: templateDeductLunch.get(s.templateId) }
          : undefined,
      })),
      lunchDefaultByEmp.get(empId) ?? 60, // 對齊 engine:1488 同 absent-deduct
    )

    exceptions.push({
      employeeId: empId, employeeName: empNames.get(empId) ?? '—',
      clinicName, date: dateStr, type: 'ABSENT',
      detail: `排班但無打卡記錄 (${dayShifts.length} 更，應返 ${deductedMinutes} 分鐘${deductedLunch ? '·已扣午飯' : '·未扣午飯'})`,
      shiftMinutes: deductedMinutes,
      deductedLunch,
    })
  }

  // 查詢 ABSENT 類型的扣OT鐘記錄（標記 otDeducted）
  try {
    const absentEmpIds = [...new Set(exceptions.filter(e => e.type === 'ABSENT').map(e => e.employeeId))]
    if (absentEmpIds.length > 0) {
      const absentEntries = await prisma.timeBankEntry.findMany({
        where: {
          type: 'MAKEUP',
          targetType: 'ABSENT',
          date: { gte: monthStart, lte: monthEnd },
          employeeId: { in: absentEmpIds },
        },
      })
      const absentSet = new Map<string, number>()
      for (const e of absentEntries) {
        absentSet.set(`${e.employeeId}_${toHKDateStr(new Date(e.date))}`, Math.abs(e.minutes))
      }
      exceptions.forEach(ex => {
        if (ex.type === 'ABSENT') {
          const key = `${ex.employeeId}_${ex.date}`
          if (absentSet.has(key)) {
            ex.otDeducted = true
            ex.shiftMinutes = absentSet.get(key)!
          } else {
            ex.otDeducted = false
          }
        }
      })
    }
  } catch (e) {
    // timeBankEntry may not exist — log but don't fail
    console.error('[exceptions] timeBankEntry absent query failed:', e)
  }

  // ★ 2026-08-08: EARLY_IN 偵測 —— 由 matchPunchesToShifts 結果入面攞 earlyInMinutes
  try {
    // Group shifts by employeeId + date for matching
    const shiftsByEmpDate = new Map<string, typeof shifts>()
    for (const s of shifts) {
      const key = `${s.employeeId}|${toHKDateStr(new Date(s.date))}`
      if (!shiftsByEmpDate.has(key)) shiftsByEmpDate.set(key, [])
      shiftsByEmpDate.get(key)!.push(s)
    }

    // Group effective punches by employeeId + date
    const punchesByEmpDate = new Map<string, typeof effectivePunches>()
    for (const ep of effectivePunches) {
      const key = `${ep.raw.employeeId}|${toHKDateStr(ep.effectiveTime)}`
      if (!punchesByEmpDate.has(key)) punchesByEmpDate.set(key, [])
      punchesByEmpDate.get(key)!.push(ep)
    }

    // Check for EARLY_IN_OT entries for approval status
    const earlyInEntries = await prisma.timeBankEntry.findMany({
      where: {
        type: 'EARLY_IN_OT',
        date: { gte: monthStart, lte: monthEnd },
      },
    })
    const earlyInSet = new Map<string, any>()
    for (const e of earlyInEntries) {
      earlyInSet.set(`${e.employeeId}_${toHKDateStr(new Date(e.date))}`, e)
    }

    // For each employee+date with both shifts and punches, compute earlyInMinutes
    for (const [key, dayShifts] of shiftsByEmpDate) {
      const [empId, dateStr] = key.split('|')
      const dayPunches = punchesByEmpDate.get(key)
      if (!dayPunches || dayPunches.length === 0) continue

      const matched = matchPunchesToShifts(dayShifts as any, dayPunches as any)
      const rawEarly = matched.reduce((max, m) => Math.max(max, m.earlyInMinutes ?? 0), 0)
      if (rawEarly <= 0) continue

      // Skip HOURLY employees
      if (hourlyEmpIds.has(empId)) continue

      // Get payRule config for threshold calculation
      const cfg = readEarlyInOtCfg(ruleByEmp.get(empId) ?? {})
      const finalMinutes = computeEarlyInOt(rawEarly, cfg)
      if (finalMinutes <= 0) continue // Under threshold — no row needed

      // Check existing entry
      const entry = earlyInSet.get(`${empId}_${dateStr}`)

      // Recompute to check staleness
      const recomputed = finalMinutes // Same computation as approval
      const isStale = !!entry && entry.minutes !== recomputed

      // Find a clinic name from the shifts
      // ★ Get earliest CLOCK_IN effective time for punchTime matching
      const clockInPunch = dayPunches
        .filter((p: any) => p.punchType === 'CLOCK_IN')
        .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
      const clinicName = dayShifts[0]?.clinic?.name || '—'

      exceptions.push({
        employeeId: empId,
        employeeName: empNames.get(empId) ?? '—',
        clinicName,
        date: dateStr,
        type: 'EARLY_IN',
        detail: `提早上班 ${rawEarly} 分（實得 ${finalMinutes} 分）`,
        punchTime: clockInPunch?.effectiveTime.toISOString(),
        earlyInMinutes: rawEarly,
        earlyOtApproved: !!entry,
        earlyOtMinutes: entry?.minutes ?? 0,
        earlyOtPreview: finalMinutes,
        earlyOtStale: isStale,
        payType: 'MONTHLY',
      })
    }
  } catch (e) {
    console.error('[exceptions] early-in detection failed:', e)
  }

  const TYPE_LABEL: Record<string, string> = {
    CLOCK_IN: '上班', CLOCK_OUT: '下班',
    LUNCH_START: '午休開始', LUNCH_END: '午休結束'
  }

  for (const c of corrections) {
    const clinic = c.employee?.clinics?.find(cl => cl.clinicId === c.clinicId)?.clinic
    exceptions.push({
      employeeId: c.employeeId, employeeName: empNames.get(c.employeeId) ?? '—',
      clinicName: clinic?.name || c.clinicId,
      date: toHKDateStr(c.correctedTime), type: 'CORRECTION',
      detail: `補登 ${TYPE_LABEL[c.punchType] || c.punchType} 至 ${fmtTime(c.correctedTime)}${c.reason ? ` (${c.reason})` : ''}`,
      correctionTime: c.correctedTime.toISOString(),
    })
  }

  // 抓補鐘記錄，標記 madeUp（按日期+類型，避免連坐）
  try {
    const empIds = [...new Set(exceptions.map(e => e.employeeId))]
    const makeupEntries = await prisma.timeBankEntry.findMany({
      where: {
        type: 'MAKEUP',
        date: { gte: monthStart, lte: monthEnd },
        employeeId: { in: empIds },
      },
    })
    const makeupSet = new Set(
      (makeupEntries || []).map((e: any) => `${e.employeeId}_${toHKDateStr(new Date(e.date))}_${e.targetType}`)
    )
    exceptions.forEach(ex => {
      if (ex.type === 'LATE' || ex.type === 'EARLY_LEAVE') {
        const matchType = (ex as any).lunchLate ? 'LATE_LUNCH' : ex.type
        ex.madeUp = makeupSet.has(`${ex.employeeId}_${ex.date}_${matchType}`)
      }
    })
  } catch (e) {
    console.error('[exceptions] makeup entries query failed:', e)
  }

  // Set payType on all exceptions
  exceptions.forEach(ex => {
    ex.payType = hourlyEmpIds.has(ex.employeeId) ? 'HOURLY' : 'MONTHLY'
  })

  // ★ 位置異常都應該入計糧前檢查 —— 而家只有人手開考勤頁先睇到
  const empIds = [...new Set(exceptions.map(e => e.employeeId))]
  const geoAnomalies = await prisma.punchRecord.count({
    where: {
      employeeId: { in: empIds },
      punchTime: { gte: monthStart, lte: monthEnd },
      locationFlag: { in: ['OUT_OF_RANGE', 'DENIED'] },
      void: { is: null },
    },
  })
  const warnings: string[] = []
  if (geoAnomalies > 0) {
    warnings.push(`本月有 ${geoAnomalies} 筆打卡位置異常（超出範圍或拒絕定位）`)
  }

  exceptions.sort((a, b) => b.date.localeCompare(a.date))

  // Compute per-employee timebank summaries — include ALL employees with punch/shift data (not just those with exceptions)
  const punchEmpIds = rawPunches.map(p => p.employeeId)
  const shiftEmpIds = shifts.map(s => s.employeeId)
  let uniqueEmployeeIds = [...new Set([...punchEmpIds, ...shiftEmpIds, ...exceptions.map(e => e.employeeId)])]
  if (employeeId && !uniqueEmployeeIds.includes(employeeId)) {
    uniqueEmployeeIds.push(employeeId)
  }
  // empNames already defined earlier (after getClinicName) — covers all employees
  // from shifts, corrections, and raw punches.

  // Fix #2a: excluded HOURLY from exception detection; keep them in summaries with payType
  const empPayRules = await prisma.payRule.findMany({
    where: {
      isActive: true,
      employeeId: { in: uniqueEmployeeIds },
    },
    select: { employeeId: true, payType: true },
  })
  const payTypeMap = new Map(empPayRules.map(r => [r.employeeId, r.payType]))

  // ★ C4: Group exceptions by employee for O(1) lookup instead of 5× linear .filter()
  const exByEmp = new Map<string, any[]>()
  for (const e of exceptions) {
    const a = exByEmp.get(e.employeeId)
    if (a) a.push(e)
    else exByEmp.set(e.employeeId, [e])
  }

  const employeeSummaries = await Promise.all(
    uniqueEmployeeIds.map(async (empId) => {
      const isHourly = (payTypeMap.get(empId) || 'MONTHLY') === 'HOURLY'
      let tb: any = null
      let status: 'ok' | 'not_applicable' | 'error' = isHourly ? 'not_applicable' : 'ok'
      try {
        tb = await calculateTimeBank(empId, monthDate, ruleByEmp.get(empId) ?? {}, prisma)
      } catch (err) {
        console.error(`[exceptions] calculateTimeBank failed for employee ${empId}`, err)
        status = 'error'
      }
      const taMinutes = isHourly ? null : (tb ? (tb.timeAccountMinutes ?? (tb.availableMinutes - tb.owedMinutes)) : null)
      const mine = exByEmp.get(empId) ?? []
      return {
        employeeId: empId,
        // ★ fallback 用 '—' 唔好用 'Unknown' —— 前者一眼睇得出係缺資料，
        //   後者似係一個真嘅員工名，出事時容易被忽略。
        employeeName: empNames.get(empId) ?? '—',
        payType: payTypeMap.get(empId) || 'MONTHLY',
        timeAccountMinutes: taMinutes,
        otMinutes: tb ? tb.otMinutes : 0,
        earlyInOtMinutes: tb ? (tb.earlyInOtMinutes ?? 0) : 0,
        otMinutesForAccount: tb ? (tb.otMinutesForAccount ?? tb.otMinutes) : 0,
        owedMinutes: isHourly ? null : (tb ? tb.owedMinutes : null),
        availableMinutes: isHourly ? null : (tb ? tb.availableMinutes : null),
        convertibleLeaveDays: isHourly ? null : (tb ? tb.convertibleLeaveDays : null),
        lateCount: mine.filter(e => e.type === 'LATE').length,
        lateMinutes: mine
          .filter(e => e.type === 'LATE')
          .reduce((s, e) => s + (e.lateMinutes || 0), 0),
        otCount: mine.filter(e => e.type === 'OT').length,
        earlyInCount: mine.filter(e => e.type === 'EARLY_IN').length,
        makeupMinutes: isHourly ? null : (tb ? tb.makeupMinutes : null),
        earlyLeaveCount: mine.filter(e => e.type === 'EARLY_LEAVE').length,
        netEarlyMinutes: isHourly ? null : (tb ? tb.netEarlyMinutes : null),
        earlyLeaveMinutes: mine
          .filter(e => e.type === 'EARLY_LEAVE')
          .reduce((s, e) => s + (e.earlyMinutes || 0), 0),
        status,
      }
    })
  )

  return NextResponse.json({
    exceptions,
    summaries: employeeSummaries,
    employeeSummaries,
    summary: {
      total: exceptions.length,
      late: exceptions.filter(e => e.type === 'LATE').length,
      absent: exceptions.filter(e => e.type === 'ABSENT').length,
      correction: exceptions.filter(e => e.type === 'CORRECTION').length,
      earlyLeave: exceptions.filter(e => e.type === 'EARLY_LEAVE').length,
      earlyIn: exceptions.filter(e => e.type === 'EARLY_IN').length,
    },
    geoAnomalies,
    warnings,
    periodMonth: periodMonth || undefined,
  })
}
