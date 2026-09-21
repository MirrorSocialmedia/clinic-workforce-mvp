'use client'
import { useCallback, useRef } from 'react'

/**
 * ★ cwm-consistency Stage 5.1：每次 begin() 會 abort 上一個請求，並回傳 isLatest()。
 *   response 返嚟時唔係最新就丟棄 —— 慢嘅舊 response 永遠唔會蓋過新 state（Test 7 / 13）。
 */
export function useLatestRequest() {
  const seq = useRef(0)
  const ctrl = useRef<AbortController | null>(null)
  return useCallback(() => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    const my = ++seq.current
    return { signal: c.signal, isLatest: () => my === seq.current && !c.signal.aborted }
  }, [])
}
