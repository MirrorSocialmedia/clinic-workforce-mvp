export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/companies — list companies (with clinic count)
// RBAC: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
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
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  try {
    const body = await req.json()
    if (!body.name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }
    const company = await prisma.company.create({
      data: { name: body.name, logoData: body.logoData || null },
    })
    return NextResponse.json(company, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
