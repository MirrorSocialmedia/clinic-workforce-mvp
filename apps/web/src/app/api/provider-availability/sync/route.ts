export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { runAvailabilitySync } from '@/lib/apricot/sync-availability'
import { checkCooldown } from '@/lib/sync-cooldown'

// ============================================================
// POST /api/provider-availability/sync — 前端「立即同步」掣（cw-pta spec §3.1）
//
// ★ requirePerm('scheduling') —— 同 GET 時間表同一個權限（行 RBAC，唔經 cron key）。
// ★ 60s cooldown 按 userId（記憶體 Map；單 instance 夠用，多 instance 要改用 DB；
//   server 重啟清空，可接受）。429 回 { error, retryAfterMs } 俾前端倒數。
// ★ lastSyncAt.set 喺 sync 之前 —— 防 sync 期間狂撳併發打 Apricot
//   （withApricotLock 會擋，但會出一堆「已有 call 進行中」）。
// ★ 行同一個 runAvailabilitySync（同 cron internal route 共用）—— 同步所有
//   已接通 Apricot 嘅診所，唔限選咗嗰間。
// ============================================================

// 記憶體 cooldown（單 instance 夠用；多 instance 要改用 DB）
const lastSyncAt = new Map<string, number>()

export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error

  const userId = auth.session!.userId
  const now = Date.now()
  const decision = checkCooldown(lastSyncAt, userId, now)
  if (!decision.allowed) {
    return NextResponse.json(
      { error: `太頻密，請等 ${Math.ceil((decision.retryAfterMs ?? 0) / 1000)} 秒`, retryAfterMs: decision.retryAfterMs },
      { status: 429 },
    )
  }
  // ★ 記低喺 sync 之前（理由睇上面 header comment）
  lastSyncAt.set(userId, now)

  const outcome = await runAvailabilitySync({})
  return jsonNoStore(outcome)
}
