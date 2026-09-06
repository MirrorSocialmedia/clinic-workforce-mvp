// ============================================================
// MPF 豁免期純函數 — 2026-09-06 [cwm-mpf60-20260906]（MD §零/§二）
//
// 積金局規則（已查證；套用個案建議打 2918 0102 確認）：
//   ① 60 日規則：受僱 < 60【曆日】→ 唔使登記，僱員部分 0
//      ⚠️ 曆日唔係工作日（條文：「包括假期」）
//   ② 免供款期：受僱首 30 日 + 隨後首個不完整糧期（拍板① 糧期＝曆月）
//      積金局例：1/16 入職 → 首30日 1/16–2/14 → 不完整糧期 2/15–2/28 → 3/1 起供
//      入職日 = 月初（7/1）→ 首30日 7/1–7/30 → 不完整糧期 7/31 → 8/1 起供
//   ③ 有關入息 < $7,100 → 僱員免供（calcMPF 內）
//   ④ 各 5%，上限 $1,500/月（calcMPF 內）
//
// ★ client-safe：只 import hk-date —— engine（server）同結算卡（React client）共用同一來源，
//   防「engine 豁免、顯示層照計」漂移。
// ============================================================

import { toHKDateStr, hkDateStart, getMonthRange } from './hk-date'

const MS_PER_DAY = 86400000

export interface MpfCtx {
  /** 入職日（曆日計算起點） */
  joinDate?: Date | null
  /** 糧期內任一日期（拍板① 糧期＝曆月；用 HK 視角取該月） */
  periodMonth?: Date | null
  /**
   * 受僱實際最後一日（含尾）—— 離職員工傳「最後工作日」
   * （resignedAt 語義 = 最後工作日 +1 日 exclusive，傳之前要 −1 日）。
   * 在職員工唔傳 → 用該糧期月尾。
   */
  lastDay?: Date | null
}

export interface MpfExemptionInfo {
  /** 受僱曆日數（含頭含尾：入職日 → endRef；7/1→9/9 = 71 日） */
  employedDays: number
  /** 該糧期喺免供款期內（首 30 日 + 首個不完整糧期） */
  inExemptPeriod: boolean
  /** 免供款期終點（首 30 日結束嗰個月嘅月尾 23:59:59.999 HK） */
  exemptUntil: Date
}

/**
 * 計算 ① 60 日 同 ② 免供款期 所需口徑。
 * 傳唔到 joinDate / periodMonth → null（caller 當「已過豁免期」= 舊行為）。
 */
export function getMpfExemption(ctx: MpfCtx): MpfExemptionInfo | null {
  if (!ctx?.joinDate || !ctx?.periodMonth) return null

  // ★ ① 60 日規則：離職用 lastDay，在職用該月月底
  const endRef = ctx.lastDay ?? getMonthRange(ctx.periodMonth).end
  const employedDays = Math.floor(
    (hkDateStart(toHKDateStr(endRef)).getTime()
      - hkDateStart(toHKDateStr(ctx.joinDate)).getTime()) / MS_PER_DAY,
  ) + 1 // ★ 含頭含尾（7/1 到 9/9 應該係 71 日）

  // ★ ② 免供款期：首 30 日 = 入職日 + 29；終點 = 嗰個月嘅月尾
  //   （入職 7/2 → day30 = 7/31 啱啱月尾 → 免供款期 = 7 月；入職 1/16 → day30 = 2/14 → 2/28）
  const day30 = new Date(hkDateStart(toHKDateStr(ctx.joinDate)).getTime() + 29 * MS_PER_DAY)
  const exemptUntil = getMonthRange(day30).end
  const inExemptPeriod = getMonthRange(ctx.periodMonth).end <= exemptUntil

  return { employedDays, inExemptPeriod, exemptUntil }
}
