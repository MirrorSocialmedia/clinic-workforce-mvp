export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (auth.error) return auth.error

  const sp = req.nextUrl.searchParams
  const startDate = sp.get('startDate')
  const endDate = sp.get('endDate')
  const clinicId = sp.get('clinicId') || undefined

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'startDate / endDate 必填' }, { status: 400 })
  }

  try {
    const shifts = await prisma.providerShift.findMany({
      where: {
        date: { gte: hkDateStart(startDate), lte: hkDateEnd(endDate) },
        ...(clinicId ? { clinicId } : {}),
      },
      include: {
        provider: { select: { id: true, name: true, shortName: true, color: true } },
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
    })
    return jsonNoStore({ shifts })
  } catch (e) {
    console.error('[provider-shifts] GET failed', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
