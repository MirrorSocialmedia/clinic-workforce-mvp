export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error as NextResponse
  if (auth.session.role !== 'OWNER') return NextResponse.json({ error: '僅老闆可執行' }, { status: 403 })

  // 1. 找現有全局模板
  const globals = await prisma.shiftTemplate.findMany({ where: { companyId: null, isActive: true } })

  // 2. 找所有公司
  const companies = await prisma.company.findMany()

  let copied = 0
  for (const co of companies) {
    const has = await prisma.shiftTemplate.count({ where: { companyId: co.id } })
    if (has === 0) {
      for (const g of globals) {
        await prisma.shiftTemplate.create({
          data: {
            name: g.name,
            startHour: g.startHour,
            startMinute: g.startMinute,
            endHour: g.endHour,
            endMinute: g.endMinute,
            isNightShift: g.isNightShift,
            shortName: g.shortName,
            isDefault: g.isDefault,
            companyId: co.id,
          },
        })
        copied++
      }
    }
  }

  // 3. 停用舊全局
  const deactivated = await prisma.shiftTemplate.updateMany({
    where: { companyId: null },
    data: { isActive: false },
  })

  return NextResponse.json({ ok: true, copied, deactivated: deactivated.count })
}
