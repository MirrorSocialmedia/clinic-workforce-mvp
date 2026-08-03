export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { hkDateStart, hkDateEnd, toHKDateStr } from '@/lib/hk-date'

// ============================================================
// GET /api/my/schedule — My upcoming schedule
// All roles — returns the current employee's shifts
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const includeCoworkers = searchParams.get('includeCoworkers') === 'true'

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const where: any = {
    employeeId: employee.id,
    // ★ 取消咗嘅更次唔應該顯示
    status: { not: 'CANCELLED' },
  }

  if (from) {
    where.startTime = { gte: hkDateStart(from) }
  } else {
    // ★ 2026-08-02：預設由【今日 00:00】起，唔係【當前時刻】
    where.startTime = { gte: hkDateStart(toHKDateStr(new Date())) }
  }

  if (to) {
    where.startTime = { ...where.startTime, lte: hkDateEnd(to) }
  } else {
    // ★ 預設上限：30 日（避免拉晒未來全部）
    const thirtyDays = toHKDateStr(new Date(Date.now() + 30 * 86400000))
    where.startTime = { ...where.startTime, lte: hkDateEnd(thirtyDays) }
  }

  const shifts = await prisma.shift.findMany({
    where,
    include: {
      clinic: { select: { id: true, name: true, address: true, shortName: true } },
      template: { select: { id: true, name: true } },
      employee: {
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { startTime: 'asc' },
    take: 50,
  })

  // ★ Coworker shifts — include secondaryClinic for cross-clinic shifts (7c)
  let coworkerShifts: any[] = []
  if (includeCoworkers && shifts.length > 0) {
    // ★ 調鋪日員工會喺兩間店出現
    const clinicIds = [...new Set(
      shifts.flatMap((s) => [s.clinicId, s.secondaryClinicId]).filter((v): v is string => Boolean(v)),
    )]
    const dates = shifts.map(s => s.startTime)
    const minDate = new Date(Math.min(...dates.map(d => new Date(d).getTime())))
    const maxDate = new Date(Math.max(...dates.map(d => new Date(d).getTime())))
    maxDate.setUTCDate(maxDate.getUTCDate() + 1) // inclusive

    if (clinicIds.length > 0) {
      const allShifts = await prisma.shift.findMany({
        where: {
          // ★ 對方張更嘅主店【或】副店喺範圍內都算
          OR: [
            { clinicId: { in: clinicIds } },
            { secondaryClinicId: { in: clinicIds } },
          ],
          employeeId: { not: employee.id },
          status: { not: 'CANCELLED' },
          startTime: { gte: minDate, lte: maxDate },
        },
        include: {
          clinic: { select: { id: true, name: true, shortName: true } },
          template: { select: { id: true, name: true } },
          employee: {
            include: {
              user: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { startTime: 'asc' },
        take: 200,
      })

      // ★ Resolve coworker secondary clinic names
      const coworkerSecIds = [...new Set(allShifts.map((s) => s.secondaryClinicId).filter((v): v is string => Boolean(v)))]
      let coworkerSecMap = new Map()
      if (coworkerSecIds.length) {
        const coworkerSecClinics = await prisma.clinic.findMany({
          where: { id: { in: coworkerSecIds } },
          select: { id: true, name: true, shortName: true },
        })
        coworkerSecMap = new Map(coworkerSecClinics.map(c => [c.id, c]))
      }

      coworkerShifts = allShifts.map(s => {
        const sec = s.secondaryClinicId ? coworkerSecMap.get(s.secondaryClinicId) : null
        return {
          id: s.id,
          date: toHKDateStr(new Date(s.startTime)),
          startTime: s.startTime,
          endTime: s.endTime,
          employeeName: s.employee?.user?.name || '未知',
          templateName: s.template?.name || '',
          clinicName: s.clinic?.name || '',
          clinicShortName: s.clinic?.shortName || s.clinic?.name || '',
          secondaryClinicName: sec?.name || null,
          secondaryClinicShortName: sec?.shortName || sec?.name || null,
          isCrossClinic: !!s.secondaryClinicId,
        }
      })
    }
  }

  // ★ Resolve secondary clinic names (no Prisma relation — raw string field)
  const secondaryClinicIds = [...new Set(shifts.map((s) => s.secondaryClinicId).filter((v): v is string => Boolean(v)))]
  const secondaryClinics = secondaryClinicIds.length
    ? await prisma.clinic.findMany({
        where: { id: { in: secondaryClinicIds } },
        select: { id: true, name: true, shortName: true },
      })
    : []
  const secondaryClinicMap = new Map(secondaryClinics.map(c => [c.id, c]))

  const formattedShifts = shifts.map(s => {
    const secClinic = s.secondaryClinicId ? secondaryClinicMap.get(s.secondaryClinicId) : null
    return {
      ...s,
      date: toHKDateStr(new Date(s.startTime)),
      startTime: s.startTime,
      endTime: s.endTime,
      employeeName: s.employee?.user?.name || '',
      templateName: s.template?.name || '',
      clinicName: s.clinic?.name || '',
      clinicShortName: s.clinic?.shortName || s.clinic?.name || '',
      secondaryClinicName: secClinic?.name || null,
      secondaryClinicShortName: secClinic?.shortName || secClinic?.name || null,
      isCrossClinic: !!s.secondaryClinicId,
    }
  })

  if (includeCoworkers) {
    return NextResponse.json({ myShifts: formattedShifts, coworkerShifts })
  }

  return NextResponse.json({ shifts: formattedShifts })
}
