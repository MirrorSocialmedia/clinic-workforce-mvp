/**
 * ★ cw-pta: 醫生休假日期展開（純邏輯，可測試）
 * trace: cw-pta-20260821-a1 | Spec: 醫生時間表合併 spec §4.2
 *
 * ProviderLeave 冇 clinicId —— 跨店生效（一個醫生放假 = 六間店都放，唔使按診所過濾）。
 * startDate/endDate 都係 HK 午夜，endDate 包住當日
 * （provider-leaves POST 用 hkDateStart(endDate) 存，即當日 00:00+08）。
 *
 * 日加減用 provider-availability-view 嘅純函數 addDays（UTC 基準、無時區漂移）；
 * 呢個檔案零外部副作用，node:test 可以直接斷言。
 */
import { toHKDateStr } from './hk-date'
import { addDays } from './provider-availability-view'

export interface LeaveRow {
  providerId: string
  startDate: Date
  endDate: Date
}

/**
 * 將 leaves 展開成 `${providerId}:${YYYY-MM-DD}`（HK 日）Set。
 * start..end 兩端包入（單日假 start==end = 1 日）。
 * 回傳 Set 用於 O(1) 查 `providerId:date` 有冇假。
 */
export function expandLeavesToSet(leaves: LeaveRow[]): Set<string> {
  const set = new Set<string>()
  for (const lv of leaves) {
    let d = toHKDateStr(lv.startDate)
    const end = toHKDateStr(lv.endDate)
    while (d <= end) {
      set.add(`${lv.providerId}:${d}`)
      d = addDays(d, 1)
    }
  }
  return set
}
