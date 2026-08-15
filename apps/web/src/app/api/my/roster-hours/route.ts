export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { PrismaClient } from '@prisma/client'
import { toHKDateStr } from '@/lib/hk-date'
import { computeRosterHours } from '@/lib/roster-hours'

const prisma = new PrismaClient()

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  const userId = session.userId

  const employee = await prisma.employee.findUnique({
    where: { userId },
    select: { id: true },
  })
  // ★ 冇 Employee 記錄（純 admin）唔係錯誤 —— 回零值
  if (!employee) return jsonNoStore({ expectedMinutes: 0, rosterMinutes: 0, diffMinutes: 0, settled: false })

  const month = new URL(req.url).searchParams.get('month')
    ?? toHKDateStr(new Date()).slice(0, 7)

  // ★ 出咗糧就顯示已入帳嗰筆，否則即時計
  const settled = await prisma.timeBankEntry.findFirst({
    where: { employeeId: employee.id, type: 'ROSTER_DIFF', note: { contains: `編更差額 ${month}` } },
    select: { minutes: true },
  })

  const map = await computeRosterHours([employee.id], month, prisma)
  const r = map.get(employee.id) ?? { expectedMinutes: 0, rosterMinutes: 0, diffMinutes: 0 }

  return jsonNoStore({
    month,
    expectedMinutes: r.expectedMinutes,
    rosterMinutes: r.rosterMinutes,
    diffMinutes: settled ? settled.minutes : r.diffMinutes,
    settled: !!settled,
  })
}
