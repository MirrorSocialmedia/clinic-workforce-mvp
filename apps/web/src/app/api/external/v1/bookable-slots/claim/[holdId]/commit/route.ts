export const dynamic = 'force-dynamic'
// ============================================================
// POST /api/external/v1/bookable-slots/claim/[holdId]/commit（MD 3.3）
// providerslot-20260830 T1 — 前台已入 Apricot → IN_APRICOT
//
//   Body（可空）: { apricotRef? }（Apricot 記錄號，≤128）
//   200 { v:1, holdId, status:"IN_APRICOT", committedAt }
//   冪等：已 IN_APRICOT → 200 同狀
//   404 hold 不存在 ｜ 409 已 RELEASED
// 🔴 PII：零回顯（只 holdId/status/committedAt）。
// ============================================================

import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { commitHold } from '@/lib/bookable-slots-service'

export async function POST(
  req: NextRequest,
  { params }: { params: { holdId: string } },
) {
  return withExternalAudit(req, '/api/external/v1/bookable-slots/commit', async (ctx) => {
    const key = await requireExternalKey(req, 'bookable-slots')
    ctx.setKey(key.name)

    const holdId = params.holdId
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(holdId)) {
      throw new ExternalApiError(400, 'holdId invalid', 'BAD_REQUEST')
    }

    let apricotRef: string | null = null
    try {
      const body = (await req.json()) as Record<string, unknown>
      if (body && typeof body === 'object') {
        const ref = body.apricotRef
        if (ref !== undefined && ref !== null) {
          if (typeof ref !== 'string' || !ref.trim() || ref.trim().length > 128) {
            throw new ExternalApiError(400, 'apricotRef must be a string (<= 128 chars)', 'BAD_REQUEST')
          }
          apricotRef = ref.trim()
        }
      }
    } catch (e) {
      if (e instanceof ExternalApiError) throw e
      // 空 body / 無 body 都准（apricotRef 可選）
    }

    const result = await commitHold(holdId, apricotRef)
    return jsonNoStore({
      v: 1,
      holdId: result.holdId,
      status: result.status,
      committedAt: result.committedAt ? result.committedAt.toISOString() : null,
    })
  })
}
