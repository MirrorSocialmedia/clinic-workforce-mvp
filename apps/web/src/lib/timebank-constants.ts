/**
 * 時間銀行「一日」單位 —— 全天唯一真源（9 小時 = 1 日）。
 *
 * ★ 寫入側（api/timebank/convert/route.ts：LEAVE_CONVERT / LEAVE_SWAP_BACK，
 *   init-adjust 同單位）一律寫 `daysInt * TIMEBANK_MINUTES_PER_DAY`；
 *   顯示層「分鐘 → 日」一律除呢個常數（員工端換假日數、計糧頁換假退回日數、
 *   引擎 otConvertedLeave）。
 *
 * ⚠️ 唔好喺其他地方再寫 540 字面量 —— 第三個寫死值出現就會同寫入側 drift。
 * （overview route 另有 config 派生 dayMin 用嚟折「結餘 → 可換假日數」，
 *   嗰個語義唔同，唔係呢度嘅換算單位。）
 */
export const TIMEBANK_MINUTES_PER_DAY = 9 * 60 // 540
