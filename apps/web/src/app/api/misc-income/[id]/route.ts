import { NextRequest, NextResponse } from 'next/server'
import type { MiscIncome } from '@prisma/client'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { validateMiscIncome, miscIncomeScopeClinics, serializeMiscIncome } from '@/lib/misc-income'

// ============================================================
// /api/misc-income/:id — 店舖雜項收入（cwm-payoutxlsx-20260908 D2）
// PUT     修改（partial update；periodMonth 恆由 incomeAt 重derive）
// DELETE  作廢（isVoid = true，軟刪，唔硬刪）
// Roles: OWNER, MANAGER + cost_entry 權限覆蓋（RBAC_PERM_OVERRIDES）
// ★ scope guard（真驗證）：行嘅 clinicId 必須喺 session scope 內，冇就 403
// ============================================================

type LoadResult =
  | { kind: 'error'; response: NextResponse }
  | {
      kind: 'ok'
      session: { userId: string; role: string; clinics: string[] }
      scopeClinics: string[] | null
      existing: MiscIncome
    }

/** requireAuth → 404 檢查 → scope guard（403）。tagged result，唔混用。 */
async function loadAndScopeCheck(
  req: NextRequest,
  method: 'PUT' | 'DELETE',
  id: string,
): Promise<LoadResult> {
  const auth = await requireAuth(req, method, req.url)
  if (isAuthError(auth)) return { kind: 'error', response: auth.error }

  const existing = await prisma.miscIncome.findUnique({ where: { id } })
  if (!existing) {
    return { kind: 'error', response: jsonNoStore({ error: '搵唔到記錄' }, { status: 404 }) }
  }

  // ★ scope guard：行嘅 clinicId 喺 session scope 內先繼續
  const scopeClinics = await miscIncomeScopeClinics(
    auth.session,
    auth.scope,
    auth.session.clinics,
  )
  if (scopeClinics && !scopeClinics.includes(existing.clinicId)) {
    return {
      kind: 'error',
      response: NextResponse.json(
        { error: 'You do not have access to this clinic' },
        { status: 403 },
      ),
    }
  }
  return { kind: 'ok', session: auth.session, scopeClinics, existing }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const res = await loadAndScopeCheck(req, 'PUT', id)
  if (res.kind === 'error') return res.response
  const { session, scopeClinics, existing } = res

  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = null
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: '請求格式錯誤' }, { status: 400 })
  }
  const b = body as Record<string, unknown>

  // Partial update：undefined = 唔改；note 傳 null/'' = 清除
  const merged: Record<string, unknown> = {
    clinicId: b.clinicId !== undefined ? b.clinicId : existing.clinicId,
    incomeAt: b.incomeAt !== undefined ? b.incomeAt : existing.incomeAt,
    category: b.category !== undefined ? b.category : existing.category,
    itemName: b.itemName !== undefined ? b.itemName : existing.itemName,
    note: b.note !== undefined ? b.note : existing.note,
    methodNorm: b.methodNorm !== undefined ? b.methodNorm : existing.methodNorm,
    amount: b.amount !== undefined ? b.amount : existing.amount,
  }

  const allRules = await prisma.paymentMethodRule.findMany()
  const v = validateMiscIncome(merged, allRules)
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: 400 })
  }

  // ★ 改咗 clinicId 嗰時新診所都要喺 scope 內
  if (scopeClinics && !scopeClinics.includes(v.data.clinicId)) {
    return NextResponse.json(
      { error: 'You do not have access to this clinic' },
      { status: 403 },
    )
  }

  const updated = await prisma.miscIncome.update({
    where: { id },
    data: {
      clinicId: v.data.clinicId,
      incomeAt: v.data.incomeAt,
      category: v.data.category,
      itemName: v.data.itemName,
      note: v.data.note,
      methodNorm: v.data.methodNorm,
      amount: v.data.amount,
      periodMonth: v.data.periodMonth, // ★ 恆由 incomeAt 重derive
    },
  })

  // ★ audit（MISC_INCOME_UPDATE — SENSITIVE_AUDIT_SPEC）
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'MISC_INCOME_UPDATE',
      entity: 'MiscIncome',
      entityId: id,
      clinicId: existing.clinicId,
      beforeJson: JSON.stringify(serializeMiscIncome(existing)),
      afterJson: JSON.stringify(serializeMiscIncome(updated)),
      notes:
        existing.itemName === updated.itemName
          ? `更新雜項收入: ${updated.itemName} $${updated.amount} (${updated.periodMonth})`
          : `更新雜項收入: ${existing.itemName} → ${updated.itemName} (${updated.periodMonth})`,
    },
  } as any)

  return NextResponse.json(
    { item: serializeMiscIncome(updated) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const res = await loadAndScopeCheck(req, 'DELETE', id)
  if (res.kind === 'error') return res.response
  const { session, existing } = res

  if (existing.isVoid) {
    return NextResponse.json({ error: '已經係作廢狀態' }, { status: 409 })
  }

  // ★ void = 軟刪（isVoid = true），唔硬刪
  const updated = await prisma.miscIncome.update({
    where: { id },
    data: { isVoid: true },
  })

  // ★ audit（MISC_INCOME_VOID — SENSITIVE_AUDIT_SPEC）
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'MISC_INCOME_VOID',
      entity: 'MiscIncome',
      entityId: id,
      clinicId: existing.clinicId,
      beforeJson: JSON.stringify({
        isVoid: false,
        itemName: existing.itemName,
        amount: Number(existing.amount),
        periodMonth: existing.periodMonth,
      }),
      afterJson: JSON.stringify({ isVoid: true }),
      notes: `作廢雜項收入: ${existing.itemName} $${existing.amount} (${existing.periodMonth})`,
    },
  } as any)

  return NextResponse.json(
    { item: serializeMiscIncome(updated) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
