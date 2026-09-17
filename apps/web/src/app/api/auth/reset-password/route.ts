export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

// POST /api/auth/reset-password
// ★ cwm-p0sec-20260917：自助重設暫停；舊 JWT reset token 一律唔收。
//   舊 reset 邏輯（jwt.verify / bcrypt / user.update / audit）已整段剷除 —— 喺 unreachable dead code 入面
//   tsc 唔會做 null-narrowing（TS18047），保留只會埋雷。
export async function POST() {
  return NextResponse.json({ error: '自助重設密碼已停用，請聯絡診所負責人' }, { status: 410 })
}
