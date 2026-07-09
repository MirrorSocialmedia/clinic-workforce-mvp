export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { parseShiftRuleConfig } from '@/lib/shift-rule-config'

// GET /api/clinics/:id/shift-rule-config
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { scope } = auth

  const id = params.id
  if (scope !== 'all' && !scope.includes(id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const clinic = await prisma.clinic.findUnique({ where: { id }, select: { config: true } })
  if (!clinic) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const config = parseShiftRuleConfig(clinic.config)
  return NextResponse.json({ shiftRules: config })
}

// PUT /api/clinics/:id/shift-rule-config
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  // Only OWNER or MANAGER can update
  if (!['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const id = params.id
  const body = await req.json()

  // Read existing config
  const clinic = await prisma.clinic.findUnique({ where: { id }, select: { config: true } })
  if (!clinic) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const existing = clinic.config ? parseShiftRuleConfig(clinic.config) : null
  const existingOtherFields = clinic.config ? (() => {
    try { return JSON.parse(clinic.config) } catch { return {} }
  })() : {}

  // Merge: keep other fields, update shiftRules
  const merged = {
    ...existingOtherFields,
    shiftRules: {
      ...existing,
      ...body,
    },
  }

  await prisma.clinic.update({
    where: { id },
    data: { config: JSON.stringify(merged) },
  })

  const config = parseShiftRuleConfig(JSON.stringify(merged))
  return NextResponse.json({ success: true, shiftRules: config })
}
