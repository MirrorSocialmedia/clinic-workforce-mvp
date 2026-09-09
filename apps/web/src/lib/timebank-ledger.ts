/**
 * cwm-tbledger-20260909 — 共用時間帳戶帳本 builder
 *
 * ★★★ 凍結側（finalize 寫 snapshot）同讀取側（總覽 UI）必須用同一個 function。
 *   分開寫就係 LeaveBalanceSnapshot 同一個坑（凍結/實時兩份數據源漂移）。
 *
 * 帳本永遠要加得埋（MD 硬性要求）：
 *   opening + Σ lines === closing
 *   加唔埋就補一行 RECONCILE/UNEXPLAINED（⚠️ 未分類差額），唔准靜靜唔見咗。
 */
import { calculateTimeBank } from './payroll-engine'
import { toHKDateStr, getMonthRange } from './hk-date'

/** ★ 入帳嘅實體 entry type —— ⚠️ RESTDAY_GRANT 唔喺度（假期發放，另一本帳） */
export const TB_LEDGER_ENTRY_TYPES = [
  'MAKEUP', 'LEAVE_CONVERT', 'LEAVE_SWAP_BACK', 'INIT_ADJUST', 'REST_TO_ACCOUNT', 'ROSTER_DIFF',
] as const

export interface LedgerLine {
  date: string                 // 'YYYY-MM-DD'（HK）
  kind: 'DERIVED' | 'ENTRY' | 'RECONCILE'
  type: string                 // 'OT' / 'LATE' / 'MAKEUP' / 'ROSTER_DIFF' …
  label: string                // 顯示文案
  minutes: number              // 入帳金額（顯示用嘅 0 影響行 = 0）
  note?: string | null
  entryId?: string | null      // ENTRY 行先有 —— 可以追返 DB
  informational?: boolean      // true = 顯示但唔入帳（遲到／早退補鐘）
}

export interface LedgerMonth {
  periodMonth: string
  opening: number
  closing: number
  lines: LedgerLine[]
  reconciles: boolean          // opening + Σ === closing
  frozen: boolean
  frozenAt?: string | null
  engineVersion?: number | null
}

export async function buildTimeBankLedger(
  db: any,
  employeeId: string,
  periodMonth: string,          // 'YYYY-MM'
  cfg: any = {},
): Promise<LedgerMonth> {
  const monthDate = new Date(`${periodMonth}-01T00:00:00+08:00`)
  const { start, end } = getMonthRange(monthDate)
  const tb = await calculateTimeBank(employeeId, monthDate, cfg, db)

  const lines: LedgerLine[] = []

  // ① 推導行 —— 由 timeAccountDetail（逐日考勤）出，同糧單七種一致
  //    ⚠️ 用【原始】遲到／早退，唔用淨值 —— 化簡後 mLate/mEarly 會同補鐘行對消
  for (const d of (tb.timeAccountDetail ?? []) as any[]) {
    if (d.clockOutOt) lines.push({ date: d.date, kind: 'DERIVED', type: 'OT', label: '下班 OT', minutes: d.clockOutOt })
    if (d.holidayOt)  lines.push({ date: d.date, kind: 'DERIVED', type: 'OT', label: 'OT', minutes: d.holidayOt })
    if (d.earlyInOt)  lines.push({ date: d.date, kind: 'DERIVED', type: 'EARLY_IN_OT', label: '提早上班 OT', minutes: d.earlyInOt })
    if (d.lunchOt)    lines.push({ date: d.date, kind: 'DERIVED', type: 'LUNCH_OT', label: '午休 OT（少休）', minutes: d.lunchOt })
    if (d.lateMinutes)  lines.push({ date: d.date, kind: 'DERIVED', type: 'LATE', label: '上班遲到', minutes: -d.lateMinutes })
    if (d.earlyMinutes) lines.push({ date: d.date, kind: 'DERIVED', type: 'EARLY_LEAVE', label: '早退', minutes: -d.earlyMinutes })
    if (d.lunchLate)    lines.push({ date: d.date, kind: 'DERIVED', type: 'LUNCH_LATE', label: '午休遲到（超休）', minutes: -d.lunchLate })
  }

  // ② 實體行
  const entries = await db.timeBankEntry.findMany({
    where: { employeeId, type: { in: [...TB_LEDGER_ENTRY_TYPES] }, date: { gte: start, lte: end } },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })
  for (const e of entries) {
    if (e.type === 'MAKEUP' && e.targetType !== 'ABSENT') {
      // ★ 遲到／早退補鐘：淨效果係零（抵銷咗遲到扣減，同時消耗等額 OT）。
      //   顯示出嚟俾人知發生過，但【唔准入帳】—— 入咗就係雙重扣。
      lines.push({
        date: toHKDateStr(e.date), kind: 'ENTRY', type: 'MAKEUP_OFFSET',
        label: e.targetType === 'EARLY_LEAVE' ? '早退補鐘（已抵銷，不影響餘額）' : '遲到補鐘（已抵銷，不影響餘額）',
        minutes: 0, note: e.note, entryId: e.id, informational: true,
      })
      continue
    }
    lines.push({
      date: toHKDateStr(e.date), kind: 'ENTRY', type: e.type,
      label: ledgerLabel(e), minutes: e.minutes, note: e.note, entryId: e.id,
    })
  }

  lines.sort((a, b) => a.date.localeCompare(b.date))

  // ③ ★★★ 強制對數 —— 加唔埋就補一行，唔准靜靜唔見咗
  const opening = tb.carriedFrom ?? 0
  const closing = tb.balance ?? 0
  const sum = lines.reduce((s, l) => s + l.minutes, 0)
  const gap = closing - (opening + sum)
  let reconciles = true
  if (gap !== 0) {
    reconciles = false
    lines.push({
      date: `${periodMonth}-31`, kind: 'RECONCILE', type: 'UNEXPLAINED',
      label: '⚠️ 未分類差額（帳本加唔埋，請報告）', minutes: gap,
    })
  }

  return { periodMonth, opening, closing, lines, reconciles, frozen: false }
}

function ledgerLabel(e: any): string {
  switch (e.type) {
    case 'MAKEUP': return '缺勤扣OT鐘'            // 只會係 ABSENT（其餘已喺上面 return）
    case 'LEAVE_CONVERT': return 'OT 換假'
    case 'LEAVE_SWAP_BACK': return '換假退回'
    case 'INIT_ADJUST': return '初始化調整'
    case 'REST_TO_ACCOUNT': return '休息日轉入'
    case 'ROSTER_DIFF': return '編更差額'
    default: return e.type
  }
}
