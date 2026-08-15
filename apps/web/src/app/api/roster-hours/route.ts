import { NextRequest } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { PrismaClient } from '@prisma/client'
import { toHKDateStr } from '@/lib/hk-date'
import { computeRosterHours } from '@/lib/roster-hours'

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
  return jsonNoStore({
    month,
    rows: employees.map(e => ({
      employeeId: e.id,
      name: e.user?.name ?? '—',
      ...(map.get(e.id) ?? { expectedMinutes: 0, rosterMinutes: 0, diffMinutes: 0 }),
    })).sort((a, b) => b.diffMinutes - a.diffMinutes),
  })
}
