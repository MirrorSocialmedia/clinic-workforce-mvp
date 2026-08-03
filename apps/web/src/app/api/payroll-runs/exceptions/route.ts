export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { toHKDateStr, fmtTime, getMonthRange } from '@/lib/hk-date'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { getEffectivePunches } from '@/lib/punch-query'

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
  const sessionClinics = session.clinics ?? []
  let scopedClinicId: string | undefined = clinicId || undefined
  let scopedClinicIds: string[] | undefined
  const allowedClinics = await resolveClinicScope(session, auth.perms ?? [])

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
  } else if (scope === 'my-clinics') {
    // ★ fallback: scope='my-clinics' 但 allowedClinics=null（唔應該發生，保留舊邏輯）
    if (sessionClinics.length === 0) {
      return NextResponse.json({ exceptions: [], summary: {} })
    }
    if (clinicId) {
      if (!sessionClinics.includes(clinicId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      scopedClinicId = clinicId
    } else {
      scopedClinicIds = sessionClinics
      scopedClinicId = undefined
    }
  }
  // ★ scope='all' 且 allowedClinics=null → 唔限制（OWNER）

  // ★ P2-16: 同引擎口徑一致：只認 configJson.base_type，唔睇 payType 欄；
  // 而且要按計糧月份揀規則（同 generatePayrollRun:857 一樣）
  const activeRules = await prisma.payRule.findMany({
    where: {
      isActive: true,
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    select: { employeeId: true, configJson: true },
  })
  const seen = new Set<string>()
  const hourlyEmpIds = new Set<string>()
  // ★ 每個員工的 pay rule config —— 之前傳空 {} 令 OT 門檻/午休設定全部失效，
  //   總覽同計糧算出兩套唔同數字（OT 門檻 15 變 0、午休卡唔認）
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

  const effectivePunches = await getEffectivePunches(monthStart, monthEnd, {
    clinicId: scopedClinicId,
    clinicIds: scopedClinicIds,
    employeeId: employeeId || undefined,
  })

  // Build employee lookup for raw punch employee data (needed for display)
  const rawPunches = await prisma.punchRecord.findMany({
    where: {
      punchTime: { gte: monthStart, lte: monthEnd },
      void: { is: null },
      ...(scopedClinicId ? { clinicId: scopedClinicId } : scopedClinicIds ? { clinicId: { in: scopedClinicIds } } : {}),
      ...(employeeId ? { employeeId } : {}),
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
  })

  // Map raw punches by raw punch key for employee info lookup
  const rawByTime = new Map<string, typeof rawPunches[0]>()
  for (const rp of rawPunches) {
    const k = `${toHKDateStr(rp.punchTime)}:${rp.clinicId}:${rp.employeeId}:${rp.punchType}`
    rawByTime.set(k, rp)
  }

  const correctionWhere: any = {
    status: 'APPROVED',
    correctedTime: { gte: monthStart, lte: monthEnd },
  }
  if (scopedClinicId) correctionWhere.clinicId = scopedClinicId
  else if (scopedClinicIds !== undefined) correctionWhere.clinicId = { in: scopedClinicIds }
  if (employeeId) correctionWhere.employeeId = employeeId

  const corrections = await prisma.punchCorrection.findMany({
    where: correctionWhere,
    include: {
      employee: {
        include: {
          user: { select: { name: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
        },
      },
    },
  })

  const shiftWhere: any = {
    date: { gte: monthStart, lte: monthEnd },
    status: 'CONFIRMED',
  }
  if (scopedClinicId) shiftWhere.clinicId = scopedClinicId
  else if (scopedClinicIds !== undefined) shiftWhere.clinicId = { in: scopedClinicIds }
  if (employeeId) shiftWhere.employeeId = employeeId

  const shifts = await prisma.shift.findMany({
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
      employee: {
        include: {
          user: { select: { name: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
        },
      },
      clinic: { select: { id: true, name: true } },
    },
  })

  // ★ 有已批假期嘅日子唔算缺勤 —— 計糧路徑（payroll-engine:2260）有做，
  // 呢度之前完全冇讀假期，令請咗假嘅日子照標缺勤。
  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId: { in: [...new Set(shifts.map(s => s.employeeId))] },
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
    date: string; type: 'LATE' | 'EARLY_LEAVE' | 'ABSENT' | 'CORRECTION' | 'OT';
    detail: string; punchTime?: string; correctionTime?: string;
    lateMinutes?: number; earlyMinutes?: number; otMinutes?: number;
    madeUp?: boolean;
    payType?: 'HOURLY' | 'MONTHLY';
    // ABSENT-specific fields
    otDeducted?: boolean;
    shiftMinutes?: number;
  }> = []

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
      s.clinicId === ep.clinicId
    )
    if (matchingShift) {
      const shiftStart = new Date(matchingShift.startTime)
      if (ep.effectiveTime.getTime() > shiftStart.getTime()) {
        const lateMins = Math.ceil((ep.effectiveTime.getTime() - shiftStart.getTime()) / 60000)
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
      s.clinicId === ep.clinicId
    )
    if (matchingShift) {
      const shiftEnd = new Date(matchingShift.endTime)
      if (ep.effectiveTime.getTime() < shiftEnd.getTime()) {
        const earlyMins = Math.ceil((shiftEnd.getTime() - ep.effectiveTime.getTime()) / 60000)
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

  // Batch query OT thresholds from payRules (avoids N+1)
  const uniquePunchEmpIds = [...new Set(effectivePunches.map(ep => ep.raw.employeeId))]
  const rules = await prisma.payRule.findMany({
    where: {
      employeeId: { in: uniquePunchEmpIds },
      isActive: true,
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  })
  const otMinByEmp = new Map<string, number>()
  const otRoundByEmp = new Map<string, number>()
  for (const r of rules) {
    if (otMinByEmp.has(r.employeeId)) continue
    try {
      const cfg = JSON.parse(r.configJson as any)
      otMinByEmp.set(r.employeeId, cfg?.modifiers?.overtime?.ot_min_minutes ?? 0)
      otRoundByEmp.set(r.employeeId, cfg?.modifiers?.overtime?.ot_round_minutes ?? 0)
    } catch {
      otMinByEmp.set(r.employeeId, 0)
      otRoundByEmp.set(r.employeeId, 0)
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
        s.clinicId === ep.clinicId
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

  // Detect ABSENT from shifts with no effective punches
  // ★ 未收工嘅更次唔可以當缺勤。
  // 用 endTime 唔用 date —— 今日 09:00-18:00 嘅更，喺 14:00 睇仲未收工，
  // 員工可能仲喺度返緊工，只係未打落班卡。
  // 如果用 `date < today`，今日已收工嘅早更（09:00-13:00，而家 15:00）
  // 就會漏咗，要等到聽日先標到。
  const nowTs = Date.now()

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
    if (!hasPunch) {
      if (leaveDateSet.has(`${shift.employeeId}:${shiftDayStr}`)) continue // ★ 有假期

      const shiftStart = shift.startTime instanceof Date ? shift.startTime : new Date(shift.startTime)
      const shiftEnd2 = shift.endTime instanceof Date ? shift.endTime : new Date(shift.endTime)
      const shiftMinutes = Math.round((shiftEnd2.getTime() - shiftStart.getTime()) / 60000)
      exceptions.push({
        employeeId: shift.employeeId, employeeName: empNames.get(shift.employeeId) ?? '—',
        clinicName: shift.clinic?.name || '—', date: shiftDayStr, type: 'ABSENT',
        detail: `排班但無打卡記錄 (${toHKDateStr(shift.startTime)})`,
        shiftMinutes,
      })
    }
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
  } catch {
    // timeBankEntry may not exist
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
        ex.madeUp = makeupSet.has(`${ex.employeeId}_${ex.date}_${ex.type}`)
      }
    })
  } catch {}

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
      return {
        employeeId: empId,
        // ★ fallback 用 '—' 唔好用 'Unknown' —— 前者一眼睇得出係缺資料，
        //   後者似係一個真嘅員工名，出事時容易被忽略。
        employeeName: empNames.get(empId) ?? '—',
        payType: payTypeMap.get(empId) || 'MONTHLY',
        timeAccountMinutes: taMinutes,
        otMinutes: tb ? tb.otMinutes : 0,
        owedMinutes: isHourly ? null : (tb ? tb.owedMinutes : null),
        availableMinutes: isHourly ? null : (tb ? tb.availableMinutes : null),
        convertibleLeaveDays: isHourly ? null : (tb ? tb.convertibleLeaveDays : null),
        lateCount: exceptions.filter(e => e.employeeId === empId && e.type === 'LATE').length,
        lateMinutes: exceptions
          .filter(e => e.employeeId === empId && e.type === 'LATE')
          .reduce((s, e) => s + (e.lateMinutes || 0), 0),
        otCount: exceptions.filter(e => e.employeeId === empId && e.type === 'OT').length,
        makeupMinutes: isHourly ? null : (tb ? tb.makeupMinutes : null),
        earlyLeaveCount: exceptions.filter(e => e.employeeId === empId && e.type === 'EARLY_LEAVE').length,
        netEarlyMinutes: isHourly ? null : (tb ? tb.netEarlyMinutes : null),
        earlyLeaveMinutes: exceptions
          .filter(e => e.employeeId === empId && e.type === 'EARLY_LEAVE')
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
    },
    geoAnomalies,
    warnings,
    periodMonth: periodMonth || undefined,
  })
}
