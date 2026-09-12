// ★ cwm-holidayot-20260911：假期／休息日返工 OT 人手扣減。
//   GET — 讀某員工某日嘅扣減（+ 在場分鐘／打卡對，俾 UI modal 顯示上限）。
//   PUT — 新增／修改同一條路（upsert）。拍板⑥「唔可以重複輸入」：
//         schema 已 @@unique([employeeId, workDate])，同員工同日再入係【改】唔係【加】。
//   ★ 只影響【假期／休息日返工 OT】。更表日（有 CONFIRMED 等非 CANCELLED 更）→ 400；
//     更表日 OT 由「不扣飯鐘」設定處理。早返 OT（earlyInOt）完全唔受呢張表影響。
//   ★ 拍板④：只有 OWNER（RBAC_MATRIX 登記；RBAC_PERM_OVERRIDES 一條都唔加）。
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { hkDateOnly } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'
import { getEffectivePunches, invalidateTimeBankFrom } from '@/lib/punch-query'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ★★★ C3③：該月已凍結／已確認就唔准改 —— 改咗都唔會反映，仲會令帳本同糧單唱反調
//   （正正係三份 MD 花咗力氣消滅嘅對唔到數局面）。
async function getMonthLocks(employeeId: string, pm: string): Promise<{ frozen: boolean; runId: string | null }> {
  const frozen = await prisma.timeBankLedgerSnapshot.findUnique({
    where: { employeeId_periodMonth: { employeeId, periodMonth: pm } },
  })
  const run = await prisma.payrollRun.findFirst({
    where: { periodMonth: hkDateOnly(`${pm}-01`), status: 'FINALIZED' },
    select: { id: true },
  })
  return { frozen: !!frozen, runId: run?.id ?? null }
}

// 當日在場分鐘（CLOCK_IN→CLOCK_OUT 完整 pair；冇完整 pair = 0 → 冇 OT 可扣）
async function getDayPresence(employeeId: string, workDate: string) {
  const dayStart = hkDateOnly(workDate)
  const dayEnd = new Date(Date.parse(`${workDate}T23:59:59+08:00`) + 999)
  const eps = await getEffectivePunches(dayStart, dayEnd, { employeeId })
  const ins = eps.filter(p => p.punchType === 'CLOCK_IN')
  const outs = eps.filter(p => p.punchType === 'CLOCK_OUT')
  if (ins.length === 0 || outs.length === 0) {
    return { presentMinutes: 0, firstIn: null as string | null, lastOut: null as string | null }
  }
  const firstIn = [...ins].sort((a, b) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
  const lastOut = [...outs].sort((a, b) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]
  const mins = Math.floor((lastOut.effectiveTime.getTime() - firstIn.effectiveTime.getTime()) / 60000)
  return {
    presentMinutes: Math.max(0, mins),
    firstIn: firstIn.effectiveTime.toISOString(),
    lastOut: lastOut.effectiveTime.toISOString(),
  }
}

// 嗰日有冇更（拍板⑤：只准扣假期／休息日返工 OT）
async function dayHasShift(employeeId: string, workDate: string) {
  const dayStart = hkDateOnly(workDate)
  const dayEnd = new Date(Date.parse(`${workDate}T23:59:59+08:00`) + 999)
  const s = await prisma.shift.findFirst({
    where: { employeeId, date: { gte: dayStart, lte: dayEnd }, status: { not: 'CANCELLED' } },
    select: { id: true },
  })
  return !!s
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const sp = new URL(req.url).searchParams
  const employeeId = sp.get('employeeId') ?? ''
  const workDate = sp.get('workDate') ?? ''
  if (!employeeId || !DATE_RE.test(workDate)) {
    return NextResponse.json({ error: 'employeeId 同 workDate (YYYY-MM-DD) 必填' }, { status: 400 })
  }

  const [row, presence, hasShift] = await Promise.all([
    prisma.holidayOtAdjustment.findUnique({
      where: { employeeId_workDate: { employeeId, workDate: hkDateOnly(workDate) } },
    }),
    getDayPresence(employeeId, workDate),
    // ★ 打卡頁 modal 用：嗰日有無更（有更 = 唔應該喺呢度扣）
    dayHasShift(employeeId, workDate),
  ])

  return jsonNoStore({
    adjustment: row,
    presentMinutes: presence.presentMinutes,
    firstIn: presence.firstIn,
    lastOut: presence.lastOut,
    workDate,
    hasShift,
  })
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'JSON body 必填' }, { status: 400 }) }
    const { employeeId, workDate, deductMinutes, reason } = body ?? {}

    // --- 輸入驗證 ---
    if (!employeeId || typeof employeeId !== 'string') {
      return NextResponse.json({ error: 'employeeId 必填' }, { status: 400 })
    }
    if (typeof workDate !== 'string' || !DATE_RE.test(workDate)) {
      return NextResponse.json({ error: 'workDate 必填（YYYY-MM-DD）' }, { status: 400 })
    }
    if (!Number.isInteger(deductMinutes)) {
      return NextResponse.json({ error: 'deductMinutes 必填（整數分鐘）' }, { status: 400 })
    }
    const r = typeof reason === 'string' ? reason.trim() : ''
    if (r.length === 0) {
      return NextResponse.json({ error: '原因必填' }, { status: 400 })
    }

    // --- C3①：只准扣假期／休息日返工 OT（嗰日有更 = 更表 OT，行 deductLunch gate）---
    if (await dayHasShift(employeeId, workDate)) {
      return NextResponse.json(
        { error: '嗰日有更表 —— 更表日嘅 OT 由「不扣飯鐘」設定處理，唔喺呢度扣' },
        { status: 400 },
      )
    }

    // --- C3②：扣減唔可以多過當日在場分鐘 ---
    const presence = await getDayPresence(employeeId, workDate)
    if (deductMinutes < 0) {
      return NextResponse.json({ error: '扣減分鐘唔可以係負數' }, { status: 400 })
    }
    if (deductMinutes > presence.presentMinutes) {
      return NextResponse.json(
        { error: `扣減唔可以多過當日在場分鐘（${presence.presentMinutes} 分）` },
        { status: 400 },
      )
    }

    // --- C3③：該月帳本已凍結／計糧已確認 → 唔准改 ---
    const pm = workDate.slice(0, 7)
    const lock = await getMonthLocks(employeeId, pm)
    if (lock.frozen) {
      return NextResponse.json({ error: `${pm} 時間帳戶帳本已凍結 —— 請先喺計糧退回草稿` }, { status: 409 })
    }
    if (lock.runId) {
      return NextResponse.json({ error: `${pm} 計糧已確認 —— 請先退回草稿` }, { status: 409 })
    }

    // --- C2：upsert + 清時間帳戶快取 + audit（同一 transaction）---
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.holidayOtAdjustment.findUnique({
        where: { employeeId_workDate: { employeeId, workDate: hkDateOnly(workDate) } },
      })

      // ★ cwm-holidayot-20260911 C2：upsert —— 拍板⑥「唔可以重複輸入」。
      //   同一員工同一日再入，係【改】唔係【加】。unique 喺 schema 已經擋死。
      const row = await tx.holidayOtAdjustment.upsert({
        where: { employeeId_workDate: { employeeId, workDate: hkDateOnly(workDate) } },
        create: {
          employeeId,
          workDate: hkDateOnly(workDate),
          deductMinutes,
          reason: r,
          createdBy: session.userId,
        },
        update: { deductMinutes, reason: r, updatedBy: session.userId },
      })

      // ★★★ 拍板⑥「即時更新」第一層：清時間帳戶快取（坑④）
      await invalidateTimeBankFrom(employeeId, hkDateOnly(workDate), tx)

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'HOLIDAY_OT_ADJUST',
          entity: 'HolidayOtAdjustment',
          entityId: row.id,
          targetEmployeeId: employeeId,
          beforeJson: JSON.stringify(existing ? { deductMinutes: existing.deductMinutes, reason: existing.reason } : null),
          afterJson: JSON.stringify({ deductMinutes, reason: r }),
          notes: `假期返工 OT 扣減 ${workDate}：${existing ? `改 ${existing.deductMinutes} → ${deductMinutes}` : `新增 ${deductMinutes}`} 分。原因：${r}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })
      return row
    })

    return NextResponse.json({ ok: true, adjustment: result })
  })
}
