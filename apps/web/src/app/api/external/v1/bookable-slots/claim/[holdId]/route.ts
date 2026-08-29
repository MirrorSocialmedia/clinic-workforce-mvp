export const dynamic = 'force-dynamic'
// ============================================================
// DELETE /api/external/v1/bookable-slots/claim/[holdId]（MD 3.3）
// providerslot-20260830 T1 — 病人取消 / 前台放開 → RELEASED
//
//   200 { v:1, holdId, status:"RELEASED", apricotRef }
//   （apricotRef 唔 null = Apricot 邊有單 — caller 要自己清理 Apricot）
//   冪等：已 RELEASED → 200 同狀
//   404 hold 不存在
// 🔴 PII：零回顯。
// ============================================================

import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { releaseHold } from '@/lib/bookable-slots-service'

export async function DELETE(
  req: NextRequest,
  { params }: { params: { holdId: string } },
) {
  return withExternalAudit(req, '/api/external/v1/bookable-slots/release', async (ctx) => {
    const key = await requireExternalKey(req, 'bookable-slots')
    ctx.setKey(key.name)

    const holdId = params.holdId
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(holdId)) {
      throw new ExternalApiError(400, 'holdId invalid', 'BAD_REQUEST')
    }

    const result = await releaseHold(holdId)
    return jsonNoStore({
      v: 1,
      holdId: result.holdId,
      status: result.status,
      apricotRef: result.apricotRef,
    })
  })
}
