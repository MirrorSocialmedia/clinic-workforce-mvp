export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { createToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { runWithAudit } from '@/lib/audit-context'

export async function POST(req: NextRequest) {
  try {
    const { phone, password, rememberMe } = await req.json()

    if (!phone || !password) {
      return NextResponse.json({ error: 'Phone and password required' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { phone },
      include: { clinics: { include: { clinic: true } } },
    })

    if (!user) return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })

    if (user.status !== 'ACTIVE') return NextResponse.json({ error: 'Account is not active' }, { status: 403 })

    const clinicIds = user.clinics.map((uc: any) => uc.clinic.id)
    const primaryClinicId = user.clinics.find((uc: any) => uc.isPrimary)?.clinicId

    // KIOSK IP enforcement at login
    if (user.role === 'KIOSK' && user.ipAllowlist) {
      const clientIp = (req.headers.get('cf-connecting-ip')
        || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim())
        || 'unknown'
      const allowedIps = user.ipAllowlist.split(',').map(s => s.trim()).filter(Boolean)
      const ok = allowedIps.some(rule => clientIp === rule || clientIp.startsWith(rule))
      if (!ok) return NextResponse.json({ error: '此帳號僅限店舖網絡登入' }, { status: 403 })
    }

    const token = createToken({
      userId: user.id,
      role: user.role,
      clinics: clinicIds,
      primaryClinicId: primaryClinicId || undefined,
      tokenVersion: user.tokenVersion,
    })

    const ip = req.headers.get('x-forwarded-for') || undefined
    const ua = req.headers.get('user-agent') || undefined

    await runWithAudit(
      { actorId: user.id, ip, ua },
      async () => {
        await prisma.auditLog.create({
          data: {
            actorId: user.id,
            action: 'LOGIN',
            entity: 'Session',
            entityId: user.id,
            notes: `Login from ${ip || 'unknown'}`,
            ipAddress: ip || null,
            userAgent: ua || null,
          },
        })
      }
    )

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id, name: user.name, phone: user.phone,
        role: user.role, clinics: clinicIds, primaryClinicId,
      },
    })

    response.cookies.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60,
      path: '/',
    })

    return response
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
