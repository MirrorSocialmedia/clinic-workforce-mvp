export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma, basePrisma } from '@/lib/prisma'
import { toHttpResponse, lockEmployee } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx } from '@/lib/payroll-lock'
import { guardAdj, recalcAdjEmployee, clamped400, adjAuditData } from '@/lib/payroll/adjustment-guard'
import { validateAdjustmentInput, signedAmount } from '@/lib/payroll/adjustments'

// ============================================================
// ★ cwm-payadj-20261017 ②：計糧調整 — 改／刪（MD §2.5）
//
// PUT    /api/payroll-runs/:id/employee/:empId/adjustments/:adjId — 改（只限草稿）
// DELETE /api/payroll-runs/:id/employee/:empId/adjustments/:adjId — 軟刪除（審計睇得返）
//
// 權限同 POST（OWNER／MANAGER；RBAC_MATRIX 喺 config.ts）。
// 改咗之後一樣要重算；重算 netClamped → 還原舊值（PUT）／取消軟刪（DELETE）+ 400。
// ============================================================

type AdjDbRow = {
  id: string
  amount: { toString: () => string }
  mpfTiming: string
  reason: string
  deletedAt: Date | null
}

async function findAdjOr404(adjId: string, empId: string, ym: string) {
  const row = await prisma.payrollAdjustment.findUnique({ where: { id: adjId } })
  if (!row || row.employeeId !== empId || row.periodMonth !== ym) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) as any }
  }
  return { row: row as AdjDbRow }
}

// ---- PUT -------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; empId: string; adjId: string } }
) {
  const g = await guardAdj(req, params.id, params.empId, 'PUT')
  if ('error' in g) return g.error
  const { g: gg } = g

  const body = await req.json().catch(() => null)
  const v = validateAdjustmentInput(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  if (gg.run.status !== 'DRAFT') {
    return NextResponse.json(
      { error: '只可以喺草稿計糧單改調整（已確認要先退回草稿）', code: 'NOT_DRAFT' },
      { status: 409 },
    )
  }

  const found = await findAdjOr404(params.adjId, gg.emp.id, gg.ym)
  if ('error' in found) return found.error
  const row = found.row
  if (row.deletedAt) {
    return NextResponse.json({ error: '呢行調整已刪除', code: 'ADJ_DELETED' }, { status: 409 })
  }

  const before = { amount: Number(row.amount), mpfTiming: row.mpfTiming, reason: row.reason }
  const signed = signedAmount(v.value)

  const ip = req.headers.get('x-forwarded-for') || null
  const ua = req.headers.get('user-agent') || null
  const auditCtx = { actorId: gg.session.userId, ip: ip ?? undefined, ua: ua ?? undefined }

  try {
    await basePrisma.$transaction(async (tx) => {
      await lockEmployee(tx, gg.emp.id)
      await assertMonthsUnlockedTx(tx, {
        actorId: gg.session.userId,
        employeeId: gg.emp.id,
        months: [gg.ym],
        what: '計糧調整',
      })
      await tx.payrollAdjustment.update({
        where: { id: row.id },
        data: {
          amount: signed,
          mpfTiming: v.value.mpfTiming,
          reason: v.value.reason,
          updatedBy: gg.session.userId,
        },
      })
      await tx.auditLog.create({
        data: adjAuditData(gg, 'PAYROLL_ADJ_UPDATE', row.id, before,
          { amount: signed, mpfTiming: v.value.mpfTiming, reason: v.value.reason }, ip, ua),
      })
    })
  } catch (e: any) {
    const r = toHttpResponse(e)
    if (r) return r
    console.error('[payroll-adjustment PUT]', { runId: gg.run.id, adjId: params.adjId, message: e?.message })
    return NextResponse.json({ error: '修改調整失敗，請重試' }, { status: 500 })
  }

  const outcome = await recalcAdjEmployee(gg, auditCtx)
  if (outcome.clamped) {
    const rawNet = outcome.rawNet ?? 0
    // 還原：改返舊值
    await basePrisma.$transaction(async (tx) => {
      await lockEmployee(tx, gg.emp.id)
      await tx.payrollAdjustment.update({
        where: { id: row.id },
        data: {
          amount: Number(row.amount),
          mpfTiming: row.mpfTiming,
          reason: row.reason,
          updatedBy: gg.session.userId,
        },
      })
      await tx.auditLog.create({
        data: adjAuditData(gg, 'PAYROLL_ADJ_UPDATE', row.id,
          { amount: signed, mpfTiming: v.value.mpfTiming, reason: v.value.reason },
          { ...before, reverted: `實發會變負數（−$${Math.abs(rawNet).toFixed(2)}）` }, ip, ua),
      })
    }).catch((e: any) => console.error('[payroll-adjustment PUT] rollback failed', { adjId: row.id, message: e?.message }))
    return clamped400(rawNet)
  }

  return NextResponse.json({
    ok: true,
    adjId: row.id,
    ...(outcome.recalcError ? { recalcError: outcome.recalcError } : {}),
  })
}

// ---- DELETE（軟刪除） ---------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; empId: string; adjId: string } }
) {
  const g = await guardAdj(req, params.id, params.empId, 'DELETE')
  if ('error' in g) return g.error
  const { g: gg } = g

  if (gg.run.status !== 'DRAFT') {
    return NextResponse.json(
      { error: '只可以喺草稿計糧單刪調整（已確認要先退回草稿）', code: 'NOT_DRAFT' },
      { status: 409 },
    )
  }

  const found = await findAdjOr404(params.adjId, gg.emp.id, gg.ym)
  if ('error' in found) return found.error
  const row = found.row
  if (row.deletedAt) {
    // 冪等：已刪 = 冇嘢做
    return NextResponse.json({ ok: true, deleted: false })
  }

  const before = { amount: Number(row.amount), mpfTiming: row.mpfTiming, reason: row.reason }
  const ip = req.headers.get('x-forwarded-for') || null
  const ua = req.headers.get('user-agent') || null
  const auditCtx = { actorId: gg.session.userId, ip: ip ?? undefined, ua: ua ?? undefined }

  try {
    await basePrisma.$transaction(async (tx) => {
      await lockEmployee(tx, gg.emp.id)
      await assertMonthsUnlockedTx(tx, {
        actorId: gg.session.userId,
        employeeId: gg.emp.id,
        months: [gg.ym],
        what: '計糧調整',
      })
      await tx.payrollAdjustment.update({
        where: { id: row.id },
        data: { deletedAt: new Date(), deletedBy: gg.session.userId, updatedBy: gg.session.userId },
      })
      await tx.auditLog.create({
        data: adjAuditData(gg, 'PAYROLL_ADJ_DELETE', row.id, before,
          { deleted: true }, ip, ua),
      })
    })
  } catch (e: any) {
    const r = toHttpResponse(e)
    if (r) return r
    console.error('[payroll-adjustment DELETE]', { runId: gg.run.id, adjId: params.adjId, message: e?.message })
    return NextResponse.json({ error: '刪除調整失敗，請重試' }, { status: 500 })
  }

  const outcome = await recalcAdjEmployee(gg, auditCtx)
  if (outcome.clamped) {
    const rawNet = outcome.rawNet ?? 0
    // 還原：取消軟刪
    await basePrisma.$transaction(async (tx) => {
      await lockEmployee(tx, gg.emp.id)
      await tx.payrollAdjustment.update({
        where: { id: row.id },
        data: { deletedAt: null, deletedBy: null, updatedBy: gg.session.userId },
      })
      await tx.auditLog.create({
        data: adjAuditData(gg, 'PAYROLL_ADJ_DELETE', row.id,
          { deleted: true },
          { deleted: false, reverted: `實發會變負數（−$${Math.abs(rawNet).toFixed(2)}）` }, ip, ua),
      })
    }).catch((e: any) => console.error('[payroll-adjustment DELETE] rollback failed', { adjId: row.id, message: e?.message }))
    return clamped400(rawNet)
  }

  return NextResponse.json({
    ok: true,
    deleted: true,
    ...(outcome.recalcError ? { recalcError: outcome.recalcError } : {}),
  })
}
