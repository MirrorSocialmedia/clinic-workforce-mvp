import { NextRequest } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { PrismaClient } from '@prisma/client'
import { toHKDateStr } from '@/lib/hk-date'
import { computeRosterHours, rosterDiffNoteFilter } from '@/lib/roster-hours'

export const dynamic = 'force-dynamic'
const prisma = new PrismaClient()

export async function GET(req: NextRequest) {
  const permCheck = await requirePerm(req, 'scheduling')
  if (isAuthError(permCheck)) return permCheck.error

  const month = new URL(req.url).searchParams.get('month') ?? toHKDateStr(new Date()).slice(0, 7)
  const companyId = new URL(req.url).searchParams.get('companyId')
  if (!companyId) return jsonNoStore({ month, rows: [] })

  const employees = await prisma.employee.findMany({
    where: {
      status: 'ACTIVE',
      homeClinic: { companyId },
      payRules: { some: { isActive: true, payType: 'MONTHLY' } }, // ★ 只要月薪
    },
    select: { id: true, user: { select: { name: true } } },
  })

  const map = await computeRosterHours(employees.map(e => e.id), month, prisma)

  // ★ 出咗糧就用已入帳嗰筆 —— 同 api/my/roster-hours 口徑一致
  const settledRows = await prisma.timeBankEntry.findMany({
    where: {
      employeeId: { in: employees.map(e => e.id) },
      type: 'ROSTER_DIFF',
      note: rosterDiffNoteFilter(month),
    },
    select: { employeeId: true, minutes: true },
  })
  const settledMap = new Map(settledRows.map(s => [s.employeeId, s.minutes]))

  return jsonNoStore({
    month,
    rows: employees.map(e => {
      const r = map.get(e.id) ?? { expectedMinutes: 0, rosterMinutes: 0, diffMinutes: 0, unscheduled: false }
      const settled = settledMap.get(e.id)
      return {
        employeeId: e.id,
        name: e.user?.name ?? '—',
        ...r,
        diffMinutes: settled != null ? settled : r.diffMinutes,
        settled: settled != null,
        unscheduled: settled != null ? false : r.unscheduled,
      }
    }).sort((a, b) => {
      if (a.unscheduled !== b.unscheduled) return a.unscheduled ? 1 : -1
      return b.diffMinutes - a.diffMinutes
    }),
  })
}
