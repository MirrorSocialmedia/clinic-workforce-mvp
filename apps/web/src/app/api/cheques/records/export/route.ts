// ============================================================
// ★ cwm-chequerec-20261005：GET /api/cheques/records/export?（同 /api/cheques/records 篩選）
//   匯出 Excel：「全部」（連作廢）、「作廢」、「合計」三個 sheet（老闆拍板：作廢要另外一個 sheet）
//   只限老闆；匯出寫 audit CHEQUE_RECORDS_EXPORT（只記篩選同張數，唔記收款人）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { buildRecordsWorkbook, parseFilters } from '@/lib/cheque-print/records-build'
import { loadChequeRecords } from '@/lib/cheque-print/records'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-records-export', async () => {
    const parsed = parseFilters(new URL(req.url).searchParams)
    if (!parsed.ok) return jsonNoStore({ error: parsed.error }, { status: 400 })
    const f = parsed.filters
    const [{ rows, truncated }, account] = await Promise.all([
      loadChequeRecords(f),
      f.accountId ? prisma.chequeAccount.findUnique({ where: { id: f.accountId }, select: { label: true } }) : Promise.resolve(null),
    ])
    if (truncated) return jsonNoStore({ error: '超過 5000 張，請收窄月份或者揀戶口' }, { status: 400 })

    const wb = buildRecordsWorkbook(rows, { filters: f, accountLabel: account?.label ?? null, exportedAt: new Date().toISOString() })
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'CHEQUE_RECORDS_EXPORT',
        entity: 'Cheque',
        entityId: `${f.from}~${f.to}`,
        notes: `${f.from}~${f.to} · ${rows.length} 張（作廢 ${rows.filter(r => r.status === 'VOID').length}）`
          + `${f.accountId ? ` · 戶口 ${account?.label ?? f.accountId}` : ''}${f.kind ? ` · ${f.kind}` : ''}${f.status ? ` · ${f.status}` : ''}`,
        ipAddress: req.headers.get('x-forwarded-for') || null,
        userAgent: req.headers.get('user-agent') || null,
      },
    })

    const range = f.from === f.to ? f.from : `${f.from}_${f.to}`
    const filename = `支票紀錄_${range}.xlsx`
    return new NextResponse(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="cheque-records-${range}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store, must-revalidate',
      },
    })
  })
}
