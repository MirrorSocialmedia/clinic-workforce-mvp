'use client'
import { useEffect, useRef } from 'react'

export type DataTopic = 'attendance' | 'correction' | 'leave' | 'schedule' | 'payroll' | 'timebank'
const CH = 'cwm-data-changed'
let bc: BroadcastChannel | null = null
function channel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return null
  return (bc ??= new BroadcastChannel(CH))
}

/** ★ Stage 5.2：mutation 成功後叫 —— 同一部機其他 tab 即刻 refetch（Test 9） */
export function notifyDataChanged(...topics: DataTopic[]): void {
  try { channel()?.postMessage({ topics, at: Date.now() }) } catch { /* ignore */ }
}

/**
 * ★ Stage 5.2：頁面用
 *   ① 切返呢個 tab／視窗 focus → 即 refetch（休眠／斷線返嚟 = REST snapshot 恢復，Test 5）
 *   ② 可見時每 intervalMs refetch（其他用戶嘅改動，Test 1 / 10）
 *   ③ 其他 tab 改咗相關 topic → 即 refetch
 *   2 秒去抖，防三個 trigger 疊埋一齊打；mount 當刻唔重複 fetch
 */
export function useLiveRefresh(
  refetch: () => unknown,
  topics: DataTopic[],
  opts: { intervalMs?: number; enabled?: boolean } = {},
): void {
  const fn = useRef(refetch)
  fn.current = refetch
  const key = topics.join(',')
  const enabled = opts.enabled ?? true
  useEffect(() => {
    if (!enabled) return
    let last = Date.now()               // mount 嗰下頁面自己已經 fetch 咗
    const run = () => {
      const now = Date.now()
      if (now - last < 2000) return
      last = now
      void fn.current()
    }
    const onVis = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    const t = opts.intervalMs
      ? setInterval(() => { if (document.visibilityState === 'visible') run() }, opts.intervalMs)
      : null
    const c = channel()
    const want = key.split(',')
    const onMsg = (e: MessageEvent) => {
      if ((e.data?.topics ?? []).some((x: string) => want.includes(x))) run()
    }
    c?.addEventListener('message', onMsg)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
      if (t) clearInterval(t)
      c?.removeEventListener('message', onMsg)
    }
  }, [key, opts.intervalMs, enabled])
}
