import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma, createAuditLog } from '@/lib/prisma'
import { createToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { setAuditContext } from '@/lib/audit-context'

export async function POST(req: NextRequest) {
  try {
    const { phone, password } = await req.json()

    if (!phone || !password) {
      return NextResponse.json({ error: 'Phone and password required' }, { status: 400 })
    }

    // Find user by phone
    const user = await prisma.user.findUnique({
      where: { phone },
      include: {
        clinics: {
          include: { clinic: true },
        },
      },
    })

    if (!user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Check password
    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Check status
    if (user.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'Account is not active' }, { status: 403 })
    }

    // Set audit context
    setAuditContext(user.id, req.headers.get('x-forwarded-for') || '', req.headers.get('user-agent') || '')

    const clinicIds = user.clinics.map((uc: any) => uc.clinic.id)
    const primaryClinicId = user.clinics.find((uc: any) => uc.isPrimary)?.clinicId

    const token = createToken({
      userId: user.id,
      role: user.role,
      clinics: clinicIds,
      primaryClinicId: primaryClinicId || undefined,
    })

    // Write audit log for login
    await createAuditLog({
      action: 'LOGIN',
      entity: 'Session',
      entityId: user.id,
      notes: `Login from ${req.headers.get('x-forwarded-for') || 'unknown'}`,
    })

    // Set cookie
    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        clinics: clinicIds,
        primaryClinicId,
      },
    })

    response.cookies.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: CONFIG.SESSION_MAX_AGE_DAYS * 24 * 60 * 60,
      path: '/',
    })

    return response
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
