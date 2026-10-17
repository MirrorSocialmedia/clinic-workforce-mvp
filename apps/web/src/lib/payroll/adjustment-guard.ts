// ============================================================
// ★ cwm-payadj-20261017 ②：計糧調整 API 共用守衛（MD §2.5）
//
// 4 條 route 共用（GET／POST /adjustments、PUT／DELETE /adjustments/:adjId）：
//   1. requireAuth（角色由 RBAC_MATRIX 決定 — config.ts 4 條）
//   2. run 必須存在（404）
//   3. 員工必须有 item 喺呢張 run（404）— 調整掛喺「呢張單呢個人」
//   4. 診所範圍（resolvePayrollScope，同計糧明細頁同一把尺）
//   5. 保密員工：canSeeConfidential — MANAGER 一律 403；
//      EMPLOYEE 只可以睇自己主屬店；OWNER 全可以（MD：非 OWNER 對保密員工一律 403）
// ============================================================
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolvePayrollScope, canSeeConfidential } from '@/lib/scope-helpers'
import { periodMonthKey } from '@/lib/hk-date'
import { generatePayrollRun } from '@/lib/payroll-engine'

export type AdjGuard = {
  session: { userId: string; role: string; tokenVersion?: number }
  perms: string[]
  run: { id: string; status: string; clinicId: string | null; periodMonth: Date }
  emp: { id: string; name: string; payConfidential: boolean; homeClinicId: string | null }
  /** run 嘅月份 'YYYY-MM'（HK 口徑）— 調整掛呢個月 */
  ym: string
}

export async function guardAdj(
  req: NextRequest,
  runId: string,
  empId: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
): Promise<{ error: NextResponse } | { ok: true; g: AdjGuard }> {
  const auth = await requireAuth(req, method, req.url)
  if (isAuthError(auth)) return { error: auth.error }
  const { session } = auth
  const perms = auth.perms ?? []

  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, clinicId: true, periodMonth: true },
  })
  if (!run) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }

  const item = await prisma.payrollItem.findUnique({
    where: { runId_employeeId: { runId, employeeId: empId } },
    select: {
      id: true,
      employee: {
        select: {
          id: true,
          payConfidential: true,
          homeClinicId: true,
          user: { select: { name: true } },
        },
      },
    },
  })
  if (!item) {
    return { error: NextResponse.json({ error: '呢個員工唔喺呢張計糧單' }, { status: 404 }) }
  }

  const allowedClinics = await resolvePayrollScope(session, perms, {
    homeOnly: ['payroll_view', 'payroll_generate'],
  })
  if (allowedClinics !== null && (!run.clinicId || !allowedClinics.includes(run.clinicId))) {
    return { error: NextResponse.json({ error: '你冇權限處理呢間診所嘅計糧單' }, { status: 403 }) }
  }

  const emp = item.employee
  if (!(await canSeeConfidential(session, perms, emp))) {
    return { error: NextResponse.json({ error: '此員工薪資已設保密，只可以由負責人處理' }, { status: 403 }) }
  }

  return {
    ok: true,
    g: {
      session,
      perms,
      run,
      emp: { id: emp.id, name: emp.user?.name ?? emp.id, payConfidential: emp.payConfidential, homeClinicId: emp.homeClinicId },
      ym: periodMonthKey(run.periodMonth),
    },
  }
}

// ---- 寫入後重算（MD §2.5.3） -------------------------------------------------

export type AdjAuditCtx = { actorId: string; ip?: string; ua?: string }

export type AdjRecalcOutcome = { clamped?: boolean; rawNet?: number; recalcError?: string }

/**
 * 調整 tx commit 之後即刻重算呢一個人（引擎太大，唔塞同一 tx）。
 *   · 重算出 detail.netClamped === true → { clamped, rawNet }（caller 還原 + 400）
 *   · 其他失敗 → { recalcError }（調整照存，前端顯示「已儲存，草稿未更新」）
 *   · 成功 → { ok: true }
 * rawNet = 引擎 netPayRaw 公式（gross − mpf − tbDed + adjPost），負數就係 400 訊息用嘅 −$X。
 */
export async function recalcAdjEmployee(g: AdjGuard, auditCtx: AdjAuditCtx): Promise<AdjRecalcOutcome> {
  try {
    const result = await generatePayrollRun(g.run.clinicId, g.ym, auditCtx, { onlyEmployeeIds: [g.emp.id] })
    if ((result as any).error) {
      // generatePayrollRun 結構化 error（例：同月另一張單衝突）— 調整照存
      return { recalcError: (result as any).error }
    }
    const item = await prisma.payrollItem.findUnique({
      where: { runId_employeeId: { runId: g.run.id, employeeId: g.emp.id } },
      select: { detailJson: true },
    })
    let d: any = null
    try { d = item?.detailJson ? JSON.parse(item.detailJson) : null } catch { d = null }
    if (d?.netClamped === true) {
      const rawNet = Number(d.grossPay ?? 0) - Number(d.mpf ?? 0)
        - Number(d.resignSettlement?.tbDeduction ?? 0) + Number(d.adjPostMpf ?? 0)
      return { clamped: true, rawNet }
    }
    return {}
  } catch (e: any) {
    // 409（重算期間被確認）／其他 — 全部當「重算失敗」：調整照存，唔 500
    console.error('[payroll-adjustment] recalc failed', { runId: g.run.id, empId: g.emp.id, status: e?.status, message: e?.message })
    return { recalcError: e?.message ?? '重算失敗' }
  }
}

/** 409 文案（MD §2.5.3）：實發會變負數（−$X），唔可以儲存 */
export function clamped400(rawNet: number): NextResponse {
  return NextResponse.json({
    error: `實發會變負數（−$${Math.abs(rawNet).toFixed(2)}），唔可以儲存`,
    code: 'NET_WOULD_BE_NEGATIVE',
  }, { status: 400 })
}

/** audit 行 shape（PAYROLL_ADJ_CREATE／UPDATE／DELETE — before/after 包 amount、mpfTiming、reason） */
export function adjAuditData(
  g: AdjGuard,
  action: 'PAYROLL_ADJ_CREATE' | 'PAYROLL_ADJ_UPDATE' | 'PAYROLL_ADJ_DELETE',
  entityId: string,
  before: unknown,
  after: unknown,
  ip: string | null,
  ua: string | null,
) {
  return {
    actorId: g.session.userId,
    action,
    entity: 'PayrollAdjustment',
    entityId,
    targetEmployeeId: g.emp.id,
    clinicId: g.run.clinicId,
    beforeJson: before == null ? null : JSON.stringify(before),
    afterJson: after == null ? null : JSON.stringify(after),
    ipAddress: ip,
    userAgent: ua,
  }
}
