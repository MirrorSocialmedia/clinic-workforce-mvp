export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma, basePrisma } from '@/lib/prisma'
import { toHttpResponse } from '@/lib/emp-lock'
import { lockEmployee } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx } from '@/lib/payroll-lock'
import { guardAdj, recalcAdjEmployee, clamped400, adjAuditData } from '@/lib/payroll/adjustment-guard'
import { validateAdjustmentInput, signedAmount, loadAdjustments, sumAdjustments, adjHashOf } from '@/lib/payroll/adjustments'

// ============================================================
// ★ cwm-payadj-20261017 ②：計糧調整（MD §2.5）
//
// GET  /api/payroll-runs/:id/employee/:empId/adjustments — 呢個人呢個月嘅調整
// POST /api/payroll-runs/:id/employee/:empId/adjustments — 加一行（只限草稿）
//
// 權限（RBAC_MATRIX，config.ts）：
//   GET  OWNER／MANAGER／ACCOUNTANT（只讀；保密員工由 canSeeConfidential 擋：非 OWNER 403）
//   POST OWNER／MANAGER
// 名稱刻意唔用 payout-adjustments（嗰個係醫生嘅）。
// ============================================================

// ---- GET -------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; empId: string } }
) {
  const g = await guardAdj(req, params.id, params.empId, 'GET')
  if ('error' in g) return g.error
  const { g: gg } = g

  const rows = await loadAdjustments(prisma, gg.emp.id, gg.ym)
  const sum = sumAdjustments(rows)

  // 草稿過期偵測（同 run GET / finalize gate 同一把尺）
  const item = await prisma.payrollItem.findUnique({
    where: { runId_employeeId: { runId: gg.run.id, employeeId: gg.emp.id } },
    select: { detailJson: true },
  })
  let storedHash: string | null = null
  try { storedHash = item?.detailJson ? (JSON.parse(item.detailJson).adjHash ?? null) : null } catch { storedHash = null }
  const adjStale = storedHash == null ? rows.length > 0 : adjHashOf(rows) !== storedHash

  return NextResponse.json({
    periodMonth: gg.ym,
    adjustments: rows.map(r => ({
      id: r.id,
      amount: r.amount, // signed：正 = 加，負 = 減
      sign: r.amount >= 0 ? 'ADD' : 'DEDUCT',
      mpfTiming: r.mpfTiming,
      reason: r.reason,
    })),
    sum: { pre: sum.pre, post: sum.post },
    adjStale,
  }, { headers: { 'Cache-Control': 'no-store, must-revalidate' } })
}

// ---- POST ------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; empId: string } }
) {
  const g = await guardAdj(req, params.id, params.empId, 'POST')
  if ('error' in g) return g.error
  const { g: gg } = g

  const body = await req.json().catch(() => null)
  const v = validateAdjustmentInput(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  if (gg.run.status !== 'DRAFT') {
    return NextResponse.json(
      { error: '只可以喺草稿計糧單加調整（已確認要先退回草稿）', code: 'NOT_DRAFT' },
      { status: 409 },
    )
  }

  const ip = req.headers.get('x-forwarded-for') || null
  const ua = req.headers.get('user-agent') || null
  const auditCtx = { actorId: gg.session.userId, ip: ip ?? undefined, ua: ua ?? undefined }
  const signed = signedAmount(v.value)

  let adjId: string
  try {
    adjId = await basePrisma.$transaction(async (tx) => {
      // MD §2.5.2：lockEmployee → assertMonthsUnlockedTx → 寫
      await lockEmployee(tx, gg.emp.id)
      await assertMonthsUnlockedTx(tx, {
        actorId: gg.session.userId,
        employeeId: gg.emp.id,
        months: [gg.ym],
        what: '計糧調整',
      })
      const created = await tx.payrollAdjustment.create({
        data: {
          employeeId: gg.emp.id,
          periodMonth: gg.ym,
          amount: signed, // Decimal(12,2) — 正負號即方向
          mpfTiming: v.value.mpfTiming,
          reason: v.value.reason,
          createdBy: gg.session.userId,
        },
      })
      await tx.auditLog.create({
        data: adjAuditData(gg, 'PAYROLL_ADJ_CREATE', created.id, null,
          { amount: signed, mpfTiming: v.value.mpfTiming, reason: v.value.reason }, ip, ua),
      })
      return created.id
    })
  } catch (e: any) {
    const r = toHttpResponse(e)
    if (r) return r
    console.error('[payroll-adjustment POST]', { runId: gg.run.id, empId: gg.emp.id, message: e?.message })
    return NextResponse.json({ error: '新增調整失敗，請重試' }, { status: 500 })
  }

  // MD §2.5.3：tx 之後即刻重算呢一個人
  const outcome = await recalcAdjEmployee(gg, auditCtx)
  if (outcome.clamped) {
    const rawNet = outcome.rawNet ?? 0
    // 還原：軟刪（POST 就軟刪）
    await basePrisma.$transaction(async (tx) => {
      await lockEmployee(tx, gg.emp.id)
      await tx.payrollAdjustment.update({
        where: { id: adjId },
        data: { deletedAt: new Date(), deletedBy: gg.session.userId, updatedBy: gg.session.userId },
      })
      await tx.auditLog.create({
        data: adjAuditData(gg, 'PAYROLL_ADJ_CREATE', adjId, null,
          { amount: signed, mpfTiming: v.value.mpfTiming, reason: v.value.reason,
            reverted: `實發會變負數（−$${Math.abs(rawNet).toFixed(2)}）` }, ip, ua),
      })
    }).catch((e: any) => console.error('[payroll-adjustment POST] rollback failed', { adjId, message: e?.message }))
    return clamped400(rawNet)
  }

  return NextResponse.json({
    ok: true,
    adjId,
    // MD §2.5.5：重算其他失敗 → 調整照存 + recalcError（前端顯示「已儲存，草稿未更新，請撳重新生成」）
    ...(outcome.recalcError ? { recalcError: outcome.recalcError } : {}),
  })
}
