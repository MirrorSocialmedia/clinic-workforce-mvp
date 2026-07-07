import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

// ============================================================
// GET /api/hk-public-holidays — List HK public holidays
// All roles
// ============================================================
export async function GET() {
  const holidays = await prisma.hKPublicHoliday.findMany({
    orderBy: { date: 'asc' },
  })
  return NextResponse.json({ holidays })
}
