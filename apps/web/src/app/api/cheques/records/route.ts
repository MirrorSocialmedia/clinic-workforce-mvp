// ============================================================
// ★ cwm-chequerec-20261005：GET /api/cheques/records?from=&to=&accountId=&kind=&status=&q=
//   支票紀錄（只限老闆；config.ts RBAC = OWNER）—— 每張印過嘅票（連作廢）＋合計
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { parseFilters, summarize, MAX_ROWS } from '@/lib/cheque-print/records-build'
import { loadChequeRecords } from '@/lib/cheque-print/records'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('cheques-records', async () => {
    const parsed = parseFilters(new URL(req.url).searchParams)
    if (!parsed.ok) return jsonNoStore({ error: parsed.error }, { status: 400 })
    const [{ rows, truncated }, accounts] = await Promise.all([
      loadChequeRecords(parsed.filters),
      prisma.chequeAccount.findMany({ select: { id: true, label: true, accountLast4: true }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
    ])
    return jsonNoStore({ rows, summary: summarize(rows), truncated, maxRows: MAX_ROWS, accounts })
  })
}
