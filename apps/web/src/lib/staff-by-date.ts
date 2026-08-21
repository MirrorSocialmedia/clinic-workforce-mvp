/**
 * ★ cw-pta: 員工當值列（時間表表底）— 共用純邏輯
 * trace: cw-pta-20260821-a1 | Spec: 醫生時間表合併 spec §5（拍板④：放表底）
 *
 * provider-schedule（醫生當值表）同 provider-availability（醫生時間表）
 * 共用同一條 /api/shifts API + 同一份 mapping —— 唔好寫第二份（spec §5.1 #1）。
 *
 * 員工姓名唔應該喺打卡機（KIOSK）顯示 —— caller 請求前用 shouldLoadStaffShifts 判斷，
 * KIOSK / 角色未載入都唔送 request（同 provider-schedule 原有 guard 一致）。
 */
import { fmtTime, toHKDateStr } from './hk-date'

export interface StaffCell {
  id: string
  name: string
  start: string
  end: string
  /** 調鋪（selectedClinic 係佢嘅 secondary clinic）→ 琥珀色 + 「·調」 */
  transfer: boolean
}

/** KIOSK（打卡機）唔顯示員工姓名；角色未載入（''）都先唔送 request */
export function shouldLoadStaffShifts(role: string): boolean {
  return role !== '' && role !== 'KIOSK'
}

/**
 * /api/shifts rows → Map<YYYY-MM-DD (HK), StaffCell[]>（按開始時間排序）。
 * 只計 selectedClinic 嘅 home + 調鋪（secondary）人員；其他店唔計。
 */
export function buildStaffByDate(shifts: any[], selectedClinicId: string | null): Map<string, StaffCell[]> {
  const m = new Map<string, StaffCell[]>()
  for (const s of shifts) {
    const isHome = s.clinicId === selectedClinicId
    const isTransfer = s.secondaryClinicId === selectedClinicId
    if (!isHome && !isTransfer) continue
    const d = toHKDateStr(s.date)
    if (!m.has(d)) m.set(d, [])
    m.get(d)!.push({
      id: s.employeeId,
      name: s.employee?.user?.name ?? '—',
      start: fmtTime(s.startTime),
      end: fmtTime(s.endTime),
      transfer: !isHome && isTransfer,
    })
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name))
  }
  return m
}
