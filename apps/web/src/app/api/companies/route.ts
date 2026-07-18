export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/companies — list companies (with clinic count)
// RBAC: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const companies = await prisma.company.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { clinics: true } } },
  })
  return NextResponse.json(companies)
}

// POST /api/companies — create company { name }
// RBAC: OWNER only
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  try {
    const body = await req.json()
    if (!body.name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }
    const company = await prisma.company.create({
      data: { name: body.name, logoData: body.logoData || null },
    })

    // Seed default "全日" shift template for the new company
    await prisma.shiftTemplate.create({
      data: {
        name: '全日',
        startHour: 9, startMinute: 0,
        endHour: 18, endMinute: 0,
        isNightShift: false,
        isDefault: true,
        companyId: company.id,
      },
    })

    return NextResponse.json(company, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
