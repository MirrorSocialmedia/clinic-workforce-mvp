export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { createToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { runWithAudit } from '@/lib/audit-context'

// ★ Rate limit：15 分鐘同 IP 8 次失敗 → 429
// 單一 app container，用 in-memory 足夠；重啟清空可接受
const FAIL_WINDOW_MS = 15 * 60 * 1000
const FAIL_MAX = 8
const failMap = new Map<string, number[]>()

function getClientIp(req: NextRequest): string {
  return (req.headers.get('cf-connecting-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim())
    || 'unknown'
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const arr = (failMap.get(ip) ?? []).filter(t => now - t < FAIL_WINDOW_MS)
  failMap.set(ip, arr)
  return arr.length >= FAIL_MAX
}

function recordFail(ip: string): void {
  const now = Date.now()
  const arr = (failMap.get(ip) ?? []).filter(t => now - t < FAIL_WINDOW_MS)
  arr.push(now)
  failMap.set(ip, arr)
  if (failMap.size > 5000) {
    for (const [k, v] of failMap) {
      if (v.every(t => now - t >= FAIL_WINDOW_MS)) failMap.delete(k)
    }
  }
}

// ★ 恆定時間：冇該帳號都行一次 bcrypt，唔畀 timing 枚舉電話號碼
const DUMMY_HASH = '$2a$10$ZD94RXO./tnVZFju0vmV5uf3hKIAgI83aH5rl8YQ1MqsAEiPlxE66'

export async function POST(req: NextRequest) {
  try {
    const { phone, password, rememberMe } = await req.json()

    if (!phone || !password) {
      return NextResponse.json({ error: 'Phone and password required' }, { status: 400 })
    }

    const ip = getClientIp(req)
    if (isRateLimited(ip)) {
      return NextResponse.json({ error: '嘗試次數過多，請 15 分鐘後再試' }, { status: 429 })
    }

    const user = await prisma.user.findUnique({
      where: { phone },
      include: { clinics: { include: { clinic: true } } },
    })

    // ★ 恆定時間比較：user 存在或唔存在都跑 bcrypt
    const valid = user
      ? await bcrypt.compare(password, user.password)
      : await bcrypt.compare(password, DUMMY_HASH)

    if (!user || !valid) {
      recordFail(ip)
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    if (user.status !== 'ACTIVE') return NextResponse.json({ error: 'Account is not active' }, { status: 403 })

    const clinicIds = user.clinics.map((uc: any) => uc.clinic.id)
    const primaryClinicId = user.clinics.find((uc: any) => uc.isPrimary)?.clinicId

    // KIOSK IP enforcement at login
    if (user.role === 'KIOSK' && user.ipAllowlist) { // ROLE-OK
      const clientIp = (req.headers.get('cf-connecting-ip')
        || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim())
        || 'unknown'
      const allowedIps = user.ipAllowlist.split(',').map(s => s.trim()).filter(Boolean)
      const ok = allowedIps.some(rule => clientIp === rule || clientIp.startsWith(rule))
      if (!ok) return NextResponse.json({ error: '此帳號僅限店舖網絡登入' }, { status: 403 })
    }

    // ★ 決定 7：唔勾 = 關咗瀏覽器就登出（session cookie），JWT 亦只簽 1 日
    const maxAgeDays = rememberMe === false ? 1 : CONFIG.SESSION_MAX_AGE_DAYS
    const token = createToken({
      userId: user.id,
      role: user.role,
      clinics: clinicIds,
      primaryClinicId: primaryClinicId || undefined,
      tokenVersion: user.tokenVersion,
    }, maxAgeDays)

    const loginIp = req.headers.get('x-forwarded-for') || undefined
    const ua = req.headers.get('user-agent') || undefined

    await runWithAudit(
      { actorId: user.id, ip: loginIp, ua },
      async () => {
        await prisma.auditLog.create({
          data: {
            actorId: user.id,
            action: 'LOGIN',
            entity: 'Session',
            entityId: user.id,
            notes: `Login from ${loginIp || 'unknown'}`,
            ipAddress: loginIp || null,
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
      ...(rememberMe === false ? {} : { maxAge: CONFIG.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 }),
      path: '/',
    })

    return response
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
