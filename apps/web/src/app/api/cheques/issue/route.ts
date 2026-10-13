// ============================================================
// ★ cwm-chequeprint-20261005：POST /api/cheques/issue — 攞下一個支票號碼並記錄（只限老闆）
//   body { accountId, month, chequeDate, sourceType, sourceId }
//   收款人同金額由伺服器重新讀（唔信 client）；號碼用戶口 nextNo，跳過已用；計糧嘅票順手寫返 PayrollItem.chequeNo。
//   之後瀏覽器先送去打印機；送唔到 → PATCH /api/cheques/:id { action: 'release' } 退返個號碼。
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { isDate, isMonth, resolveSource, SOURCE_TYPES, type SourceType } from '@/lib/cheque-print/server'
import { ManualChequeError } from '@/lib/cheque-print/manual'
import { issueCheque, HttpError } from '@/lib/cheque-print/issue'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-issue', async () => {
    const b = await req.json().catch(() => ({} as any))
    const { accountId, month, chequeDate, sourceId } = b ?? {}
    const sourceType = SOURCE_TYPES.includes(b?.sourceType) ? (b.sourceType as SourceType) : null
    if (typeof accountId !== 'string' || !isMonth(month) || !isDate(chequeDate) || !sourceType || typeof sourceId !== 'string') {
      return jsonNoStore({ error: '參數唔啱' }, { status: 400 })
    }
    const src = await resolveSource(sourceType, sourceId, accountId, month)
    if (!src.ok) return jsonNoStore({ error: src.error }, { status: 409 })

    try {
      const cheque = await issueCheque(prisma, { accountId, month, chequeDate, sourceType, sourceId, actorId: session.userId }, src)
      return jsonNoStore({
        ok: true,
        cheque: { id: cheque.id, chequeNo: cheque.chequeNo, payeeName: cheque.payeeName, amount: Number(cheque.amount), chequeDate: cheque.chequeDate },
      })
    } catch (e: any) {
      if (e instanceof HttpError || e instanceof ManualChequeError) return jsonNoStore({ error: e.message }, { status: e.status })
      if (e?.code === 'P2002' || /Cheque_active_source_key|unique/i.test(String(e?.message))) {
        return jsonNoStore({ error: '呢筆啱啱已經出咗票，請重新載入' }, { status: 409 })
      }
      throw e
    }
  })
}
