/**
 * POST /api/payout-runs/[id]/lock — 已停用（410）
 * ★ cwm-payaudit-20261006：舊寫法將草稿（例如解鎖咗嘅月結）直接改做 LOCKED，
 *   用嘅係【舊】金額，冇重新計數、冇對數 —— 解鎖後改過嘅成本／SP／轉介會被鎖入但唔計錢。
 *   冇 UI 用緊；要重新鎖定：刪除草稿 → 用「生成並鎖定」（會重新計數＋鎖完對數）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  return NextResponse.json(
    { error: '呢個功能已停用：請刪除草稿月結單，再用「生成並鎖定」重新計數及鎖定' },
    { status: 410 },
  )
}
