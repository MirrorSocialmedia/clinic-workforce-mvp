/**
 * ★ 醫生當值表「每週固定 pattern」純邏輯（trace: cw-patwl-20260822-a1）
 *
 * 設計原則（照 provider-availability-view.ts）：
 * - 全部純 function（無 react / 無 fetch / 無 DB）→ node:test 可以直接斷言。
 * - client（當值表 / 診所設定）+ server（provider-availability API）共用同一份。
 *
 * 查詢時三層疊（MD §1.3）：
 *   ① pattern 展開該週 → 基礎當值
 *   ② ProviderShift 覆蓋（同日同店有 row 就用佢；slot='OFF' = 當日唔返）
 *   ③ ProviderLeave 蓋走（請假就當冇當值）
 */

// ─── 類型 ───

export interface SlotTimes { start: string; end: string }
export type SlotKey = 'FULL' | 'AM' | 'PM'
export type SlotMap = Record<SlotKey, SlotTimes>

/** ProviderWeeklyPattern row（clinic 層，weekly 唔依賴 date） */
export interface PatternRow {
  providerId: string
  /** 0=日 … 6=六（同 JS getDay 一致） */
  weekday: number
  /** 'FULL' | 'AM' | 'PM' */
  slot: string
}

/** 該日 ProviderShift（例外）row；date = 'YYYY-MM-DD'（HK） */
export interface ShiftRow {
  providerId: string
  date: string
  /** 'FULL' | 'AM' | 'PM' | 'OFF' | null（null = 用 startTime/endTime） */
  slot: string | null
}

// ─── 時段定義（拍板①：時間由診所設定帶出，pattern 只存 slot）────

/** 預設 fallback 時段（Clinic.config.providerSlots 冇設定 / 壞咗就用呢套） */
export const DEFAULT_SLOTS: SlotMap = {
  FULL: { start: '10:00', end: '20:00' },
  AM: { start: '10:00', end: '13:00' },
  PM: { start: '14:00', end: '20:00' },
}

/**
 * 由 Clinic.config 攞時段定義；冇設定就用預設。
 * ⚠️ try/catch 唔可以省 —— config 係自由 JSON 字串，壞咗唔應該令成頁爆。
 */
export function resolveSlots(clinicConfig: string | null): SlotMap {
  try {
    const c = clinicConfig ? JSON.parse(clinicConfig) : null
    const s = c?.providerSlots
    if (!s) return DEFAULT_SLOTS
    return {
      FULL: s.FULL ?? DEFAULT_SLOTS.FULL,
      AM: s.AM ?? DEFAULT_SLOTS.AM,
      PM: s.PM ?? DEFAULT_SLOTS.PM,
    }
  } catch {
    return DEFAULT_SLOTS
  }
}

// ─── 三層疊 ───

/**
 * 某日某店嘅實際當值醫生（純函數）。
 *
 * @param date     'YYYY-MM-DD'（HK）
 * @param patterns 該店全部 pattern（weekly；function 內按 weekday 匹配）
 * @param shifts   該日 ProviderShift 例外（slot='OFF' = 當日唔返 → 唔計當值；
 *                 null = 用 startTime/endTime → 當 FULL 計）
 * @param leaves   `${providerId}:${date}` 集合（caller 由 startDate~endDate 展開，含當日）
 * @returns Map<providerId, { slot, isException }> —— 當日實際當值
 */
export function resolveOnDuty(
  date: string,
  patterns: PatternRow[],
  shifts: ShiftRow[],
  leaves: Set<string>,
): Map<string, { slot: string; isException: boolean }> {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
  const byProvider = new Map<string, { slot: string; isException: boolean }>()

  // ① pattern
  for (const p of patterns) {
    if (p.weekday === wd) byProvider.set(p.providerId, { slot: p.slot, isException: false })
  }
  // ② 例外覆蓋（★包括「當日唔返」：slot='OFF' → 刪走；null → 當 FULL）
  for (const s of shifts) {
    if (s.date !== date) continue
    if (s.slot === 'OFF') {
      byProvider.delete(s.providerId)
    } else {
      byProvider.set(s.providerId, { slot: s.slot ?? 'FULL', isException: true })
    }
  }
  // ③ 休假蓋走
  for (const pid of [...byProvider.keys()]) {
    if (leaves.has(`${pid}:${date}`)) byProvider.delete(pid)
  }
  return byProvider
}
