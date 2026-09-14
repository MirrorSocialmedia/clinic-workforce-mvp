export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toHKDateStr, getMonthRange, fmtTime } from '@/lib/hk-date'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/attendance/cross-clinic — 異地打卡提醒
// Roles: OWNER, MANAGER（RBAC_PERM_OVERRIDES: attendance_manage）
//
// ★ cwm-crossclinic-20260914：純查詢，唔改任何計算 —— payroll-engine 一分唔郁。
//   病根：payroll-engine.ts:325 按「日+診所」配對打卡；同事排 A 店、喺 B 店落班
//   → 兩邊 entry 都係單腳 isPartial → 工時 0 / OT 0 / 早退唔算。
//   呢個 route 只係列出「邊日要改排班」，改完排班重新計糧先會計返。
//
//   三類（每員工每日一筆 item）：
//   ① UNPAIRED     off-shift 診所 entry 單腳（有入無出／有出無入）→ 配唔成對【最嚴重】
//   ② WRONG_CLINIC off-shift 打卡配到對，但計喺錯診所
//   ③ NO_SHIFT     有打卡但當日完全冇非 CANCELLED 更表
//
//   排除：
//   ① punch.clinicId ∈ 該日 shift 嘅 {clinicId, secondaryClinicId} → 走鋪計劃內，唔算異地
//   ② ACCOUNTANT 免考勤暫代（TODO(cwm-attexempt)：attendanceExempt 未落刀）
//   ③ RESIGNED
//   ④ 已作廢打卡（PunchVoid 1:1 relation → void: null）
//
// ★ 拍板④：唔回任何工時／OT 估算（出咗會俾人當真數）。
// ============================================================

type Kind = 'UNPAIRED' | 'WRONG_CLINIC' | 'NO_SHIFT'

const KIND_RANK: Record<Kind, number> = { UNPAIRED: 0, NO_SHIFT: 1, WRONG_CLINIC: 2 }

interface CrossClinicPunch {
  time: string
  type: string
  clinicId: string
}

interface CrossClinicItem {
  employeeId: string
  employeeName: string
  date: string
  kind: Kind
  shift: {
    clinicName: string
    secondaryClinicName: string | null
    startTime: string
    endTime: string
  } | null
  punches: Array<{ time: string; type: string; clinicName: string; inShift: boolean }>
}

function emptyResponse(month: string) {
  return NextResponse.json(
    { month, items: [], counts: { total: 0, unpaired: 0, wrongClinic: 0, noShift: 0 } },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const month = searchParams.get('month') || toHKDateStr(new Date()).slice(0, 7)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ error: 'month 必須係 YYYY-MM' }, { status: 400 })
  }
  const clinicId = searchParams.get('clinicId') || ''
  const employeeId = searchParams.get('employeeId') || ''

  // ── 診所範圍（同 punches route 同一口徑：MANAGER = my-clinics，DB fresh 快照）──
  const sessionClinics = session.clinics ?? []
  if (scope === 'my-clinics' && sessionClinics.length > 0) {
    if (clinicId && !sessionClinics.includes(clinicId)) {
      return emptyResponse(month) // 指定咗唔屬自己嘅店 → 空清單
    }
  }

  // HK 月範圍（getMonthRange：1日 00:00 HK → 月末 23:59:59.999 HK，15 號做錨一定喺月內）
  const { start, end } = getMonthRange(new Date(`${month}-15T00:00:00+08:00`))

  // 1) 該月非作廢打卡（★ A3：PunchRecord 作廢係 PunchVoid 1:1 relation，非欄位 → void: null）
  const punchWhere: any = {
    punchTime: { gte: start, lte: end },
    void: { is: null },
  }
  if (clinicId) punchWhere.clinicId = clinicId
  else if (scope === 'my-clinics' && sessionClinics.length > 0) punchWhere.clinicId = { in: sessionClinics }
  if (employeeId) punchWhere.employeeId = employeeId

  const punches = await prisma.punchRecord.findMany({
    where: punchWhere,
    select: { id: true, employeeId: true, clinicId: true, punchTime: true, punchType: true },
    orderBy: [{ punchTime: 'asc' }],
  })
  if (punches.length === 0) return emptyResponse(month)

  // 2) 員工 + User（★ A2 ③ RESIGNED 排除；② ACCOUNTANT 免考勤暫代）
  const empIds = [...new Set(punches.map(p => p.employeeId))]
  const employees = await prisma.employee.findMany({
    where: { id: { in: empIds } },
    select: { id: true, status: true, user: { select: { id: true, name: true, role: true } } },
  })
  const empMap = new Map(employees.map(e => [e.id, e]))
  const eligible = (empId: string): boolean => {
    const e = empMap.get(empId)
    if (!e) return false
    if (e.status === 'RESIGNED') return false
    // TODO(cwm-attexempt): cwm-attexempt 落刀後改用 e.attendanceExempt（免考勤員工成日打卡冇更表，唔排除就日日噪音）
    if (e.user.role === 'ACCOUNTANT') return false // ROLE-OK: cwm-attexempt 未落刀 —— 老細 2026-09-14 拍板暫用 ACCOUNTANT 作免考勤暫代（MD A2 ② 明示）
    return true
  }

  const eligibleIds = empIds.filter(eligible)
  if (eligibleIds.length === 0) return emptyResponse(month)

  // 3) 該月非 CANCELLED 更表（★ A2 ① allowed = clinicId + secondaryClinicId）
  const shiftWhere: any = {
    employeeId: { in: eligibleIds },
    date: { gte: start, lte: end },
    status: { not: 'CANCELLED' },
  }
  if (employeeId) shiftWhere.employeeId = employeeId
  const shifts = await prisma.shift.findMany({
    where: shiftWhere,
    select: {
      employeeId: true, clinicId: true, secondaryClinicId: true,
      date: true, startTime: true, endTime: true,
    },
  })

  // 4) 診所名稱
  const clinicIds = new Set<string>()
  for (const p of punches) clinicIds.add(p.clinicId)
  for (const s of shifts) {
    clinicIds.add(s.clinicId)
    if (s.secondaryClinicId) clinicIds.add(s.secondaryClinicId)
  }
  const clinics = await prisma.clinic.findMany({
    where: { id: { in: [...clinicIds] } },
    select: { id: true, name: true },
  })
  const clinicName: Record<string, string> = Object.fromEntries(clinics.map(c => [c.id, c.name]))

  // ── 分組：(員工, HK 日) → 打卡列 ──
  // ★ 劃日口徑同 payroll-engine formatDate 一致（Intl en-CA + Asia/Hong_Kong）
  const dayMap = new Map<string, { empId: string; date: string; punches: CrossClinicPunch[] }>()
  for (const p of punches) {
    if (!eligible(p.employeeId)) continue
    const date = toHKDateStr(p.punchTime)
    const key = `${p.employeeId}:${date}`
    let entry = dayMap.get(key)
    if (!entry) {
      entry = { empId: p.employeeId, date, punches: [] }
      dayMap.set(key, entry)
    }
    entry.punches.push({ time: fmtTime(p.punchTime), type: p.punchType, clinicId: p.clinicId })
  }

  const shiftMap = new Map<string, typeof shifts>()
  for (const s of shifts) {
    const key = `${s.employeeId}:${toHKDateStr(s.date)}`
    const arr = shiftMap.get(key)
    if (arr) arr.push(s)
    else shiftMap.set(key, [s])
  }

  // ── 分類 ──
  const items: CrossClinicItem[] = []

  for (const { empId, date, punches: dayPunches } of dayMap.values()) {
    const emp = empMap.get(empId)!
    const dayShifts = shiftMap.get(`${empId}:${date}`) ?? []

    // ③ NO_SHIFT：有打卡但當日完全冇非 CANCELLED 更表
    if (dayShifts.length === 0) {
      items.push(buildItem('NO_SHIFT', emp, date, [], dayPunches, null, clinicName))
      continue
    }

    // ① allowed = 該日所有 shift 嘅 {clinicId, secondaryClinicId}
    const allowed = new Set<string>()
    for (const s of dayShifts) {
      allowed.add(s.clinicId)
      if (s.secondaryClinicId) allowed.add(s.secondaryClinicId)
    }

    // ★ A2 ①：排除走鋪 —— 只睇入／出腳（lunch 唔係配對腳）
    const offShiftLegs = dayPunches.filter(p => (p.type === 'CLOCK_IN' || p.type === 'CLOCK_OUT') && !allowed.has(p.clinicId))
    if (offShiftLegs.length === 0) continue

    // 配对口徑照 payroll-engine.ts:325：「日+診所」per clinic hasIn/hasOut
    const perClinic = new Map<string, { hasIn: boolean; hasOut: boolean }>()
    for (const p of dayPunches) {
      if (p.type !== 'CLOCK_IN' && p.type !== 'CLOCK_OUT') continue
      const e = perClinic.get(p.clinicId) ?? { hasIn: false, hasOut: false }
      if (p.type === 'CLOCK_IN') e.hasIn = true
      else e.hasOut = true
      perClinic.set(p.clinicId, e)
    }

    const offClinics = [...new Set(offShiftLegs.map(p => p.clinicId))]
    // ★ 保守準則：只要存在「off-shift 單腳」（兩腳分落兩間店）就判 UNPAIRED ——
    //   連「A 有完整入出 + B 單腳」「只喺 B 打咗一隻腳」都算（engine 都會計 0 工時）。
    const hasOffPartial = offClinics.some(c => {
      const e = perClinic.get(c)
      return e && e.hasIn !== e.hasOut
    })
    const kind: Kind = hasOffPartial ? 'UNPAIRED' : 'WRONG_CLINIC'
    // WRONG_CLINIC 邊界：混合日（A allowed 成對 + B off-shift 成對）→ B 嗰對就係「計喺錯診所」，照列。
    items.push(buildItem(kind, emp, date, dayShifts, dayPunches, allowed, clinicName))
  }

  // 排序：UNPAIRED → NO_SHIFT → WRONG_CLINIC，同 kind 日期倒序、再按員工名
  items.sort((a, b) =>
    KIND_RANK[a.kind] - KIND_RANK[b.kind]
    || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
    || a.employeeName.localeCompare(b.employeeName, 'zh-HK'),
  )

  const counts = {
    total: items.length,
    unpaired: items.filter(i => i.kind === 'UNPAIRED').length,
    wrongClinic: items.filter(i => i.kind === 'WRONG_CLINIC').length,
    noShift: items.filter(i => i.kind === 'NO_SHIFT').length,
  }

  return NextResponse.json(
    { month, items, counts },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
}

function buildItem(
  kind: Kind,
  emp: { id: string; user: { name: string } },
  date: string,
  dayShifts: Array<{ clinicId: string; secondaryClinicId: string | null; startTime: Date; endTime: Date }>,
  dayPunches: CrossClinicPunch[],
  allowed: Set<string> | null,
  clinicName: Record<string, string>,
): CrossClinicItem {
  // shift 欄：NO_SHIFT → null；有 shift → 取當日最早開始嗰班
  const primary = dayShifts.length
    ? [...dayShifts].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[0]
    : null
  return {
    employeeId: emp.id,
    employeeName: emp.user.name,
    date,
    kind,
    shift: primary
      ? {
          clinicName: clinicName[primary.clinicId] ?? '',
          secondaryClinicName: primary.secondaryClinicId ? clinicName[primary.secondaryClinicId] ?? '' : null,
          startTime: fmtTime(primary.startTime),
          endTime: fmtTime(primary.endTime),
        }
      : null,
    // 該日全部非 void 打卡（含 allowed 嗰啲 —— UI 對比 ✓/✗）；inShift 由 API 計好
    punches: dayPunches.map(p => ({
      time: p.time,
      type: p.type,
      clinicName: clinicName[p.clinicId] ?? '',
      inShift: allowed ? allowed.has(p.clinicId) : false,
    })),
  }
}
