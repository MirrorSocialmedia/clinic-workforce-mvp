export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

const MAX_LEN = 20

// GET /api/schedule-notes?companyId=xxx&startDate=2026-08-01&endDate=2026-08-31
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const sp = new URL(req.url).searchParams
  const companyId = sp.get('companyId')
  const startDate = sp.get('startDate')
  const endDate = sp.get('endDate')

  if (!companyId) return NextResponse.json({ notes: [] }, { headers: { 'Cache-Control': 'no-store' } })

  const notes = await prisma.scheduleNote.findMany({
    where: {
      companyId,
      // ★ date is string, lexicographic order = date order (YYYY-MM-DD format guaranteed)
      ...(startDate && endDate ? { date: { gte: startDate, lte: endDate } } : {}),
    },
    select: { id: true, date: true, text: true, row: true },
  })

  return NextResponse.json({ notes }, { headers: { 'Cache-Control': 'no-store, must-revalidate' } })
}

// PUT /api/schedule-notes  { companyId, date, text }
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { companyId, date, text, row = 0 } = await req.json()

  if (!companyId || !date) {
    return NextResponse.json({ error: '缺少 companyId 或 date' }, { status: 400 })
  }
  // ★ Date format validation — prevent non-YYYY-MM-DD writes (would break range queries)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: '日期格式錯誤' }, { status: 400 })
  }
  // ★ row validation
  if (!Number.isInteger(row) || row < 0 || row > 5) {
    return NextResponse.json({ error: 'row 必須係 0-5' }, { status: 400 })
  }

  const clean = String(text ?? '').trim()
  if (clean.length > MAX_LEN) {
    return NextResponse.json({ error: `備註最多 ${MAX_LEN} 字` }, { status: 400 })
  }

  // ★ Empty = delete, don't leave empty string rows
  if (!clean) {
    await prisma.scheduleNote.deleteMany({ where: { companyId_date_row: { companyId, date, row } } })
    return NextResponse.json({ ok: true, deleted: true }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const note = await prisma.scheduleNote.upsert({
    where: { companyId_date_row: { companyId, date, row } },
    update: { text: clean, createdBy: session.userId },
    create: { companyId, date, row, text: clean, createdBy: session.userId },
  })

  return NextResponse.json({ note }, { headers: { 'Cache-Control': 'no-store' } })
}
