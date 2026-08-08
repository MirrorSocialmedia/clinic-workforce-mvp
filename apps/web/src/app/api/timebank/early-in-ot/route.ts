export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { hkDateStart, hkDateEnd, toHKDateStr } from '@/lib/hk-date'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { getEffectivePunches } from '@/lib/punch-query'
import { matchPunchesToShifts } from '@/lib/shift-punch-match'
import { computeEarlyInOt, readEarlyInOtCfg } from '@/lib/early-in-ot'

async function tbBalance(employeeId: string) {
  const r = await prisma.timeBankEntry.aggregate({ where: { employeeId }, _sum: { minutes: true } })
  return r._sum.minutes ?? 0
}

/**
 * POST /api/timebank/early-in-ot
 * 批准提早上班 OT：將早到分鐘入帳至時間帳戶
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (!['OWNER', 'MANAGER'].includes(auth.session.role)) {
    return NextResponse.json({ error: '需要老闆或經理權限' }, { status: 403 })
  }

  try {
    const { employeeId, date } = await req.json()
    if (!employeeId || !date) {
      return NextResponse.json({ error: 'employeeId 和 date 必填' }, { status: 400 })
    }

    const dayStart = hkDateStart(date)
    const dayEnd = hkDateEnd(date)

    // 驗證①：防重複
    const existing = await prisma.timeBankEntry.findFirst({
      where: {
        employeeId,
        type: 'EARLY_IN_OT',
        date: { gte: dayStart, lte: dayEnd },
      },
    })
    if (existing) return NextResponse.json({ error: '該日已批准提早上班OT' }, { status: 400 })

    // 驗證②：攞當日 shift + effective punches → matchPunchesToShifts → earlyInMinutes
    const shifts = await prisma.shift.findMany({
      where: {
        employeeId,
        date: { gte: dayStart, lte: dayEnd },
        status: { not: 'CANCELLED' },
      },
    })
    if (shifts.length === 0) return NextResponse.json({ error: '該日無排班' }, { status: 400 })

    const effectivePunches = await getEffectivePunches(dayStart, dayEnd, {
      employeeId,
      db: prisma,
    })
    if (effectivePunches.length === 0) return NextResponse.json({ error: '該日無打卡記錄' }, { status: 400 })

    const matched = matchPunchesToShifts(shifts as any, effectivePunches as any)

    // 攞 earliest earlyInMinutes（可能有多張更）
    const rawEarly = matched.reduce(
      (max, m) => Math.max(max, m.earlyInMinutes ?? 0),
      0,
    )
    if (rawEarly <= 0) return NextResponse.json({ error: '該日無提早上班記錄' }, { status: 400 })

    // 攞 payRule config（條件照 payroll-engine.ts:1491-1498）
    const empPayRule = await prisma.payRule.findFirst({
      where: {
        employeeId,
        isActive: true,
        effectiveFrom: { lte: dayEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: dayStart } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    })
    const cfg = readEarlyInOtCfg(empPayRule?.configJson)

    // 計算最終分鐘
    const finalMinutes = computeEarlyInOt(rawEarly, cfg)
    if (finalMinutes <= 0) {
      return NextResponse.json(
        { error: `未達門檻（原始 ${rawEarly} 分，門檻 ${Math.max(cfg.earlyInMinMinutes ?? 15, cfg.otMinMinutes ?? 0)} 分）` },
        { status: 400 },
      )
    }

    // 時薪 gate：時薪員工不設時間帳戶
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { payRules: { where: { isActive: true }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }], take: 1 } },
    })
    if (!employee) return NextResponse.json({ error: '員工不存在' }, { status: 404 })
    if (employee.payRules?.length) {
      try {
        const payRuleCfg = JSON.parse(employee.payRules[0].configJson || '{}')
        if (payRuleCfg?.base_type === 'hourly') {
          return NextResponse.json({ error: '時薪員工不適用提早上班OT' }, { status: 400 })
        }
      } catch { /* ignore */ }
    }

    // 計算 balance 變化
    const beforeBalance = await tbBalance(employeeId)

    // 攞 shift 資料用於 audit
    const shiftForAudit = shifts[0]
    const clockInPunch = effectivePunches
      .filter(p => p.punchType === 'CLOCK_IN')
      .sort((a, b) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]

    // Transaction
    await prisma.$transaction(async (tx) => {
      await tx.timeBankEntry.create({
        data: {
          employeeId,
          type: 'EARLY_IN_OT',
          date: dayStart,
          minutes: finalMinutes,
          note: `提早上班OT ${finalMinutes}分（原始 ${rawEarly}分）`,
          createdBy: auth.session.userId,
        },
      })

      // Audit: EARLY_OT_APPROVE
      await tx.auditLog.create({
        data: {
          actorId: auth.session.userId,
          action: 'EARLY_OT_APPROVE',
          entity: 'TimeBankEntry',
          entityId: '', // will be filled after create
          targetEmployeeId: employeeId,
          clinicId: shiftForAudit.clinicId,
          beforeJson: JSON.stringify({ balanceMinutes: beforeBalance }),
          afterJson: JSON.stringify({
            shiftId: shiftForAudit.id,
            shiftStart: shiftForAudit.startTime.toISOString(),
            punchRecordId: clockInPunch?.raw.id || '',
            clockInEffective: clockInPunch?.effectiveTime.toISOString() || '',
            rawEarlyMinutes: rawEarly,
            gate: cfg.earlyInMinMinutes ?? 15,
            otMinMinutes: cfg.otMinMinutes ?? 0,
            otRoundMinutes: cfg.otRoundMinutes ?? 0,
            finalMinutes,
            balanceBefore: beforeBalance,
          }),
          notes: `批准提早上班OT：${date} +${finalMinutes} 分（原始 ${rawEarly}分）`,
        },
      } as any)

      // 自批檢查：employee.userId === session.userId → 另寫 EARLY_OT_SELF_APPROVE
      if (employee.userId === auth.session.userId) {
        await tx.auditLog.create({
          data: {
            actorId: auth.session.userId,
            action: 'EARLY_OT_SELF_APPROVE',
            entity: 'TimeBankEntry',
            entityId: '',
            targetEmployeeId: employeeId,
            clinicId: shiftForAudit.clinicId,
            afterJson: JSON.stringify({
              date,
              rawEarlyMinutes: rawEarly,
              finalMinutes,
              balanceBefore: beforeBalance,
            }),
            notes: `⚠️ 自批提早上班OT：${date} +${finalMinutes} 分`,
          },
        } as any)
      }
    })

    // Invalidate TimeBank so carry chain recalculates
    try {
      await invalidateTimeBankFrom(employeeId, dayStart, prisma)
    } catch (e) {
      console.error(`[timebank-cache] invalidate failed employeeId=${employeeId} date=${dayStart}`, e)
    }

    return NextResponse.json({ success: true, finalMinutes, rawEarly })
  } catch (err: any) {
    console.error('early-in-ot error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
