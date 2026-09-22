/**
 * ★ cwm-provroster S3：醫生當值表「一格」嘅顯示資料（純函數 —— 桌面表格、手機卡片、當日詳情共用一份）
 *
 * 次序同 resolveOnDuty（provider-pattern.ts）一致：休假 > 例外（含 OFF）> 固定表 > 冇排。
 * 分別：resolveOnDuty 只答「有冇當值」；呢度要答「點顯示、點改」，所以保留 OFF／時間／備註／原始 row。
 */
import { fmtTime } from './hk-date'
import type { SlotKey, SlotMap } from './provider-pattern'

export type CellKind = 'leave' | 'off' | 'duty' | 'none'

export interface CellInfo {
  kind: CellKind
  /** duty 嘅 slot；null = 例外用自訂時間 */
  slot: SlotKey | null
  /** 格內主字：'全日' / 'AM' / 'PM' / '09:30–13:00' / '唔返' / '休假' / '' */
  label: string
  /** 'HH:mm–HH:mm'（duty 先有） */
  time: string | null
  note: string | null
  /** true = 由 ProviderShift 例外嚟（有 ✎，可以「還原固定表」） */
  isException: boolean
  /** 固定表當日 slot（詳情面板顯示「固定表：…」用） */
  patternSlot: SlotKey | null
  shift: any | null
  leave: any | null
}

export const SLOT_TEXT: Record<SlotKey, string> = { FULL: '全日', AM: 'AM', PM: 'PM' }

export function buildCellInfo(args: {
  patternSlot: string | null
  /** 該日該醫生該店嘅 ProviderShift（冇 = null） */
  shift: any | null
  /** 蓋住該日嘅 ProviderLeave（冇 = null） */
  leave: any | null
  slots: SlotMap
}): CellInfo {
  const patternSlot = (args.patternSlot || null) as SlotKey | null
  const base = { patternSlot, shift: args.shift, leave: args.leave }
  if (args.leave) {
    return { ...base, kind: 'leave', slot: null, label: '休假', time: null, note: args.leave.note ?? null, isException: false }
  }
  const sh = args.shift
  if (sh) {
    if (sh.slot === 'OFF') {
      return { ...base, kind: 'off', slot: null, label: '唔返', time: null, note: sh.note ?? null, isException: true }
    }
    const slot = (sh.slot || null) as SlotKey | null
    const time = slot ? `${args.slots[slot].start}–${args.slots[slot].end}` : `${fmtTime(sh.startTime)}–${fmtTime(sh.endTime)}`
    return { ...base, kind: 'duty', slot, label: slot ? SLOT_TEXT[slot] : time, time, note: sh.note ?? null, isException: true }
  }
  if (patternSlot) {
    const t = args.slots[patternSlot]
    return { ...base, kind: 'duty', slot: patternSlot, label: SLOT_TEXT[patternSlot], time: `${t.start}–${t.end}`, note: null, isException: false }
  }
  return { ...base, kind: 'none', slot: null, label: '', time: null, note: null, isException: false }
}

/** 格底色（同舊 chip 色一致：全日藍／AM 黃／PM 紫／自訂灰藍） */
export function cellColors(info: CellInfo): { bg: string; fg: string } {
  if (info.kind === 'leave') return { bg: '#fef3c7', fg: '#b45309' }
  if (info.kind === 'off') return { bg: '#f1f5f9', fg: '#64748b' }
  if (info.slot === 'FULL') return { bg: '#dbeafe', fg: '#1d4ed8' }
  if (info.slot === 'AM') return { bg: '#fef3c7', fg: '#92400e' }
  if (info.slot === 'PM') return { bg: '#e9d5ff', fg: '#6b21a8' }
  return { bg: '#e0f2fe', fg: '#0369a1' }
}

/** 星期一起嘅週首日（hkDayOfWeek 0=日）—— 當值表／休假快捷／批量排共用 */
export function mondayOf(dow: number): number {
  return (dow + 6) % 7
}
