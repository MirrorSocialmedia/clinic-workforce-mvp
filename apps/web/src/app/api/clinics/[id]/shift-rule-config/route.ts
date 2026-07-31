export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { parseShiftRuleConfig } from '@/lib/shift-rule-config'

// GET /api/clinics/:id/shift-rule-config
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope, perms } = auth

  const id = params.id
  // ★ 原本寫 `!scope.includes(id)` —— scope 係字串唔係陣列，永遠 false，
  //   等於所有非 'all' scope 一律 403（MANAGER 都中）。應該查 session.clinics。
  const canRead =
    scope === 'all' ||
    (perms ?? []).includes('scheduling') ||
    (session.clinics ?? []).includes(id)

  if (!canRead) {
    return NextResponse.json({ error: 'Forbidden (clinic not in scope)' }, { status: 403 })
  }

  const clinic = await prisma.clinic.findUnique({ where: { id }, select: { config: true, color: true } })
  if (!clinic) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const config = parseShiftRuleConfig(clinic.config)
  return NextResponse.json({ shiftRules: config, color: clinic.color })
}

// PUT /api/clinics/:id/shift-rule-config
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope, perms } = auth

  // ★ 改用權限判斷（原本 role 寫死繞過權限系統）
  if (!(perms ?? []).includes('scheduling')) {
    return NextResponse.json({ error: 'Forbidden (missing permission: scheduling)' }, { status: 403 })
  }

  const id = params.id
  const canWrite = scope === 'all' || (perms ?? []).includes('scheduling') || (session.clinics ?? []).includes(id)
  if (!canWrite) {
    return NextResponse.json({ error: 'Forbidden (clinic not in scope)' }, { status: 403 })
  }
  const body = await req.json()
  const { color, ...ruleBody } = body

  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return NextResponse.json({ error: '顏色格式錯誤（需為 #RRGGBB）' }, { status: 400 })
  }

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
      ...ruleBody,
    },
  }

  const updated = await prisma.clinic.update({
    where: { id },
    data: {
      config: JSON.stringify(merged),
      ...(color !== undefined ? { color } : {}),
    },
    select: { color: true },
  })

  const config = parseShiftRuleConfig(JSON.stringify(merged))
  return NextResponse.json(
    { success: true, shiftRules: config, color: updated.color },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
}
