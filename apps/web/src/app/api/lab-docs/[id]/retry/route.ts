// ★ cwm-labdoc P2：POST /api/lab-docs/:id/retry — EXTRACT_FAILED 再讀（§5.1／§11）
//
//  - 只准 EXTRACT_FAILED（其他狀態 400）
//  - 讀單服務未設（WA_INBOX_LABDOC_URL／INTERNAL_LLM_SECRET）→ 503「讀單服務未設定，請人手輸入」
//    （§11：503 只喺「再讀」時回；上傳時嘅背景讀單 fail 靜靜入 EXTRACT_FAILED）
//  - 人手再讀 = 一輪新嘅 3 次上限：claim 時重置 extractAttempts=0
//    （sweep 路徑從唔重置 — 防 attempts 永遠清零無限重試）
//  - claim 條件更新（EXTRACT_FAILED → EXTRACTING）→ 背景執行（同上傳 request 尾 void 做法）
export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { runExtractionAfterClaim } from '@/lib/labdoc/extract'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  const { id } = params

  // §10.3 fail-closed（跟 P1 [id] 口徑）：lab 權限 = 全集團；其餘按診所範圍
  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
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

  const claimed = await prisma.labDocument.updateMany({
    where: { id, status: 'EXTRACT_FAILED' },
    data: { status: 'EXTRACTING', heartbeatAt: new Date(), extractAttempts: 0, extractError: null },
  })
  if (claimed.count === 0) {
    return NextResponse.json({ error: '呢張單啱啱被改咗，請重新載入' }, { status: 409 })
  }

  // 背景執行（唔等完成）
  runExtractionAfterClaim(id)

  return NextResponse.json({ id, status: 'EXTRACTING' }, { status: 202, headers: { 'cache-control': 'no-store' } })
}
