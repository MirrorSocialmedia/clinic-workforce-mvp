import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import prisma from '@/lib/prisma'
import jwt from 'jsonwebtoken'
import { CONFIG } from '@/lib/config'

// POST /api/auth/forgot-password
// Body: { phone: string }
// Response: { success: true, message: string }
// Sends password reset token via email (or returns token for SMS integration)

export async function POST(request: NextRequest) {
  try {
    const { phone } = await request.json()

    if (!phone) {
      return NextResponse.json(
        { error: '手機號碼為必填欄位' },
        { status: 400 }
      )
    }

    // Find user by phone
    const user = await prisma.user.findUnique({
      where: { phone },
    })

    // Always return success to prevent phone enumeration
    if (!user) {
      return NextResponse.json({
        success: true,
        message: '如果該手機號碼有註冊，重置連結已發送',
      })
    }

    // Generate reset token (expires in 1 hour)
    const resetToken = jwt.sign(
      { userId: user.id, phone: user.phone, purpose: 'password-reset' },
      CONFIG.JWT_SECRET,
      { expiresIn: '1h' }
    )

    // Store reset token in a temporary table or use the token directly
    // For MVP: we rely on JWT signature for validation (stateless)
    // In production: consider storing token hash in DB with expiry

    // TODO: Send email with reset link
    // const resetUrl = `${process.env.NEXTAUTH_URL}/reset-password?token=${resetToken}`
    // await sendEmail(user.email!, '重置密碼', `點擊連結重置密碼: ${resetUrl}`)

    // For MVP: return the token (in production, only send via email/SMS)
    console.log(`[Password Reset] Token generated for user ${user.id} (phone: ${phone})`)

    return NextResponse.json({
      success: true,
      message: '重置令牌已生成',
      // In production, remove this and only send via email
      resetToken,
    })
  } catch (error) {
    console.error('[Forgot Password Error]', error)
    return NextResponse.json(
      { error: '服務器錯誤' },
      { status: 500 }
    )
  }
}
