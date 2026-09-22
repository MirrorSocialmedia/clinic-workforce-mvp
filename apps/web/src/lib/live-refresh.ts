'use client'
import { useEffect, useRef } from 'react'

export type DataTopic = 'attendance' | 'correction' | 'leave' | 'schedule' | 'payroll' | 'timebank' | 'provider' // ★ cwm-provroster B4：醫生當值表／時間表 topic
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
  // ★ F-2：「上次 refetch 時間」放 ref —— 開關 modal（enabled 變）令 effect 重跑都唔會 reset
  const lastRef = useRef(Date.now())   // mount 嗰下頁面自己已經 fetch 咗
  const key = topics.join(',')
  const enabled = opts.enabled ?? true
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const fire = () => {
      lastRef.current = Date.now()
      // ★ F-3：refetch reject／throw 唔好變 unhandled rejection
      Promise.resolve().then(() => fn.current()).catch(() => { /* 頁面自己處理錯誤 */ })
    }
    const run = () => {
      const wait = lastRef.current + 2000 - Date.now()
      if (wait > 0) {
        // ★ F-1：2 秒窗口內唔丟，排一次尾班（trailing）—— 否則 1 秒內連建兩格更，另一個 tab 只會同步到第一格
        if (!timer) timer = setTimeout(() => { timer = null; fire() }, wait)
        return
      }
      fire()
    }
    // ★ F-2：由 disabled 變返 enabled（例如面板／modal 關咗）而且已經超過一個 interval 冇更新 → 即刻補一次
    if (opts.intervalMs && Date.now() - lastRef.current > opts.intervalMs) run()
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
      if (timer) clearTimeout(timer)
      c?.removeEventListener('message', onMsg)
    }
  }, [key, opts.intervalMs, enabled])
}
