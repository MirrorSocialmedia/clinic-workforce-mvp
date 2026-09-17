export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

// POST /api/auth/forgot-password
// ★ cwm-p0sec-20260917：舊版將 reset token 直接回傳（:55-60），知電話即可接管任何帳號（包括 OWNER）。
//   暫停自助重設；密碼由負責人喺「帳號管理」重設。
export async function POST() {
  return NextResponse.json({ success: true, message: '請聯絡診所負責人重設密碼' })
}
