import prisma from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from './hk-date'
import { getEffectivePunches } from './punch-query'
import { matchPunchesToShifts } from './shift-punch-match'
import { invalidateTimeBankFrom } from './punch-query'

/**
 * 由 PayRule.configJson（string 或已 parse 的 object）讀出 Early-in OT 設定。
 * JSON 中的 key 是 snake_case（RuleComposerModal 寫入格式），
 * 返回 camelCase 給 computeEarlyInOt 使用。
 * 三個 caller（approve route、revoke、exceptions route）都用這個函數。
 */
export function readEarlyInOtCfg(configJson?: string | null | Record<string, any>): {
  earlyInMinMinutes: number
  otMinMinutes: number
  otRoundMinutes: number
} {
  try {
    const obj = typeof configJson === 'string' ? JSON.parse(configJson) : (configJson ?? {})
    const ot = obj?.modifiers?.overtime ?? {}
    return {
      earlyInMinMinutes: ot.early_in_min_minutes ?? 15,
      otMinMinutes: ot.ot_min_minutes ?? 0,
      otRoundMinutes: ot.ot_round_minutes ?? 0,
    }
  } catch {
    return { earlyInMinMinutes: 15, otMinMinutes: 0, otRoundMinutes: 0 }
  }
}

/**
 * 計算提早上班 OT 分鐘（過門檻 + 取整後）。
 * 門檻係閘，唔係扣減：rawEarly = 20、門檻 15 → 計 20，唔係計 5。
 * 次序：threshold first, then round（同 payroll-engine.ts:1581-1588 一致）。
 */
export function computeEarlyInOt(
  rawEarlyMinutes: number,
  cfg: { earlyInMinMinutes?: number; otMinMinutes?: number; otRoundMinutes?: number },
): number {
  const gate = Math.max(cfg.earlyInMinMinutes ?? 15, cfg.otMinMinutes ?? 0)
  if (rawEarlyMinutes < gate) return 0
  const round = cfg.otRoundMinutes ?? 0
  return round > 0 ? Math.floor(rawEarlyMinutes / round) * round : rawEarlyMinutes
}

/**
 * 打卡一改 → 自動撤回 stale EARLY_IN_OT entry。
 *
 * 第 3 步：重算結果一樣就唔撤回（例如改 CLOCK_OUT 唔影響早到分鐘）。
 * 只喺重算結果變化先 delete。
 *
 * ★ 五個 hook 位都用呢個 lib：
 * 1. punch-corrections/[id]/route.ts — 補卡批准
 * 2. punch-corrections/route.ts — 經理直接建補卡
 * 3. punches/[id]/void/route.ts — 打卡作廢
 * 4. shifts/[id]/route.ts PUT — 改更
 * 5. shifts/[id]/route.ts DELETE — 刪更
 */
export async function revokeStaleEarlyOt(
  employeeId: string,
  dateStr: string,
  actorId: string,
  reason: string,
  db = prisma,
): Promise<{ revoked: boolean; minutes?: number }> {
  const dayStart = hkDateStart(dateStr)
  const dayEnd = hkDateEnd(dateStr)

  // 1. findFirst EARLY_IN_OT entry that day
  const entry = await db.timeBankEntry.findFirst({
    where: {
      employeeId,
      type: 'EARLY_IN_OT',
      date: { gte: dayStart, lte: dayEnd },
    },
  })
  if (!entry) return { revoked: false }

  // 2. 重算 finalMinutes（同批准時完全同一條路）
  // 2a: 攞當日 shift + effective punches
  const shifts = await db.shift.findMany({
    where: {
      employeeId,
      date: { gte: dayStart, lte: dayEnd },
      status: { not: 'CANCELLED' },
    },
  })
  const effectivePunches = await getEffectivePunches(dayStart, dayEnd, {
    employeeId,
    db,
  })

  if (shifts.length === 0 || effectivePunches.length === 0) {
    // 冇 shift 或冇 punch → 重算結果一定係 0，同 entry.minutes 唔同 → 撤回
    await db.timeBankEntry.delete({ where: { id: entry.id } })

    await db.auditLog.create({
      data: {
        actorId,
        action: 'EARLY_OT_AUTO_REVOKE',
        entity: 'TimeBankEntry',
        entityId: entry.id,
        targetEmployeeId: employeeId,
        beforeJson: JSON.stringify({
          minutes: entry.minutes,
          date: dateStr,
          reason: '重算結果為 0（無排班或無打卡）',
        }),
        afterJson: JSON.stringify({ trigger: reason, newFinalMinutes: 0 }),
        notes: `⚠️ 打卡改動·自動撤回提早OT：${dateStr} −${entry.minutes}分（${reason}）`,
      },
    } as any)

    try {
      await invalidateTimeBankFrom(employeeId, dayStart, db)
    } catch (e) {
      console.error(`[timebank-cache] invalidate failed employeeId=${employeeId} date=${dayStart}`, e)
    }

    return { revoked: true, minutes: entry.minutes }
  }

  const matched = matchPunchesToShifts(
    shifts as any,
    effectivePunches as any,
  )

  // 攞 earliest earlyInMinutes（可能有多張更）
  const rawEarly = matched.reduce(
    (max, m) => Math.max(max, m.earlyInMinutes ?? 0),
    0,
  )

  // 2b: 攞 payRule config
  const empPayRule = await db.payRule.findFirst({
    where: {
      employeeId,
      isActive: true,
      effectiveFrom: { lte: dayEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: dayStart } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  })
  const cfg = readEarlyInOtCfg(empPayRule?.configJson)

  const recomputed = computeEarlyInOt(rawEarly, cfg)

  // 3. 重算 === entry.minutes → 唔使郁（例如改 CLOCK_OUT 唔影響早到）
  if (recomputed === entry.minutes) return { revoked: false }

  // 4. 唔同 → delete + audit + invalidate
  await db.timeBankEntry.delete({ where: { id: entry.id } })

  await db.auditLog.create({
    data: {
      actorId,
      action: 'EARLY_OT_AUTO_REVOKE',
      entity: 'TimeBankEntry',
      entityId: entry.id,
      targetEmployeeId: employeeId,
      beforeJson: JSON.stringify({ minutes: entry.minutes, date: dateStr }),
      afterJson: JSON.stringify({
        trigger: reason,
        rawEarlyMinutes: rawEarly,
        newFinalMinutes: recomputed,
        cfg,
      }),
      notes: `⚠️ 打卡改動·自動撤回提早OT：${dateStr} −${entry.minutes}分（重算=${recomputed}分，${reason}）`,
    },
  } as any)

  try {
    await invalidateTimeBankFrom(employeeId, dayStart, db)
  } catch (e) {
    console.error(`[timebank-cache] invalidate failed employeeId=${employeeId} date=${dayStart}`, e)
  }

  return { revoked: true, minutes: entry.minutes }
}
