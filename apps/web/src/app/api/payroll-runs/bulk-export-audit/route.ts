/**
 * POST /api/payroll-runs/bulk-export-audit — ★ cwm-bulkpayslip-20261003
 * 一鍵匯出全部糧單（瀏覽器端砌 ZIP）完成後寫 audit。PDF 內容本身逐份經員工明細 API
 * （範圍＋保密守衛）攞，呢度只記錄「邊個、幾時、邊個月、邊幾張單、幾多份」。
 */
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const body = await req.json().catch(() => null)
  const periodMonth = typeof body?.periodMonth === 'string' && /^\d{4}-\d{2}$/.test(body.periodMonth) ? body.periodMonth : null
  const runIds: string[] = Array.isArray(body?.runIds) ? body.runIds.filter((x: unknown) => typeof x === 'string').slice(0, 50) : []
  const pdfCount = Number.isFinite(body?.pdfCount) ? Math.max(0, Math.floor(body.pdfCount)) : 0
  const skipped = Number.isFinite(body?.skipped) ? Math.max(0, Math.floor(body.skipped)) : 0
  if (!periodMonth) return NextResponse.json({ error: 'periodMonth (YYYY-MM) 必填' }, { status: 400 })
  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'PAYROLL_BULK_PDF_EXPORT',
      entity: 'PayrollRun',
      entityId: runIds[0] ?? periodMonth,
      notes: `一鍵匯出 ${periodMonth} 薪資明細 PDF：${pdfCount} 份（跳過 ${skipped}），計糧單 ${runIds.join(',')}`,
      ipAddress: req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
    },
  })
  return NextResponse.json({ ok: true })
}
