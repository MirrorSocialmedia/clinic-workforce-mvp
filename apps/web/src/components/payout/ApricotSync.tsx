'use client'

// ============================================================
// ★ cwm-syncshared-20261010：Apricot 同步（揀咗診所＋日期範圍）—— 每日大數頁、醫生月結頁共用
//   由 payout/daily/page.tsx 原封抽出（cwm-dailyv2-20261007 ②），行為不變：
//   POST /api/apricot/sync { clinicId, from, to }（唔帶 force）→ jobId → useApricotJobPoll 每 2 秒跟；
//   409 = 已有 job 進行中 → 提示並跟住嗰個 jobId（唔開第二個 job）；完成 → onDone()（頁面重新攞數）。
// ============================================================
import { useCallback, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useApricotJobPoll } from '@/lib/use-apricot-job-poll'

export interface SyncState {
  status: 'running' | 'done' | 'failed' | 'cancelled'
  currentStep?: string | null
  done?: number
  total?: number
  error?: string
  existing?: boolean         // 409：跟住人哋嘅 job
  clinicName?: string | null // 409：嗰個 job 嘅診所名
  from?: string | null       // HK 日
  to?: string | null
  endedAtHm?: string | null
}

const hkDayOf = (iso: unknown): string | undefined => {
  const d = iso ? new Date(iso as string) : null
  return d && !isNaN(d.getTime())
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    : undefined
}
const hhmmOf = (iso: unknown): string | undefined => {
  const d = iso ? new Date(iso as string) : null
  return d && !isNaN(d.getTime())
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
    : undefined
}

type ClinicLite = { id: string; name: string; shortName?: string | null; apricotClinicId?: string | null }

export function useApricotSync(opts: { clinics: ClinicLite[]; onDone?: () => void }) {
  const [syncState, setSyncState] = useState<SyncState | null>(null)
  const { start: startPoll, stop } = useApricotJobPoll({
    onJob: job => setSyncState(s => ({
      ...(s ?? { status: 'running' }),
      status: 'running',
      currentStep: job.currentStep,
      done: job.doneClinics,
      total: job.totalClinics,
      from: s?.from || hkDayOf(job.fromDate),
      to: s?.to || hkDayOf(job.toDate),
    })),
    onTerminal: job => {
      if (job.status === 'DONE') {
        setSyncState(s => ({
          ...(s ?? { status: 'done' }),
          status: 'done',
          currentStep: job.currentStep,
          done: job.doneClinics,
          total: job.totalClinics,
          from: s?.from || hkDayOf(job.fromDate),
          to: s?.to || hkDayOf(job.toDate),
          endedAtHm: hhmmOf(job.endedAt),
        }))
        opts.onDone?.()
      } else {
        setSyncState(s => ({ ...(s ?? { status: 'failed' }), status: job.status === 'FAILED' ? 'failed' : 'cancelled', error: job.errorMessage || '' }))
      }
    },
  })

  const start = useCallback(async (clinicId: string, from: string, to: string) => {
    if (!clinicId || !from) return
    stop()
    // payload 格式同 /apricot-sync 頁（HK 日 + T00:00:00+08:00 / T23:59:59+08:00），唔傳 force
    const body = { clinicId, from: `${from}T00:00:00+08:00`, to: `${to || from}T23:59:59+08:00` }
    setSyncState({ status: 'running', from, to: to || from })
    try {
      const res = await fetch('/api/apricot/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        if (res.status === 409 && data.jobId) {
          const ext = (data.running?.clinicExtId as string | null) ?? null
          const c = opts.clinics.find(x => x.apricotClinicId === ext)
          setSyncState({ status: 'running', existing: true, clinicName: c ? (c.shortName || c.name) : (ext || null), from: null, to: null })
          startPoll(data.jobId)
          return
        }
        setSyncState({ status: 'failed', error: data.error || `HTTP ${res.status}` })
        return
      }
      if (data.jobId) startPoll(data.jobId)
      else setSyncState({ status: 'failed', error: '伺服器未回傳 job id' })
    } catch (e: any) {
      setSyncState({ status: 'failed', error: e?.message || '同步失敗' })
    }
  }, [opts.clinics, startPoll, stop])

  const reset = useCallback(() => { stop(); setSyncState(null) }, [stop])

  return { syncState, setSyncState, start, reset }
}

/** 同步狀態欄：RUNNING 轉圈＋步驟；DONE「✓ 已同步 from–to（hh:mm）」；FAILED／CANCELLED 紅字；409「另一個同步進行中」 */
export function ApricotSyncStatus({ state, onHide, doneNote = '已重新載入' }: { state: SyncState | null; onHide: () => void; doneNote?: string }) {
  if (!state) return null
  const range = (f?: string | null, t?: string | null) => `${f ?? ''}${t && t !== f ? `–${t}` : ''}`
  return (
    <div className={`mt-2 text-xs flex items-center gap-2 ${state.status === 'done' ? 'text-green-700' : state.status === 'running' ? 'text-blue-700' : 'text-red-700'}`}>
      {state.status === 'running' && (
        <><RefreshCw size={12} className="animate-spin" />
          {state.existing
            ? <>另一個同步進行中{`（${state.clinicName ?? ''}${state.from ? ` ${range(state.from, state.to)}` : ''}）`}</>
            : <>同步中…{state.currentStep ? ` ${state.currentStep}` : ''}</>}
          {state.total != null ? `（${state.done ?? 0}/${state.total}）` : ''}
        </>
      )}
      {state.status === 'done' && <>✓ 已同步 {range(state.from, state.to)}{state.endedAtHm ? `（${state.endedAtHm}）` : ''} — {doneNote}</>}
      {state.status === 'failed' && <>✗ 同步失敗{state.error ? `：${state.error}` : ''}（可重新撳同步）</>}
      {state.status === 'cancelled' && <>同步已停止{state.error ? `：${state.error}` : ''}</>}
      {state.status !== 'running' && <button type="button" className="underline text-gray-500" onClick={onHide}>隱藏</button>}
    </div>
  )
}
