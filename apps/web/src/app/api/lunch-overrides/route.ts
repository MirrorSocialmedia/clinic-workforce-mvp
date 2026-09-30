export const dynamic = 'force-dynamic'
// ★ 2026-09-30：午飯扣減人手調整（LunchDeductOverride）
//   GET    ?employeeId&workDate — 讀當日資料（有冇更、扣唔扣飯鐘、預設分鐘、上下班時間、現有調整）
//   PUT    { employeeId, workDate, lunchMinutes, reason } — 新增／修改（upsert，一日一筆）
//   DELETE ?employeeId&workDate — 移除調整（回復按規則扣）
//   ★ 只 OWNER（同 holiday-ot-adjustments 拍板④ 一致；RBAC_PERM_OVERRIDES 一條都唔加）
//   ★ 守衛：計糧已確認／已匯出 → 409；帳本已凍結 → 409（同假期 OT 調整一樣）
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { hkDateOnly, hkDateEnd, getMonthRange } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'
import { getEffectivePunches, invalidateTimeBankFrom } from '@/lib/punch-query'
import { guardPayrollLock } from '@/lib/payroll-lock'
import { findPayRuleForMonth } from '@/lib/pay-rule-for-month'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function loadDay(employeeId: string, workDate: string) {
  const dayStart = hkDateOnly(workDate)
  const dayEnd = hkDateEnd(workDate)
  const { start: ms, end: me } = getMonthRange(dayStart)
  const [shifts, eps, rule, override] = await Promise.all([
    prisma.shift.findMany({
      where: { employeeId, date: { gte: dayStart, lte: dayEnd }, status: { not: 'CANCELLED' } },
      select: { template: { select: { deductLunch: true } } },
    }),
    getEffectivePunches(dayStart, dayEnd, { employeeId }),
    findPayRuleForMonth(prisma, employeeId, ms, me),
    prisma.lunchDeductOverride.findUnique({ where: { employeeId_workDate: { employeeId, workDate: dayStart } } }),
  ])
  let lunchDefault = 60
  try {
    const cfg = rule?.configJson ? (typeof rule.configJson === 'string' ? JSON.parse(rule.configJson) : rule.configJson) : null
    lunchDefault = cfg?.modifiers?.lunch_break?.defaultMinutes ?? 60
  } catch { /* 壞 JSON → 同引擎 fallback 一樣用 60 */ }
  const byTime = (a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime()
  const ins = eps.filter(p => p.punchType === 'CLOCK_IN').sort(byTime)
  const outs = eps.filter(p => p.punchType === 'CLOCK_OUT').sort(byTime)
  return {
    override,
    lunchDefault,
    hasShift: shifts.length > 0,
    // 同引擎 gate 一致：冇更 或 有任何一張更要扣 → 會扣
    dayDeductsLunch: shifts.length === 0 || shifts.some(s => s.template?.deductLunch !== false),
    hasClockIn: ins.length > 0,
    firstIn: ins[0]?.effectiveTime.toISOString() ?? null,
    lastOut: outs.length ? outs[outs.length - 1].effectiveTime.toISOString() : null,
  }
}

async function lockGuards(session: any, employeeId: string, workDate: string, what: string) {
  const locked = await guardPayrollLock(session, employeeId, [workDate], what)
  if (locked) return locked
  const pm = workDate.slice(0, 7)
  const frozen = await prisma.timeBankLedgerSnapshot.findUnique({
    where: { employeeId_periodMonth: { employeeId, periodMonth: pm } },
    select: { id: true },
  })
  if (frozen) return NextResponse.json({ error: `${pm} 時間帳戶帳本已凍結 —— 請先喺計糧退回草稿` }, { status: 409 })
  return null
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const sp = new URL(req.url).searchParams
  const employeeId = sp.get('employeeId') ?? ''
  const workDate = sp.get('workDate') ?? ''
  if (!employeeId || !DATE_RE.test(workDate)) {
    return jsonNoStore({ error: 'employeeId 同 workDate (YYYY-MM-DD) 必填' }, { status: 400 })
  }
  return jsonNoStore({ ...(await loadDay(employeeId, workDate)), workDate })
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  const auditCtx = { actorId: session.userId, ip: req.headers.get('x-forwarded-for') || undefined, ua: req.headers.get('user-agent') || undefined }

  return runWithAudit(auditCtx, async () => {
    const body = await req.json().catch(() => null)
    const { employeeId, workDate, lunchMinutes, reason } = body ?? {}
    if (!employeeId || typeof employeeId !== 'string') return NextResponse.json({ error: 'employeeId 必填' }, { status: 400 })
    if (typeof workDate !== 'string' || !DATE_RE.test(workDate)) return NextResponse.json({ error: 'workDate 必填（YYYY-MM-DD）' }, { status: 400 })
    if (!Number.isInteger(lunchMinutes) || lunchMinutes < 0) return NextResponse.json({ error: 'lunchMinutes 要係 0 或以上嘅整數' }, { status: 400 })
    const r = typeof reason === 'string' ? reason.trim().slice(0, 200) : ''
    if (!r) return NextResponse.json({ error: '原因必填' }, { status: 400 })

    const day = await loadDay(employeeId, workDate)
    if (!day.hasClockIn) return NextResponse.json({ error: '嗰日冇上班卡，冇午飯扣減可以調整' }, { status: 400 })
    if (!day.dayDeductsLunch) return NextResponse.json({ error: '嗰日更次已設定「不扣飯鐘」，唔使調整' }, { status: 400 })
    if (lunchMinutes > day.lunchDefault) {
      return NextResponse.json({ error: `只可以減少扣減：上限係規則預設 ${day.lunchDefault} 分` }, { status: 400 })
    }

    const blocked = await lockGuards(session, employeeId, workDate, '午飯扣減調整')
    if (blocked) return blocked

    const wd = hkDateOnly(workDate)
    const row = await prisma.$transaction(async (tx) => {
      const existing = await tx.lunchDeductOverride.findUnique({ where: { employeeId_workDate: { employeeId, workDate: wd } } })
      const saved = await tx.lunchDeductOverride.upsert({
        where: { employeeId_workDate: { employeeId, workDate: wd } },
        create: { employeeId, workDate: wd, lunchMinutes, reason: r, createdBy: session.userId },
        update: { lunchMinutes, reason: r, updatedBy: session.userId },
      })
      await invalidateTimeBankFrom(employeeId, wd, tx)
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'LUNCH_OVERRIDE',
          entity: 'LunchDeductOverride',
          entityId: saved.id,
          targetEmployeeId: employeeId,
          beforeJson: JSON.stringify(existing ? { lunchMinutes: existing.lunchMinutes, reason: existing.reason } : null),
          afterJson: JSON.stringify({ lunchMinutes, reason: r, lunchDefault: day.lunchDefault }),
          notes: `午飯扣減調整 ${workDate}：${existing ? `改 ${existing.lunchMinutes} → ${lunchMinutes}` : `${day.lunchDefault} → ${lunchMinutes}`} 分。原因：${r}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })
      return saved
    })
    return NextResponse.json({ ok: true, override: row })
  })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  const auditCtx = { actorId: session.userId, ip: req.headers.get('x-forwarded-for') || undefined, ua: req.headers.get('user-agent') || undefined }

  return runWithAudit(auditCtx, async () => {
    const sp = new URL(req.url).searchParams
    const employeeId = sp.get('employeeId') ?? ''
    const workDate = sp.get('workDate') ?? ''
    if (!employeeId || !DATE_RE.test(workDate)) return NextResponse.json({ error: 'employeeId 同 workDate 必填' }, { status: 400 })
    const wd = hkDateOnly(workDate)
    const row = await prisma.lunchDeductOverride.findUnique({ where: { employeeId_workDate: { employeeId, workDate: wd } } })
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const blocked = await lockGuards(session, employeeId, workDate, '移除午飯扣減調整')
    if (blocked) return blocked

    await prisma.$transaction(async (tx) => {
      await tx.lunchDeductOverride.delete({ where: { id: row.id } })
      await invalidateTimeBankFrom(employeeId, wd, tx)
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'LUNCH_OVERRIDE_DELETE',
          entity: 'LunchDeductOverride',
          entityId: row.id,
          targetEmployeeId: employeeId,
          beforeJson: JSON.stringify({ lunchMinutes: row.lunchMinutes, reason: row.reason }),
          afterJson: 'null',
          notes: `移除午飯扣減調整 ${workDate}（原 ${row.lunchMinutes} 分）。原原因：${row.reason}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })
    })
    return NextResponse.json({ ok: true })
  })
}
