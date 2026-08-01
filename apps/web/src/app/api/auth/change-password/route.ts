export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import prisma from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// POST /api/auth/change-password
// Body: { currentPassword: string, newPassword: string }
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  try {
    const { currentPassword, newPassword } = await req.json()

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: '目前密碼同新密碼都係必填' }, { status: 400 })
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: '新密碼至少需要 6 個字元' }, { status: 400 })
    }
    if (currentPassword === newPassword) {
      return NextResponse.json({ error: '新密碼唔可以同目前密碼相同' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, password: true },
    })
    if (!user) {
      return NextResponse.json({ error: '帳戶不存在' }, { status: 404 })
    }

    // ★ 一定要驗舊密碼 —— 否則有人趁員工冇鎖屏就可以改走密碼、鎖死帳戶。
    const ok = await bcrypt.compare(currentPassword, user.password)
    if (!ok) {
      // ⚠️ 唔好講「密碼錯」定「帳戶唔存在」—— 統一訊息避免枚舉
      return NextResponse.json({ error: '目前密碼不正確' }, { status: 400 })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(newPassword, 12),
        // ★ 令所有舊 session 失效（包括自己呢一部）——
        //   改密碼嘅目的就係踢走可能被盜用嘅 session。
        tokenVersion: { increment: 1 },
      },
    })

    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'PASSWORD_CHANGE',
        entity: 'User',
        entityId: user.id,
        notes: '用戶自行修改密碼',
        ipAddress: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || null,
        userAgent: req.headers.get('user-agent') || null,
      },
    })

    return NextResponse.json({
      success: true,
      message: '密碼已更新，請重新登入',
      requireRelogin: true,      // ★ 前端見到就清 cookie + 跳登入頁
    })
  } catch (error) {
    console.error('[Change Password Error]', error)
    return NextResponse.json({ error: '服務器錯誤' }, { status: 500 })
  }
}
