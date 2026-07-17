import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const code = String(body.code || '')

  const employee = await prisma.employee.findUnique({ where: { userId: auth.session.userId } })
  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const ec = await prisma.faceEnrollCode.findUnique({ where: { code } })
  if (!ec || ec.employeeId !== employee.id || ec.usedAt || ec.expiresAt < new Date()) {
    return NextResponse.json({ valid: false, error: '登記碼無效、已用過或已過期' }, { status: 400 })
  }
  return NextResponse.json({ valid: true })
}
