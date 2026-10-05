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
import { formatNo, isDate, isMonth, resolveSource, SOURCE_TYPES, type SourceType } from '@/lib/cheque-print/server'

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
      const cheque = await prisma.$transaction(async tx => {
        // 鎖住戶口行，兩個分頁同時印都唔會撞號
        await tx.$queryRaw`SELECT id FROM "ChequeAccount" WHERE id = ${accountId} FOR UPDATE`
        const acc = await tx.chequeAccount.findUnique({ where: { id: accountId } })
        if (!acc || !acc.isActive) throw new HttpError(404, '戶口已停用或者唔存在')
        if (acc.nextNo == null) throw new HttpError(409, '未設定支票簿號碼（支票設定）')
        const used = new Set((await tx.cheque.findMany({ where: { accountId }, select: { chequeNo: true } })).map(c => c.chequeNo))
        let n = acc.nextNo
        while (used.has(formatNo(n, acc.noWidth))) n++
        if (acc.bookLastNo != null && n > acc.bookLastNo) throw new HttpError(409, '支票簿用完，請喺支票設定換新簿')
        const chequeNo = formatNo(n, acc.noWidth)
        const row = await tx.cheque.create({
          data: {
            accountId, chequeNo, sourceType, sourceId, periodMonth: month, clinicId: src.clinicId,
            payeeName: src.payee, amount: src.amount, chequeDate, printedBy: session.userId,
          },
        })
        await tx.chequeAccount.update({ where: { id: accountId }, data: { nextNo: n + 1 } })
        if (sourceType === 'PAYROLL_ITEM') {
          await tx.payrollItem.update({ where: { id: sourceId }, data: { chequeNo } })
        }
        await tx.auditLog.create({
          data: {
            actorId: session.userId, action: 'CHEQUE_ISSUE', entity: 'Cheque', entityId: row.id, clinicId: src.clinicId,
            notes: `${acc.label} #${chequeNo} · ${sourceType} · HK$${src.amount.toFixed(2)} · ${chequeDate}`,
          },
        })
        return row
      })
      return jsonNoStore({
        ok: true,
        cheque: { id: cheque.id, chequeNo: cheque.chequeNo, payeeName: cheque.payeeName, amount: Number(cheque.amount), chequeDate: cheque.chequeDate },
      })
    } catch (e: any) {
      if (e instanceof HttpError) return jsonNoStore({ error: e.message }, { status: e.status })
      if (e?.code === 'P2002' || /Cheque_active_source_key|unique/i.test(String(e?.message))) {
        return jsonNoStore({ error: '呢筆啱啱已經出咗票，請重新載入' }, { status: 409 })
      }
      throw e
    }
  })
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
