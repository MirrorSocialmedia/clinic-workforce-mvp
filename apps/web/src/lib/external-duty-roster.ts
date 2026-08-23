// ============================================================
// Duty roster 核心查詢（external API 共用）— cw-extapi-20260823-a1
//
// 由舊 /api/external/duty-roster route 抽出（A.4 遷移）—— 查詢／合併邏輯
// 一行未改，只搬位置：
//   - GET /api/external/v1/duty-roster（新守門：X-Api-Key scope duty-roster）
//   - 舊 path 302 redirect 去 v1（wa-inbox 未切，唔准刪）
//
// 數據源（全部跟現有「某日某店班表」慣例，有先回、唔硬造）：
//   - Shift（員工）：status != CANCELLED（同 /api/my/schedule 口徑）
//     staffName = employee.user.name；role = shift.role（Doctor/Nurse/Receptionist…）
//   - ProviderShift（醫生）：staffName = provider.name；role = "Doctor"
//   同一人當日兩班（早+午）合併成一行（min start / max end）。
//   date 用 HK 時區（hkDateStart/hkDateEnd），缺省 = 今日（todayHK）。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ── HK 時區 HH:MM（formatter 只建一次）───────────────────────────
const HK_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hong_Kong',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

type DutyRow = {
  staffName: string
  role: string | null
  start: Date
  end: Date
}

export interface DutyRosterRow {
  staffName: string
  role: string | null
  shiftStart: string // HH:MM（HK）
  shiftEnd: string   // HH:MM（HK）
}

export interface DutyRosterLookup {
  clinic: { id: string; shortName: string | null } | null
  rows: DutyRosterRow[]
}

/**
 * clinicCode 接受 shortName 店代號（主，如 旺/仁/銅）或 clinic cuid（compat —
 * 舊 path 302 passthrough 用 clinicId 參數）。
 * 當日無班 → rows = []（200 空陣列語義由 route 決定）。
 */
export async function fetchDutyRoster(
  clinicCode: string,
  dateStr: string,
): Promise<DutyRosterLookup> {
  if (!DATE_RE.test(dateStr)) throw new Error('invalid date')

  const clinic = await basePrisma.clinic.findFirst({
    where: { OR: [{ shortName: clinicCode }, { id: clinicCode }] },
    select: { id: true, shortName: true },
  })
  if (!clinic) return { clinic: null, rows: [] }

  const dayStart = hkDateStart(dateStr)
  const dayEnd = hkDateEnd(dateStr)
  const [empShifts, providerShifts] = await Promise.all([
    basePrisma.shift.findMany({
      where: {
        clinicId: clinic.id,
        date: { gte: dayStart, lte: dayEnd },
        status: { not: 'CANCELLED' },
      },
      select: {
        startTime: true,
        endTime: true,
        role: true,
        employee: { select: { id: true, user: { select: { name: true } } } },
      },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    }),
    basePrisma.providerShift.findMany({
      where: {
        clinicId: clinic.id,
        date: { gte: dayStart, lte: dayEnd },
      },
      select: {
        startTime: true,
        endTime: true,
        provider: { select: { id: true, name: true } },
      },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    }),
  ])

  // 合併同一人當日多班 → 一行（min start / max end；role 取第一非空）
  const byPerson = new Map<string, DutyRow>()
  for (const s of empShifts) {
    const name = s.employee?.user?.name
    if (!name) continue
    const key = `e:${s.employee.id}`
    const cur = byPerson.get(key)
    if (!cur) {
      byPerson.set(key, { staffName: name, role: s.role ?? null, start: s.startTime, end: s.endTime })
    } else {
      if (s.startTime < cur.start) cur.start = s.startTime
      if (s.endTime > cur.end) cur.end = s.endTime
      if (!cur.role && s.role) cur.role = s.role
    }
  }
  for (const s of providerShifts) {
    const name = s.provider?.name
    if (!name) continue
    const key = `p:${s.provider.id}`
    const cur = byPerson.get(key)
    if (!cur) {
      byPerson.set(key, { staffName: name, role: 'Doctor', start: s.startTime, end: s.endTime })
    } else {
      if (s.startTime < cur.start) cur.start = s.startTime
      if (s.endTime > cur.end) cur.end = s.endTime
    }
  }

  const rows = [...byPerson.values()]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map(r => ({
      staffName: r.staffName,
      role: r.role,
      shiftStart: HK_TIME_FMT.format(r.start),
      shiftEnd: HK_TIME_FMT.format(r.end),
    }))

  return { clinic, rows }
}
