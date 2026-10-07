'use client'

// ============================================================
// ★ cwm-dailyv2-20261007 ②：Apricot 同步 job 共用 poll hook（每 2 秒一次）
//   /apricot-sync 頁 + /payout/daily 頁共用 —— 唔好抄兩份（MD ② 前端）。
//   - GET /api/apricot/sync/jobs/:id → { job }；RUNNING 持續 poll 到終態
//     （DONE / FAILED / CANCELLED）先停。
//   - latestRef：跟住嘅 jobId 記喺 ref；舊 job 嘅遲到回應直接忽略
//     （防舊回應覆蓋新狀態 — MD ② 要求）。
//   - unmount 自動 clearInterval；start(新 jobId) 會先停舊 poll。
//   - 單次 poll 失敗唔致命（網絡抖），下 2 秒再試。
// ============================================================
import { useCallback, useEffect, useRef } from 'react'

export interface ApricotJobSnapshot {
  id: string
  status: string // RUNNING / DONE / FAILED / CANCELLED
  currentStep: string | null
  errorMessage: string | null
  totalClinics: number
  doneClinics: number
  paymentsSynced?: number
  billsChecked?: number
  allocRows?: number
  cancelRequested?: boolean
  startedAt?: string
  endedAt?: string | null
  createdBy?: string
  /** ISO string（Prisma Date 序列化）— 409 跟住嘅 job 用嚟顯示範圍 */
  fromDate?: string | null
  toDate?: string | null
  [k: string]: unknown
}

const TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED'])
const POLL_MS = 2000

export function useApricotJobPoll(handlers: {
  /** 每次 poll 到 RUNNING 快照 */
  onJob?: (job: ApricotJobSnapshot) => void
  /** poll 到終態（DONE/FAILED/CANCELLED）— hook 已自行 stop */
  onTerminal?: (job: ApricotJobSnapshot) => void
}) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // ★ latestRef：而家跟緊嘅 jobId — 唔係呢個 id 嘅回應當 stale 忽略
  const latestRef = useRef<string | null>(null)
  const onJobRef = useRef(handlers.onJob)
  onJobRef.current = handlers.onJob
  const onTerminalRef = useRef(handlers.onTerminal)
  onTerminalRef.current = handlers.onTerminal

  const stop = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  const tick = useCallback(async (jobId: string) => {
    if (latestRef.current !== jobId) return // 已換 job / 已停 — 呢個回應算 stale
    try {
      const res = await fetch(`/api/apricot/sync/jobs/${jobId}`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json()
      const job = d?.job as ApricotJobSnapshot | undefined
      if (!job || job.id !== jobId) return
      if (TERMINAL.has(job.status)) {
        latestRef.current = null
        stop()
        onTerminalRef.current?.(job)
      } else {
        onJobRef.current?.(job)
      }
    } catch { /* 單次失敗唔致命，下次再試 */ }
  }, [stop])

  const start = useCallback((jobId: string) => {
    stop()
    latestRef.current = jobId
    void tick(jobId) // 即刻先 poll 一次，唔使等 2 秒
    timerRef.current = setInterval(() => void tick(jobId), POLL_MS)
  }, [stop, tick])

  useEffect(() => stop, [stop]) // unmount 清 timer

  return { start, stop }
}
