export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'

// ============================================================
// GET /api/external/duty-roster — 舊 path（MD §A.4）
// cw-extapi-20260823-a1
//
// ★ 302 redirect → /api/external/v1/duty-roster（query 原樣 passthrough —
//   v1 route 接受 clinicId 做 clinicCode 嘅 compat alias）。
//
// 保留原因：wa-inbox 未切新 path（下一階段先切）—— 拍板：未切之前唔准刪。
// 切完後剷呢個 route（同 v1 route 嘅 clinicId compat alias）。
//
// 呢個 redirect 唔含任何數據/認證（auth 喺 v1 target 做）— 唔洩漏任何嘢。
// ============================================================

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const target = new URL('/api/external/v1/duty-roster', url.origin)
  for (const [k, v] of url.searchParams) {
    target.searchParams.set(k, v)
  }
  return NextResponse.redirect(target.toString(), 302)
}
