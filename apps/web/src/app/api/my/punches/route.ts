export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/my/punches — My punch records
// All roles — returns the current employee's punches
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const where: any = { employeeId: employee.id }

  // ★ 2026-08-04：只接受 'YYYY-MM-DD'（同 my/schedule route）
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  if (from && !DATE_RE.test(from)) {
    return NextResponse.json(
      { error: `日期格式錯誤（需要 YYYY-MM-DD，收到 ${from}）` },
      { status: 400 },
    )
  }
  if (to && !DATE_RE.test(to)) {
    return NextResponse.json(
      { error: `日期格式錯誤（需要 YYYY-MM-DD，收到 ${to}）` },
      { status: 400 },
    )
  }

  if (from) {
    where.punchTime = { gte: hkDateStart(from) }
  }
  if (to) {
    where.punchTime = { ...(where.punchTime || {}), lte: hkDateEnd(to) }
  }

  const punches = await prisma.punchRecord.findMany({
    where: { ...where, void: { is: null } },
    include: { clinic: { select: { id: true, name: true } } },
    orderBy: { punchTime: 'desc' },
    take: 100,
  })

  const corrections = await prisma.punchCorrection.findMany({
    where: { employeeId: employee.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return NextResponse.json({ punches, corrections })
}
