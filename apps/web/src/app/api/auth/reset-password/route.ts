export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import prisma from '@/lib/prisma'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { CONFIG } from '@/lib/config'

// POST /api/auth/reset-password
// Body: { token: string, newPassword: string }
// Response: { success: true, message: string }

export async function POST(request: NextRequest) {
  try {
    const { token, newPassword } = await request.json()

    // Validate inputs
    if (!token || !newPassword) {
      return NextResponse.json(
        { error: 'token 和新密碼為必填欄位' },
        { status: 400 }
      )
    }

    // Password strength check
    if (newPassword.length < 6) {
      return NextResponse.json(
        { error: '密碼至少需要 6 個字元' },
        { status: 400 }
      )
    }

    // Verify reset token
    let decoded: any
    try {
      decoded = jwt.verify(token, CONFIG.JWT_SECRET)
    } catch {
      return NextResponse.json(
        { error: '重置連結已過期或無效' },
        { status: 400 }
      )
    }

    // Check token purpose
    if (decoded.purpose !== 'password-reset') {
      return NextResponse.json(
        { error: '無效的重置令牌' },
        { status: 400 }
      )
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    })

    if (!user) {
      return NextResponse.json(
        { error: '用戶不存在' },
        { status: 404 }
      )
    }

    // Hash new password and update
    const hashedPassword = await bcrypt.hash(newPassword, 12)
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    })

    // Log the password reset in audit log
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'PASSWORD_RESET',
        entity: 'User',
        entityId: user.id,
        notes: '密碼已重置',
        ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null,
        userAgent: request.headers.get('user-agent') || null,
      },
    })

    return NextResponse.json({
      success: true,
      message: '密碼已重置成功，請使用新密碼登入',
    })
  } catch (error) {
    console.error('[Reset Password Error]', error)
    return NextResponse.json(
      { error: '服務器錯誤' },
      { status: 500 }
    )
  }
}
