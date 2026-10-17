export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { flagIfSelfEdit } from '@/lib/self-edit-flag'
import { lockEmployee, toHttpResponse, HttpError } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx } from '@/lib/payroll-lock'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'
import { toHKDateStr } from '@/lib/hk-date'
import { validateManualReverse } from '@/lib/timebank-manual'

// ★ cwm-tbmanual-20261017 ①：撤銷手動調整 —— 自動寫一行相反數（reversesEntryId 連結原本行）
// POST /api/timebank/manual-adjust/reverse { entryId, reason? }
//   只限 OWNER。原本行必須係 MANUAL_ADJUST 而且本身唔係撤銷行（撤銷行再撤銷 → 400）。
//   月份用【原本行嘅月份】鎖（鎖咗 → 409，叫佢喺新月份做相反調整）。
//   每行只可以撤銷一次 —— partial unique index 撞 → P2002 → 409「已經撤銷過」。
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') { // ROLE-OK: 撤銷 = 憑空加減鐘，維持 OWNER-only
    return NextResponse.json({ error: '只有老闆可撤銷手動調整' }, { status: 403 })
  }

  const v = validateManualReverse(await req.json().catch(() => null))
  if (!v.ok) return NextResponse.json({ error: v.error, code: v.code }, { status: v.status })
  const { entryId, reason } = v.value

  // 先讀原本行攞 employeeId（tx 內會再讀一次現狀，防鎖前快照）
  const pre = await prisma.timeBankEntry.findUnique({ where: { id: entryId } })
  if (!pre) return NextResponse.json({ error: '找不到原本調整行' }, { status: 404 })

  let newEntryId = ''
  let balanceBefore = 0
  let balanceAfter = 0
  try {
    await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, pre.employeeId)

      // ★ 重讀現狀（lock 之後）：必須 MANUAL_ADJUST 而且本身唔係撤銷行
      const orig = await tx.timeBankEntry.findUnique({ where: { id: entryId } })
      if (!orig || orig.type !== 'MANUAL_ADJUST') {
        throw new HttpError(400, '只有手動調整行先可以撤銷')
      }
      if (orig.reversesEntryId != null) {
        throw new HttpError(400, '撤銷行唔可以再撤銷')
      }

      // ★ 月份用原本行嘅月份（寫入時斷言；撳到呢度已過一次，tx 內再驗防 TOCTOU）
      const origMonth = toHKDateStr(orig.date).slice(0, 7)
      await assertMonthsUnlockedTx(tx, {
        actorId: auth.session.userId, employeeId: orig.employeeId, months: [origMonth], what: '撤銷手動調整',
      })

      const emp = await tx.employee.findUnique({
        where: { id: orig.employeeId },
        select: { payRules: PAY_RULE_SELECT },
      })
      let cfg: any = {}
      try { cfg = emp ? JSON.parse(emp.payRules?.[0]?.configJson || '{}') : {} } catch { /* 壞 JSON 當冇 config */ }

      const tb = await calculateTimeBank(orig.employeeId, orig.date, cfg, tx)
      balanceBefore = tb.balance ?? 0

      const rev = await tx.timeBankEntry.create({
        data: {
          employeeId: orig.employeeId,
          // ★ 撤銷行記喺原本行同一日（同月份帳本配對顯示；月份已驗未鎖，安全）
          date: orig.date,
          type: 'MANUAL_ADJUST',
          minutes: -orig.minutes,
          reversesEntryId: orig.id,
          note: `撤銷手動調整（原 ${orig.minutes >= 0 ? '+' : ''}${orig.minutes} 分鐘）${reason ? `：${reason}` : ''}`,
          createdBy: auth.session.userId,
        },
      })
      newEntryId = rev.id
      balanceAfter = balanceBefore + rev.minutes

      await tx.auditLog.create({
        data: {
          actorId: auth.session.userId, action: 'TIMEBANK_MANUAL_REVERSE', entity: 'TimeBank',
          entityId: orig.employeeId, targetEmployeeId: orig.employeeId,
          beforeJson: JSON.stringify({ balance: balanceBefore }),
          afterJson: JSON.stringify({ balance: balanceAfter }),
          notes: JSON.stringify({
            minutes: rev.minutes, effectiveMonth: origMonth, reason,
            entryId: orig.id, reversedEntryId: rev.id,
          }),
        },
      } as any)
      await invalidateTimeBankFrom(orig.employeeId, orig.date, tx)
    })
  } catch (e: any) {
    // ★ 第二次撤銷：partial unique（reversesEntryId）撞 → P2002 → 409
    if (e?.code === 'P2002') {
      return NextResponse.json({ error: '已經撤銷過', code: 'ALREADY_REVERSED' }, { status: 409 })
    }
    const r = toHttpResponse(e); if (r) return r
    throw e
  }

  await flagIfSelfEdit({
    actorUserId: auth.session.userId,
    targetEmployeeId: pre.employeeId,
    what: '撤銷手動調整時間帳戶',
    detail: { entryId, reason },
    req,
  })

  return NextResponse.json({ ok: true, entryId, reversedEntryId: newEntryId, balanceBefore, balanceAfter })
}
