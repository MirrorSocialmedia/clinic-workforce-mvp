// ★ cwm-labdoc P2：POST /api/lab-docs/:id/retry — EXTRACT_FAILED 再讀（§5.1／§11）
//
//  - 只准 EXTRACT_FAILED（其他狀態 400）
//  - 讀單服務未設（WA_INBOX_LABDOC_URL／INTERNAL_LLM_SECRET）→ 503「讀單服務未設定，請人手輸入」
//    （§11：503 只喺「再讀」時回；上傳時嘅背景讀單 fail 靜靜入 EXTRACT_FAILED）
//  - 人手再讀 = 一輪新嘅 3 次上限：claim 時重置 extractAttempts=0
//    （sweep 路徑從唔重置 — 防 attempts 永遠清零無限重試）
//  - ★ 2026-10-13：有人手改／加嘅月結單行 → 409 MANUAL_LINES（body { confirmManual: true } 先讀）
//  - ★ 2026-10-11：EXTRACT_FAILED → UPLOADED（重新排到隊尾，queuedAt = now）→ 叫醒排隊 worker
export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { kickLabDocQueue } from '@/lib/labdoc/extract'
import { labdocScope, kioskDocGuard } from '@/lib/labdoc/kiosk-scope'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  // ★ KIOSK 只可以處理自己店嘅單（kiosk-scope.ts）
  const kioskDeny = await kioskDocGuard(session, params.id)
  if (kioskDeny) return kioskDeny
  const { id } = params

  // §10.3 fail-closed（跟 P1 [id] 口徑）：lab 權限 = 全集團；其餘按診所範圍
  const scope = await labdocScope(session, perms)
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以再讀單據' }, { status: 403, headers: { 'cache-control': 'no-store' } })
  }

  const doc = await prisma.labDocument.findUnique({ where: { id: id }, select: { id: true, status: true, clinicId: true } })
  if (!doc) {
    return NextResponse.json({ error: '單據唔存在' }, { status: 404, headers: { 'cache-control': 'no-store' } })
  }
  if (scope !== null && !(doc.clinicId && scope.includes(doc.clinicId))) {
    return NextResponse.json({ error: '冇權限操作呢間診所嘅單據' }, { status: 403, headers: { 'cache-control': 'no-store' } })
  }

  // §11：讀單服務未設定 → 503（只喺「再讀」時回）
  if (!process.env.WA_INBOX_LABDOC_URL || !process.env.INTERNAL_LLM_SECRET) {
    return NextResponse.json({ error: '讀單服務未設定，請人手輸入' }, { status: 503 })
  }

  if (doc.status !== 'EXTRACT_FAILED') {
    return NextResponse.json({ error: '只有讀單失敗嘅單據可以再讀' }, { status: 400 })
  }

  // ★ 2026-10-13（用家拍板 3）：有人手改／加嘅月結單行 → 再讀會清走，先問用家（body.confirmManual=true 先讀）
  const manualLines = await prisma.labStatementLine.count({ where: { manualSource: { not: null }, section: { documentId: id } } })
  if (manualLines > 0) {
    let confirmManual = false
    try {
      confirmManual = (await req.json())?.confirmManual === true
    } catch {
      confirmManual = false
    }
    if (!confirmManual) {
      return NextResponse.json(
        { error: `呢份單有 ${manualLines} 行人手改／加，再讀會清走 — 確定再讀？`, code: 'MANUAL_LINES', manualLines },
        { status: 409, headers: { 'cache-control': 'no-store' } },
      )
    }
  }

  const claimed = await prisma.labDocument.updateMany({
    where: { id, status: 'EXTRACT_FAILED' },
    data: { status: 'UPLOADED', queuedAt: new Date(), extractAttempts: 0, extractError: null, version: { increment: 1 } },
  })
  if (claimed.count === 0) {
    return NextResponse.json({ error: '呢張單啱啱被改咗，請重新載入' }, { status: 409 })
  }

  // 入隊（唔等完成）
  kickLabDocQueue()

  return NextResponse.json({ id, status: 'UPLOADED' }, { status: 202, headers: { 'cache-control': 'no-store' } })
}
