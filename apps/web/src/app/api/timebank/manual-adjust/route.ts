export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { flagIfSelfEdit } from '@/lib/self-edit-flag'
import { lockEmployee, toHttpResponse } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx } from '@/lib/payroll-lock'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'
import { validateManualAdjust } from '@/lib/timebank-manual'

// ★ cwm-tbmanual-20261017 ①：時間帳戶手動調整（累加語義，唔刪舊行）
// POST /api/timebank/manual-adjust { employeeId, minutes, effectiveMonth, reason, confirmLarge? }
//   只限 OWNER（同初始化一樣：可以憑空加減鐘）。
//   流程全部喺一個 prisma.$transaction：
//     lockEmployee → assertMonthsUnlockedTx → 記 balanceBefore（calculateTimeBank，唔係 entry 加總）
//     → 寫 MANUAL_ADJUST 行 → audit → invalidateTimeBankFrom
//   |minutes| > 480 要 confirmLarge: true（409 CONFIRM_REQUIRED → 前端彈確認再送）。
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') { // ROLE-OK: 可憑空加減時間帳戶，維持 OWNER-only（同 init-adjust）
    return NextResponse.json({ error: '只有老闆可手動調整時間帳戶' }, { status: 403 })
  }

  const v = validateManualAdjust(await req.json().catch(() => null))
  if (!v.ok) return NextResponse.json({ error: v.error, code: v.code }, { status: v.status })
  const { employeeId, minutes, effectiveMonth, reason } = v.value

  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, payRules: PAY_RULE_SELECT },
  })
  if (!emp) return NextResponse.json({ error: '找不到員工' }, { status: 404 })
  let cfg: any = {}
  try { cfg = JSON.parse(emp.payRules?.[0]?.configJson || '{}') } catch { /* 壞 JSON 當冇 config */ }

  const date = new Date(`${effectiveMonth}-01T00:00:00+08:00`)

  let entryId = ''
  let balanceBefore = 0
  let balanceAfter = 0
  try {
    await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId)
      await assertMonthsUnlockedTx(tx, {
        actorId: auth.session.userId, employeeId, months: [effectiveMonth], what: '手動調整時間帳戶',
      })
      // ★ balance 口徑 = calculateTimeBank（同帳本／儀表板同一來源），唔係 entry 加總（41131 分嘅坑）
      const tb = await calculateTimeBank(employeeId, date, cfg, tx)
      balanceBefore = tb.balance ?? 0
      const entry = await tx.timeBankEntry.create({
        data: {
          employeeId, date, type: 'MANUAL_ADJUST', minutes,
          note: `手動調整 ${minutes >= 0 ? '+' : ''}${minutes} 分鐘：${reason}`,
          createdBy: auth.session.userId,
        },
      })
      entryId = entry.id
      balanceAfter = balanceBefore + minutes
      await tx.auditLog.create({
        data: {
          actorId: auth.session.userId, action: 'TIMEBANK_MANUAL_ADJUST', entity: 'TimeBank', entityId: employeeId,
          targetEmployeeId: employeeId,
          beforeJson: JSON.stringify({ balance: balanceBefore }),
          afterJson: JSON.stringify({ balance: balanceAfter }),
          notes: JSON.stringify({ minutes, effectiveMonth, reason, entryId }),
        },
      } as any)
      await invalidateTimeBankFrom(employeeId, date, tx)
    })
  } catch (e: any) {
    const r = toHttpResponse(e); if (r) return r
    throw e
  }

  // ★ cwm-antitamper P1-6：自己改自己標紅（記，唔擋）
  await flagIfSelfEdit({
    actorUserId: auth.session.userId,
    targetEmployeeId: employeeId,
    what: '手動調整時間帳戶',
    detail: { minutes, effectiveMonth, reason },
    req,
  })

  return NextResponse.json({ ok: true, entryId, balanceBefore, balanceAfter })
}
