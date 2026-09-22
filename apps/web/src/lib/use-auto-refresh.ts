'use client'
/**
 * ★ cwm-provroster S4（B4 / CHECK §3.1 對齊）：醫生當值表／時間表自動更新 hook。
 *   唔再係獨立實作 —— 改做 useLiveRefresh（consistency Stage 5.2）嘅 wrapper：
 *   - 每 ms 毫秒一次（只喺分頁「見到」時跑）
 *   - 返到頁面（visibilitychange → visible）／focus → 即刻跑（2 秒去抖，useLiveRefresh 口徑）
 *   - 其他 tab 改咗 'provider' topic（notifyDataChanged）→ 即刻 refetch（同機跨分頁即時同步）
 *   - enabled=false（有 modal／詳情面板開住）→ 暫停，免得更新蓋走用戶正在填嘅嘢
 * ⚠️ 兩 hook 唔好掛同一頁（會雙倍 fetch）—— provider 兩頁只用呢個 wrapper，唔好用 useLiveRefresh。
 */
import { useLiveRefresh } from './live-refresh'

export function useAutoRefresh(fn: () => void, ms: number, enabled = true) {
  useLiveRefresh(fn, ['provider'], { intervalMs: ms, enabled })
}
