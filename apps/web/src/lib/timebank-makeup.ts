// ★ cwm-attbatch-20260927：補鐘共用邏輯（單筆 + 批量共用，避免兩邊規則漂移）
// 抽出自 src/app/api/timebank/makeup/route.ts（原 L79–120 / L131 / L136）。
import { diffMinutes } from '@/lib/shift-punch-match'
import { getEffectivePunches } from '@/lib/punch-query'

export type MakeupTarget = 'LATE' | 'LATE_LUNCH' | 'EARLY_LEAVE'

/**
 * 重算當日實際遲到／早退分鐘。
 * 由單筆 route（makeup/route.ts）L79–120 原封不動搬出嚟；單筆同批量都用佢。
 * @returns null = 當日搵唔到更；否則 = 實際分鐘（≥ 0；0 = 冇遲到／冇早退）
 */
export async function computeActualMakeupMinutes(
  db: any, employeeId: string, date: string, targetType: MakeupTarget,
): Promise<number | null> {
  const dateStart = new Date(date + 'T00:00:00+08:00')
  const shift = await db.shift.findFirst({
    where: {
      employeeId,
      date: dateStart,
      status: { not: 'CANCELLED' },
    },
  })
  if (!shift) return null

  const dayStart = new Date(date + 'T00:00:00+08:00')
  const dayEnd = new Date(date + 'T23:59:59+08:00')
  const dayPunches = await getEffectivePunches(dayStart, dayEnd, { employeeId, db })

  let actualMinutes = 0
  if (targetType === 'LATE' || targetType === 'LATE_LUNCH') {
    const clockIn = dayPunches
      .filter((ep: any) => ep.punchType === 'CLOCK_IN')
      .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
    if (clockIn && clockIn.effectiveTime.getTime() > new Date(shift.startTime).getTime()) { // CALC-OK: makeup validation, not general calculation
      actualMinutes = diffMinutes(clockIn.effectiveTime, new Date(shift.startTime))
    }
  } else {
    const clockOut = dayPunches
      .filter((ep: any) => ep.punchType === 'CLOCK_OUT')
      .sort((a: any, b: any) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]
    if (clockOut && clockOut.effectiveTime.getTime() < new Date(shift.endTime).getTime()) {
      actualMinutes = -diffMinutes(clockOut.effectiveTime, new Date(shift.endTime))
    }
  }
  return actualMinutes
}

/** 同單筆 route 完全一樣嘅 date 寫法（UTC 午夜）—— TimeBankEntry_makeup_once unique index 靠佢 */
export const makeupEntryDate = (date: string) => new Date(date)

export function makeupNote(targetType: MakeupTarget, minutes: number) {
  return `補鐘：${targetType === 'EARLY_LEAVE' ? '早退' : '遲到'} ${minutes}分`
}

/**
 * 時薪判斷：同 exceptions API（payroll-runs/exceptions/route.ts L123–205）同一口徑
 * —— 當月生效、最新一條 active PayRule（effectiveFrom desc, createdAt desc 第一條）
 * configJson.base_type === 'hourly'。壞 JSON 當非時薪。
 */
export async function isHourlyForMonth(db: any, employeeId: string, monthStart: Date, monthEnd: Date): Promise<boolean> {
  const r = await db.payRule.findFirst({
    where: { employeeId, isActive: true, effectiveFrom: { lte: monthEnd },
             OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }] },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    select: { configJson: true },
  })
  try { return JSON.parse(r?.configJson || '{}')?.base_type === 'hourly' } catch { return false }
}

/**
 * 批量補鐘：開始處理新項目嘅時間上限。要留位畀：最後一筆 tx（timeout 8s）+ commit 後工序
 * （每員工 invalidate、最多 200 次 flagIfSelfEdit、批次總結 audit），總數要 < nginx proxy_read_timeout 60s
 * ★ cwm-deployguard-20260928 P3-3：由 45s 調低到 40s，計入迴圈之後嘅工序
 */
export const BATCH_DEADLINE_MS = 40_000
