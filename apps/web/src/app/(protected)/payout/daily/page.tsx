'use client'

/**
 * 每日大數（cwm-dailyrev-20261003）— 醫生月結 › 每日大數
 * 揀日期（可選「至」做範圍）＋ 診所／醫生：
 *   ① 揀診所、醫生揀「全部醫生」→ 行 = 醫生（範圍內合計）
 *   ② 揀醫生 → 行 = 逐日（同醫生月結 Excel「A 逐日收款」一樣）
 * 顏色跟 Excel：藍字 = 系統帶入，黑字粗體 = 合計，灰字 = 唔計，黃底 = 最終金額。
 * 數字同 Excel 匯出同一個 API（/api/payout-runs/daily），唔准前端自己計。
 */
import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ArrowLeft, Download, RefreshCw } from 'lucide-react'
import { todayHK, addDaysStr } from '@/lib/hk-date'
import type { DailyReport, DailyRow } from '@/lib/payout/daily-report'
// ★ cwm-dailyv3：Clinic 雜項行 key（與 lib/payout/daily-report.ts 嘅 CLINIC_ROW_KEY 同一個字串 —
//   只可以 import type 唔可以 runtime import（佢 import prisma，會入 client bundle））
const CLINIC_ROW_KEY = '__clinic__'
import { useApricotJobPoll } from '@/lib/use-apricot-job-poll'
import { hasPermission } from '@/lib/permissions'
import { cellState, cellTickable } from '@/lib/payout/daily-cell-state' // ★ ④：純函數（零 prisma，client 可用）
import type { DayCheckState } from '@/lib/payout/daily-check' // ★ cwm-dailyv3-20261010 §5b：type-only（佢 import prisma）
import { DailyCheckPanel } from '@/components/payout/DailyCheckPanel'
import { InlineDayCheck } from '@/components/payout/InlineDayCheck' // ★ cwm-dailyv3-20261010 §5b：③ 全店核對欄就地核對

const SECTION = '#1F4E79'
const BLUE = '#0000ff'
const GRAY = '#808080'

const money = (n: number | null | undefined): string =>
  n ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''

function weekStartOf(d: string): string {
  const dow = new Date(`${d}T12:00:00+08:00`).getUTCDay()
  return addDaysStr(d, dow === 0 ? -6 : 1 - dow)
}

// ★ cwm-dailyv2-20261007 ①：月份 → 首日/末日。計法同 lib/payout/daily-review.ts 嘅 monthDays() 一樣，
//   但唔 import 嗰個檔（佢 import loadDailyReport → prisma，client bundle 會爆）
const monthRange = (ym: string): { from: string; to: string } => {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` }
}

// ★ cwm-dailyv2-20261007 ②：ISO → HK 顯示值（同步狀態欄用；純函數無 prisma）
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

export default function DailyRevenuePage() {
  const today = todayHK()
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState('')
  const [clinicId, setClinicId] = useState('')
  const [providerId, setProviderId] = useState('')
  const [clinics, setClinics] = useState<{ id: string; name: string; shortName?: string | null; apricotClinicId?: string | null }[]>([])
  const [providers, setProviders] = useState<{ id: string; name: string; isActive?: boolean }[]>([])
  const [report, setReport] = useState<DailyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // ★ cwm-dailycheck-20261006：每次重新攞到報表 → 護士核對狀態都重新攞（同一份數）
  const [reloadKey, setReloadKey] = useState(0)
  const [refreshTick, setRefreshTick] = useState(0) // ★ cwm-dailyv2-20261007 ②：同步完後重新拉報表

  // ★ cwm-dailyv2-20261007 ④ + cwm-dailyv3-20261010 §5b：逐格 tick —— 兩種有效模式：
  //   ① 逐醫生 + 單日（揀咗診所、to 空或 to==from）：date=from、rowKey=r.key
  //   ③ 逐日 + 逐醫生（揀咗診所 + 醫生）：date=r.key（行=日）、rowKey=providerId
  //   cellChecks map key 統一 `${date}|${rowKey}|${colKey}`（①③ 共用）
  const [cellChecks, setCellChecks] = useState<Record<string, { amount: number; checkedName: string; checkedAt: string }> | null>(null)
  const [cellBusy, setCellBusy] = useState<string | null>(null)
  const [cellReloadKey, setCellReloadKey] = useState(0)
  // ★ cwm-dailyv3-20261010 §5b：③ 右邊「全店核對」欄（GET /check days[]；全店當日總數含雜項）
  const [dayChecks, setDayChecks] = useState<DayCheckState[] | null>(null)
  const [dayCanCheck, setDayCanCheck] = useState(false)
  const [checkReloadKey, setCheckReloadKey] = useState(0)
  const [inlineCheckDate, setInlineCheckDate] = useState<string | null>(null)
  // cellMode / cellSingleDate 喺 activeClinicId 定義之後先算（見下）

  useEffect(() => {
    Promise.all([apiFetch<any>('/api/clinics'), apiFetch<any>('/api/providers')])
      .then(([c, p]) => {
        const cl = (c.clinics || []).filter((x: any) => x.apricotClinicId)
        setClinics(cl)
        setProviders((p.providers || []).filter((x: any) => x.isActive !== false))
        // ★ cwm-dailyv3-20261010 §8：預設診所唔喺呢度猜（KIOSK 要等 me 先知道自己綁邊幾間）→ 下面 [clinics, me] effect
      })
      .catch(e => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ★ cwm-dailyreview-20261006：醫生月結預覽「去每日大數核對」帶 ?clinicId=&from=&to=（掛載後讀一次，避免 SSR hydration 唔一致）
  const deepLinked = useRef(false)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const re = /^\d{4}-\d{2}-\d{2}$/
    const f = sp.get('from'), t = sp.get('to'), c = sp.get('clinicId')
    if (f && re.test(f)) setFrom(f)
    if (t && re.test(t)) setTo(t)
    if (c) { setClinicId(c); deepLinked.current = true }
    // ★ cwm-pvcheck-20261007 B：加讀 ?providerId=（醫生下拉 async 載入，state 先設冇問題：名單到咗會顯示返正確名）
    const p = sp.get('providerId')
    if (p) setProviderId(p)
  }, [])

  // ★ cwm-dailyv2-20261007 ③：KIOSK（店舖帳號）— /api/me 攞 role/clinicIds：
  //   只顯示自己店（單一店自動鎖）、隱醫生 dropdown、Excel 匯出、B 區、分成
  const [me, setMe] = useState<{ role: string; clinicIds: string[]; grant: string[]; deny: string[] } | null>(null)
  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.user) setMe({ role: d.user.role, clinicIds: d.user.clinicIds ?? [], grant: d.user.grant ?? [], deny: d.user.deny ?? [] }) })
      .catch(() => {})
  }, [])
  const isKiosk = me?.role === 'KIOSK'
  // ★ cwm-dailyv2-20261007 ②：同步掣只俾有 apricot_sync 權限先顯示（server 端 RBAC：
  //   POST /api/apricot/sync = OWNER + apricot_sync override）。判斷用全站同一套 hasPermission
  //   （ROLE_DEFAULTS ∪ grant − deny；OWNER 預設有晒）。KIOSK 一律唔顯示。
  const hasApricotSync = !!me && hasPermission(me.role, 'apricot_sync', me.grant, me.deny)
  const myClinics = isKiosk ? clinics.filter(c => me!.clinicIds.includes(c.id)) : clinics
  // ★ cwm-dailyv3-20261010 §8：預設診所 —— KIOSK 用 myClinics[0]（綁多店時 cl[0] 可能唔屬佢 → 避免 403 閃）；
  //   非 KIOSK 同舊行為一樣（clinics[0]）。deep-link（?clinicId=）唔會覆蓋。
  useEffect(() => {
    if (!clinics.length || deepLinked.current || clinicId) return
    const first = (isKiosk ? myClinics : clinics)[0] // eslint-disable-line react-hooks/exhaustive-deps
    if (first) setClinicId(first.id)
  }, [clinics, me, isKiosk, clinicId])
  const kioskLockedClinicId = isKiosk && myClinics.length === 1 ? myClinics[0].id : ''
  const activeClinicId = kioskLockedClinicId || clinicId
  // ★ cwm-dailyv3-20261010 §5b：逐格 tick 模式 —— ① 逐醫生+單日 / ③ 逐日+逐醫生（指定診所+醫生）
  const cellMode: 'single' | 'byDay' | null =
    report && report.mode === 'byDoctor' && activeClinicId && (!to || to === from) ? 'single'
    : report && report.mode === 'byDay' && activeClinicId && providerId ? 'byDay'
    : null
  const cellSingleDate = cellMode === 'single' ? from : null
  const query = useMemo(() => {
    const q = new URLSearchParams({ from })
    if (to && to !== from) q.set('to', to)
    if (activeClinicId) q.set('clinicId', activeClinicId)
    if (!isKiosk && providerId) q.set('providerId', providerId)
    return q.toString()
  }, [from, to, activeClinicId, providerId, isKiosk])

  useEffect(() => {
    if (!from || (!activeClinicId && !providerId)) { setReport(null); return }
    let cancelled = false
    setLoading(true)
    setError('')
    apiFetch<DailyReport>(`/api/payout-runs/daily?${query}`)
      .then(r => { if (!cancelled) { setReport(r); setReloadKey(k => k + 1) } })
      .catch(e => { if (!cancelled) { setReport(null); setError(e.message) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, from, clinicId, providerId, refreshTick])

  // ★ cwm-dailyv2-20261007 ②：Apricot 同步（重拉 bills/payments 入 DB）—— 复用 /api/apricot/sync job 體系：
  //   POST { clinicId, from, to }（唔帶 force — MD ②：force 有 7 日限制 + 逐張單 call）→ jobId；
  //   409 = 已有 job 進行中 → 顯示提示並跟住嗰個 jobId（唔開第二個 job）。
  //   poll 用共用 useApricotJobPoll（同 /apricot-sync 頁共用，每 2s，latestRef 防舊回應）。
  const [syncState, setSyncState] = useState<null | {
    status: 'running' | 'done' | 'failed' | 'cancelled'
    currentStep?: string | null
    done?: number
    total?: number
    error?: string
    existing?: boolean         // 409：跟住人哋嘅 job
    clinicName?: string | null // 409：嗰個 job 嘅診所名（apricotClinicId 映返 name）
    from?: string | null       // HK 日（自己 job = 表單值；409 job = 由 poll 回傳嘅 job.fromDate 攞）
    to?: string | null
    endedAtHm?: string | null  // 完成時間 hh:mm（MD ② DONE 格式）
  }>(null)
  const { start: startSyncPoll, stop: stopSyncPoll } = useApricotJobPoll({
    onJob: job => setSyncState(s => ({
      ...(s ?? { status: 'running' }),
      status: 'running',
      currentStep: job.currentStep,
      done: job.doneClinics,
      total: job.totalClinics,
      // 自己 job：from/to 已用表單值填咗；409 跟住嘅 job：由 job 回傳嘅 fromDate/toDate 攞
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
        setRefreshTick(t => t + 1) // 同步完 → 重新拉報表
      } else {
        // MD ②：FAILED／CANCELLED 都係紅字顯示 errorMessage，掣恢復可以撳
        setSyncState(s => ({ ...(s ?? { status: 'failed' }), status: job.status === 'FAILED' ? 'failed' : 'cancelled', error: job.errorMessage || '' }))
      }
    },
  })

  // MD ②：換診所要清 poll + 狀態（unmount 由 hook 自己清）
  useEffect(() => { stopSyncPoll(); setSyncState(null) }, [activeClinicId, stopSyncPoll])

  // ★ cwm-dailyv2-20261007 ④ + cwm-dailyv3-20261010 §5b：拉回 tick 紀錄（報表重新載入／同步完／換诊所換日都重拉）
  //   ① 單日：?date=；③ 範圍：?from=&to=（server 回傳每個 cell 帶 date）
  useEffect(() => {
    if (!cellMode || !activeClinicId) { setCellChecks(null); return }
    let cancelled = false
    setCellChecks(null)
    const q = cellMode === 'single'
      ? `clinicId=${activeClinicId}&date=${cellSingleDate}`
      : `clinicId=${activeClinicId}&from=${report!.from}&to=${report!.to}`
    apiFetch<{ cells: { date: string; rowKey: string; colKey: string; amount: number; checkedName: string; checkedAt: string }[] }>(
      `/api/payout-runs/daily/cell-check?${q}`
    )
      .then(d => {
        if (cancelled) return
        const m: Record<string, { amount: number; checkedName: string; checkedAt: string }> = {}
        for (const c of d.cells) {
          const date = c.date || cellSingleDate!  // date= 單日回傳同一日
          m[`${date}|${c.rowKey}|${c.colKey}`] = { amount: c.amount, checkedName: c.checkedName, checkedAt: c.checkedAt }
        }
        setCellChecks(m)
      })
      .catch(() => { if (!cancelled) setCellChecks(null) })
    return () => { cancelled = true }
  }, [cellMode, cellSingleDate, activeClinicId, report?.from, report?.to, reloadKey, refreshTick, cellReloadKey])

  // ★ cwm-dailyv3-20261010 §5b：③ 全店核對欄資料（GET /check 逐日狀態；全店總數含雜項）
  useEffect(() => {
    if (!cellMode || cellMode !== 'byDay' || !activeClinicId) { setDayChecks(null); setDayCanCheck(false); return }
    let cancelled = false
    setDayChecks(null)
    const q = new URLSearchParams({ clinicId: activeClinicId, from: report!.from, to: report!.to })
    apiFetch<{ days: DayCheckState[]; canCheck: boolean }>(`/api/payout-runs/daily/check?${q}`)
      .then(d => { if (!cancelled) { setDayChecks(d.days); setDayCanCheck(d.canCheck) } })
      .catch(() => { if (!cancelled) setDayChecks(null) })
    return () => { cancelled = true }
  }, [cellMode, activeClinicId, report?.from, report?.to, checkReloadKey, reloadKey])

  // ★ ④ + cwm-dailyv3-20261010 §5b：剔格 —— OPEN→tick、OK→取消、CHANGED→用新金額覆寫、STALE→取消（server 重算金額，唔信前端）
  const toggleCell = useCallback(async (date: string, rowKey: string, colKey: string, st: 'OPEN' | 'OK' | 'CHANGED' | 'STALE') => {
    if (!activeClinicId || cellBusy) return
    const target = st === 'OPEN' || st === 'CHANGED'
    setCellBusy(`${date}|${rowKey}|${colKey}`)
    try {
      await apiFetch('/api/payout-runs/daily/cell-check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clinicId: activeClinicId, date, rowKey, colKey, checked: target }),
      })
      setCellReloadKey(k => k + 1)
    } catch (e: any) {
      alert(e?.message || '逐格核對失敗')
    } finally { setCellBusy(null) }
  }, [activeClinicId, cellBusy])

  // ★ ④ + cwm-dailyv3-20261010 §5b：DailyCheckPanel 提示「逐格已對 n/總有數格」（全部對晒先綠字）—— ①③ 共用 map key
  const cellProgress = useMemo(() => {
    if (!cellMode || !report || !cellChecks) return null
    let total = 0
    let done = 0
    for (const r of report.rows) {
      for (const m of report.methods) {
        const v = r.byMethod[m.key]
        if (!cellTickable(v)) continue
        total++
        const date = cellMode === 'single' ? cellSingleDate! : r.key
        const rowKey = cellMode === 'single' ? r.key : providerId
        const rec = cellChecks[`${date}|${rowKey}|${m.key}`]
        if (rec && cellState(v ?? 0, rec.amount) === 'OK') done++
      }
    }
    return { done, total }
  }, [cellMode, cellSingleDate, report, cellChecks, providerId])

  // ★ ④：格仔右上角嘅細 checkbox（14px）。只喺 cellDate 生效時渲染；TOTAL 欄／Total 行／SP 欄唔會 call 呢度。
  //   「有數先有格」：冇數又冇 tick 紀錄 → 唔出 checkbox（MD ④）。
  const cellTick = (r: DailyRow, m: { key: string }): { node: React.ReactNode; tdExtra: React.CSSProperties } | null => {
    if (!cellMode || !cellChecks) return null
    const date = cellMode === 'single' ? cellSingleDate! : r.key
    const rowKey = cellMode === 'single' ? r.key : providerId
    const v = r.byMethod[m.key]
    const rec = cellChecks[`${date}|${rowKey}|${m.key}`]
    if (!cellTickable(v) && !rec) return null
    const st = cellState(v ?? 0, rec?.amount ?? null)
    const ck = `${date}|${rowKey}|${m.key}`
    const busy = cellBusy === ck
    let title = '剔 = 呢格已對'
    let mark: React.ReactNode = null
    let boxStyle: React.CSSProperties = { background: '#fff', borderColor: '#9ca3af' }
    let tdExtra: React.CSSProperties = {}
    if (st === 'OK' && rec) {
      title = `${rec.checkedName} ${hhmmOf(rec.checkedAt) ?? ''}`.trim()
      mark = <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>
      boxStyle = { background: '#16a34a', borderColor: '#15803d' }
      tdExtra = { background: '#e8f5e9' }
    } else if (st === 'CHANGED' && rec) {
      title = `核對後有變（核對時 $${rec.amount}）— 撳返 = 用新金額覆寫`
      mark = <span style={{ width: 8, height: 3, background: '#dc2626', display: 'block' }} />
      boxStyle = { background: '#fff', borderColor: '#dc2626' }
      tdExtra = { boxShadow: 'inset 0 0 0 1.5px #dc2626' }
    } else if (st === 'STALE' && rec) {
      title = `已 tick 但而家冇數（tick 時 $${rec.amount}）— 撳 = 取消 tick`
      mark = <span style={{ color: '#dc2626', fontSize: 10, lineHeight: 1 }}>×</span>
      boxStyle = { background: '#fee2e2', borderColor: '#dc2626' }
      tdExtra = { boxShadow: 'inset 0 0 0 1.5px #dc2626' }
    }
    return {
      tdExtra,
      node: (
        <button
          type="button" role="checkbox" aria-checked={st === 'OK' ? 'true' : st === 'CHANGED' ? 'mixed' : 'false'}
          title={title} disabled={busy} onClick={() => toggleCell(date, rowKey, m.key, st)}
          className="absolute top-1 right-1 w-[14px] h-[14px] rounded-[3px] border flex items-center justify-center disabled:opacity-50"
          style={boxStyle}
          aria-label={`逐格核對 ${r.label} ${m.key}`}
        >
          {mark}
        </button>
      ),
    }
  }

  // ★ cwm-dailyv3-20261010 §5b：③ 右邊「全店核對」欄（SP 筆數之後）—— 核對全店當日總數（含雜項）
  const dayCheckCell = (r: DailyRow): React.ReactNode => {
    const date = r.key
    const dc = dayChecks?.find(x => x.date === date) ?? null
    if (date > today) return <td style={td(GRAY, { textAlign: 'center' })}>{''}</td> // 未來日留空
    if (!dc) return <td style={td(GRAY, { textAlign: 'center' })}>— 冇營收</td>
    if (dc.status === 'CHECKED') return (
      <td style={td('#15803d', { textAlign: 'center' })}>✓ {dc.check?.nurseName ?? ''}</td>
    )
    const btn = (label: string, danger: boolean) => (
      <button type="button" onClick={() => setInlineCheckDate(inlineCheckDate === date ? null : date)}
        className={`h-6 px-2 rounded border text-xs bg-white ${danger ? 'border-red-600 text-red-700 hover:bg-red-50' : 'border-green-600 text-green-700 hover:bg-green-50'}`}>{label}</button>
    )
    if (dc.status === 'CHANGED') return (
      <td style={td('#dc2626', { textAlign: 'center' })}>
        <span className="inline-flex flex-wrap items-center justify-center gap-1">⚠ 有變{dayCanCheck && btn('重新核對', true)}</span>
      </td>
    )
    return (
      <td style={td('#b45309', { textAlign: 'center' })}>
        <span className="inline-flex flex-wrap items-center justify-center gap-1">未核對{dayCanCheck && btn('核對', false)}</span>
      </td>
    )
  }

  const startSync = useCallback(async () => {
    if (!activeClinicId || !from) return
    stopSyncPoll()
    // ★ MD ②：payload 格式照抄 /apricot-sync 頁（HK 日 + T00:00:00+08:00 / T23:59:59+08:00），唔傳 force
    const body = { clinicId: activeClinicId, from: `${from}T00:00:00+08:00`, to: `${to || from}T23:59:59+08:00` }
    setSyncState({ status: 'running', from, to: to || from })
    try {
      const res = await fetch('/api/apricot/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        if (res.status === 409 && data.jobId) {
          // MD ②：409 → 「另一個同步進行中（{診所} {日期}）」，改為 poll 嗰個 jobId，完咗先可以再撳
          const ext = (data.running?.clinicExtId as string | null) ?? null
          const c = clinics.find(x => x.apricotClinicId === ext)
          setSyncState({
            status: 'running', existing: true,
            clinicName: c ? (c.shortName || c.name) : (ext || null),
            from: null, to: null, // 嗰個 job 嘅日期範圍由第一輪 poll 回傳（job 有 fromDate/toDate）
          })
          startSyncPoll(data.jobId)
          return
        }
        // 400／403／5xx → 顯示錯誤，掣恢復可以撳
        setSyncState({ status: 'failed', error: data.error || `HTTP ${res.status}` })
        return
      }
      if (data.jobId) startSyncPoll(data.jobId)
      else setSyncState({ status: 'failed', error: '伺服器未回傳 job id' })
    } catch (e: any) {
      setSyncState({ status: 'failed', error: e?.message || '同步失敗' })
    }
  }, [activeClinicId, from, to, clinics, startSyncPoll, stopSyncPoll])

  const quick = (kind: 'today' | 'week' | 'month') => {
    if (kind === 'today') { setFrom(today); setTo(''); return }
    if (kind === 'week') { setFrom(weekStartOf(today)); setTo(today); return }
    setFrom(`${today.slice(0, 7)}-01`); setTo(today)
  }

  // ★ cwm-dailyv2-20261007 ①：月份格顯示值由 from/to 推返出嚟 ——
  //   只有「from = 某月 1 號 且 to = 同月最後一日」先顯示嗰個月；撳「今日」/手改日期會自動清空，唔誤導
  const monthValue = (() => {
    if (!/^\d{4}-\d{2}-01$/.test(from)) return ''
    const ym = from.slice(0, 7)
    return to === monthRange(ym).to ? ym : ''
  })()

  // ★ cwm-dailysticky-20261006：表頭向下捲時釘住（sticky 要配合下面 TABLE_BOX 做捲動框；
  //   border-collapse 下 sticky 格嘅邊框唔跟住格畫：底線用 inset 陰影補，top:-1 遮住頂邊 1px 縫，唔會見到後面捲過嘅字）
  const th: React.CSSProperties = { border: '1px solid #d9dee4', padding: '7px 9px', background: '#f3f5f8', fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12, textTransform: 'none', letterSpacing: 'normal', position: 'sticky', top: -1, zIndex: 1, boxShadow: 'inset 0 -1px 0 #d9dee4' }
  // 捲動框：橫向（付款方式多）＋直向（一個月 30 行）都喺框內捲，表頭先釘得住
  const TABLE_BOX: React.CSSProperties = { overflow: 'auto', maxHeight: '70vh' }
  const td = (color: string, extra: React.CSSProperties = {}): React.CSSProperties => ({
    border: '1px solid #d9dee4', padding: '7px 9px', textAlign: 'right', whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums', color, ...extra,
  })
  const firstCol = report?.mode === 'byDoctor' ? '醫生' : '日期'
  // ★ cwm-dailyv3：Clinic 雜項行（A 區淺橙底、名唔可以撳；B 區跳過）
  const isClinicRow = (r: DailyRow) => r.key === CLINIC_ROW_KEY
  const isEmptyRow = (r: DailyRow) => r.storeTotal === 0 && r.doctorRaw === 0 && Object.values(r.byMethod).every(v => v === 0)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
        <a href="/payout" className="flex items-center gap-1 hover:text-gray-800"><ArrowLeft size={14} /> 醫生月結</a>
        <span>›</span><span className="text-gray-900 font-semibold">每日大數</span>
      </div>
      <h1 className="text-2xl font-bold mb-4">每日大數</h1>

      <Card className="p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1 text-xs text-gray-600">日期
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-10 px-2 border rounded-md text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600">至（選填 — 揀範圍）
            <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="h-10 px-2 border rounded-md text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600">月份
            <input type="month" value={monthValue}
              onChange={e => {
                const ym = e.target.value
                if (!/^\d{4}-\d{2}$/.test(ym)) return
                const r = monthRange(ym)
                setFrom(r.from); setTo(r.to)
              }} className="h-10 px-2 border rounded-md text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600">診所
            <select value={activeClinicId} onChange={e => setClinicId(e.target.value)}
              disabled={isKiosk && myClinics.length <= 1}
              className="h-10 px-2 border rounded-md text-sm min-w-[140px]">
              {!isKiosk && <option value="">全部診所{providerId ? '' : '（要揀醫生）'}</option>}
              {myClinics.map(c => <option key={c.id} value={c.id}>{c.shortName || c.name}</option>)}
            </select>
          </label>
          {!isKiosk && (
          <label className="flex flex-col gap-1 text-xs text-gray-600">醫生
            <select value={providerId} onChange={e => setProviderId(e.target.value)} className="h-10 px-2 border rounded-md text-sm min-w-[160px]">
              <option value="">全部醫生（逐醫生）</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => quick('today')}>今日</Button>
            <Button variant="outline" onClick={() => quick('week')}>今個星期</Button>
            <Button variant="outline" onClick={() => quick('month')}>今個月</Button>
          </div>
          {/* ★ cwm-dailyv2-20261007 ②：Apricot 同步 — KIOSK 一律唔顯示；非 OWNER 要 apricot_sync 權限先顯示 */}
          {!isKiosk && hasApricotSync && (
          <Button variant="outline" title={!activeClinicId ? '先揀診所' : '重新同 Apricot 拉 bills/payments 入 DB'}
            disabled={!activeClinicId || !from || syncState?.status === 'running'}
            onClick={startSync}>
            <RefreshCw size={14} className={`mr-1 ${syncState?.status === 'running' ? 'animate-spin' : ''}`} /> 同步 Apricot
          </Button>
          )}
          <div className="flex-1" />
          {!isKiosk && (
          <a href={report ? `/api/payout-runs/daily?${query}&format=xlsx` : undefined} aria-disabled={!report}>
            <Button variant="outline" disabled={!report}><Download size={14} className="mr-1" /> 匯出 Excel</Button>
          </a>
          )}
        </div>
        {!clinicId && !providerId && <div className="text-xs text-amber-700 mt-2">「全部診所」要揀醫生先睇到（逐日）；或者揀一間診所睇逐醫生。</div>}
        {/* ★ cwm-dailyv2-20261007 ②：同步狀態欄（MD ②：RUNNING 轉圈+步驟；DONE 「✓ 已同步 {from}–{to}（hh:mm）」；
            FAILED／CANCELLED 紅字 errorMessage；409 「另一個同步進行中（{診所} {日期}）」） */}
        {syncState && (
          <div className={`mt-2 text-xs flex items-center gap-2 ${
            syncState.status === 'done' ? 'text-green-700' : syncState.status === 'running' ? 'text-blue-700' : 'text-red-700'
          }`}>
            {syncState.status === 'running' && (
              <><RefreshCw size={12} className="animate-spin" />
                {syncState.existing
                  ? <>
                      另一個同步進行中
                      {`（${syncState.clinicName ?? ''}${syncState.from ? ` ${syncState.from}${syncState.to && syncState.to !== syncState.from ? `–${syncState.to}` : ''}` : ''}）`}
                    </>
                  : <>同步中…{syncState.currentStep ? ` ${syncState.currentStep}` : ''}</>}
                {syncState.total != null ? `（${syncState.done ?? 0}/${syncState.total}）` : ''}
              </>
            )}
            {syncState.status === 'done' && (
              <>✓ 已同步 {syncState.from ?? ''}{syncState.to && syncState.to !== syncState.from ? `–${syncState.to}` : ''}{syncState.endedAtHm ? `（${syncState.endedAtHm}）` : ''} — 報表已重新載入</>
            )}
            {syncState.status === 'failed' && <>✗ 同步失敗{syncState.error ? `：${syncState.error}` : ''}（可重新撳同步）</>}
            {syncState.status === 'cancelled' && <>同步已停止{syncState.error ? `：${syncState.error}` : ''}</>}
            {syncState.status !== 'running' && (
              <button type="button" className="underline text-gray-500" onClick={() => setSyncState(null)}>隱藏</button>
            )}
          </div>
        )}
      </Card>

      {error && <div className="p-3 mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md">⚠️ {error}</div>}
      {loading && <div className="p-6 text-gray-500">載入中...</div>}

      {/* ★ cwm-dailycheck-20261006：護士核對（揀咗診所、全部醫生先有；每店每日一次）
          ★ cwm-dailyv2-20261007 ③：KIOSK 用 activeClinicId（單一店自動鎖） */}
      {report && !loading && report.mode === 'byDoctor' && activeClinicId && (
        <DailyCheckPanel clinicId={activeClinicId}
          clinicLabel={clinics.find(c => c.id === activeClinicId)?.shortName || clinics.find(c => c.id === activeClinicId)?.name || ''}
          from={report.from} to={report.to} reloadKey={reloadKey}
          currentRows={report.rows.map(r => ({ key: r.key, label: r.label, storeTotal: r.storeTotal }))}
          cellProgress={cellProgress}
          onPickDate={d => { setFrom(d); setTo('') }} />
      )}

      {report && !loading && (
        <Card className="overflow-hidden mb-4">
          <div className="px-4 py-3 flex items-baseline gap-3 flex-wrap">
            <div className="text-lg font-bold">{report.title}</div>
            <div className="text-xs text-gray-500">{report.mode === 'byDoctor' ? '行 = 醫生（撳醫生名睇逐日）' : '行 = 逐日'}</div>
          </div>

          <div style={{ background: SECTION, color: '#fff', fontWeight: 700, fontSize: 13, padding: '6px 16px' }}>
            {report.mode === 'byDoctor' ? 'A  逐醫生收款' : 'A  逐日收款'}
          </div>
          {/* ★ cwm-dailyv3-20261010 §5c：④ 指定醫生＋全部診所 —— 唔出剔格／核對欄 */}
          {report.mode === 'byDay' && providerId && !activeClinicId && (
            <div className="px-4 py-2 text-xs text-amber-800 bg-amber-50 border-b border-amber-200">
              要逐格剔或者核對：先揀診所（核對係逐間店逐日）
            </div>
          )}
          <div style={TABLE_BOX}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>{firstCol}</th>
                  {report.methods.map(m => (
                    <th key={m.key} style={{ ...th, color: m.storeIncome || m.doctorIncome ? undefined : GRAY }}>{m.label}</th>
                  ))}
                  <th style={th}>TOTAL</th>
                  <th style={th}>SP 筆數</th>
                  {cellMode === 'byDay' && <th style={th}>全店核對</th>}
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 && (
                  <tr><td colSpan={report.methods.length + 3 + (cellMode === 'byDay' ? 1 : 0)} style={{ ...td(GRAY), textAlign: 'center', padding: 24 }}>呢段日子冇收款</td></tr>
                )}
                {report.rows.map(r => (
                  <Fragment key={r.key}>
                    <tr style={report.mode === 'byDay' && isEmptyRow(r) ? { background: '#f3f4f6' } : isClinicRow(r) ? { background: '#fff7e6' } : undefined}>
                      <td style={td(BLUE, { textAlign: 'left' })}>
                        {report.mode === 'byDoctor' && !isClinicRow(r) && !r.key.startsWith('ext:')
                          ? <button type="button" className="hover:underline" style={{ color: BLUE }} onClick={() => setProviderId(r.key)}>{r.label}</button>
                          : r.label}
                      </td>
                      {report.methods.map(m => {
                        // ★ cwm-dailyv2-20261007 ④ + cwm-dailyv3-20261010 §5b：有數嘅格右上角細 checkbox（① 單日 / ③ 逐日；cellTick 內部判斷）
                        const t = cellTick(r, m)
                        return (
                          <td key={m.key} style={td(m.storeIncome || m.doctorIncome ? BLUE : GRAY, t?.tdExtra)}>
                            <div className="relative" style={{ minHeight: 20, paddingRight: t ? 18 : 0 }}>
                              {money(r.byMethod[m.key])}{t?.node}
                            </div>
                          </td>
                        )
                      })}
                      <td style={td('#000')}>{money(r.storeTotal)}</td>
                      <td style={td(BLUE, { textAlign: 'center' })}>{r.spCount || ''}</td>
                      {cellMode === 'byDay' && dayCheckCell(r)}
                    </tr>
                    {/* ★ cwm-dailyv3-20261010 §5b：撳【核對】→ 嗰行下面插 InlineDayCheck（核對 MM-DD 全店：$x） */}
                    {cellMode === 'byDay' && inlineCheckDate === r.key && (() => {
                      const dc = dayChecks?.find(x => x.date === r.key)
                      if (!dc) return null
                      return (
                        <tr>
                          <td colSpan={report.methods.length + 4} style={{ padding: 12, background: '#f9fafb', border: '1px solid #d9dee4' }}>
                            <InlineDayCheck
                              clinicId={activeClinicId}
                              clinicLabel={clinics.find(c => c.id === activeClinicId)?.shortName || clinics.find(c => c.id === activeClinicId)?.name || ''}
                              date={r.key}
                              storeTotal={dc.storeTotal}
                              status={dc.status === 'CHANGED' ? 'CHANGED' : 'UNCHECKED'}
                              onSuccess={() => { setInlineCheckDate(null); setCheckReloadKey(k => k + 1) }}
                              onAlreadyChecked={() => setCheckReloadKey(k => k + 1)}
                              onClose={() => setInlineCheckDate(null)}
                            />
                          </td>
                        </tr>
                      )
                    })()}
                  </Fragment>
                ))}
                <tr>
                  <td style={td('#000', { textAlign: 'left', fontWeight: 700 })}>Total</td>
                  {report.methods.map(m => (
                    <td key={m.key} style={td(m.storeIncome || m.doctorIncome ? '#000' : GRAY, { fontWeight: 700 })}>{money(report.totals.byMethod[m.key])}</td>
                  ))}
                  <td style={td('#000', { fontWeight: 700, background: '#ffff00' })}>{money(report.totals.storeTotal) || '$0.00'}</td>
                  <td style={td('#000', { fontWeight: 700, textAlign: 'center' })}>{report.totals.spCount}</td>
                  {cellMode === 'byDay' && <td style={td('#000', { fontWeight: 700 })}>{''}</td>}
                </tr>
                {/* ★ cwm-dailyv2-20261007 ⑤：手續費＋已扣手續費（淨額）—— 同 B 區同一口徑（totals 帶好） */}
                <tr>
                  <td style={td(GRAY, { textAlign: 'left', fontStyle: 'italic' })}>手續費</td>
                  {report.methods.map(m => (
                    <td key={m.key} style={td(GRAY)}>{money(Math.round(((report.totals.byMethod[m.key] ?? 0) - (report.totals.byMethodNet[m.key] ?? 0)) * 100) / 100)}</td>
                  ))}
                  <td style={td(GRAY)}>{money(Math.round((report.totals.storeTotal - report.totals.storeNet) * 100) / 100)}</td>
                  <td style={td(GRAY)}>{''}</td>
                  {cellMode === 'byDay' && <td style={td(GRAY)}>{''}</td>}
                </tr>
                <tr>
                  <td style={td('#000', { textAlign: 'left', fontWeight: 700 })}>已扣手續費（淨額）</td>
                  {report.methods.map(m => (
                    <td key={m.key} style={td(m.storeIncome || m.doctorIncome ? '#000' : GRAY, { fontWeight: 700 })}>{money(report.totals.byMethodNet[m.key])}</td>
                  ))}
                  <td style={td('#000', { fontWeight: 700, background: '#ffff00' })}>{money(report.totals.storeNet) || '$0.00'}</td>
                  <td style={td(GRAY)}>{''}</td>
                  {cellMode === 'byDay' && <td style={td(GRAY)}>{''}</td>}
                </tr>
              </tbody>
            </table>
          </div>

          {/* ★ cwm-dailyv2-20261007 ③：KIOSK 唔顯示 B 區（醫生收入及分成） */}
          {!isKiosk && (<>
          <div style={{ background: SECTION, color: '#fff', fontWeight: 700, fontSize: 13, padding: '6px 16px', marginTop: 16 }}>
            B  醫生收入及分成（未扣成本）
          </div>
          <div style={TABLE_BOX}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>{firstCol}</th>
                  <th style={th}>收款（醫生收入）</th>
                  <th style={th}>手續費</th>
                  <th style={th}>收入淨額</th>
                  <th style={th}>醫生分成{report.percent != null ? `（${report.percent}%）` : ''}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.filter(r => !isClinicRow(r) && (report.mode === 'byDoctor' || !isEmptyRow(r))).map(r => (
                  <tr key={r.key}>
                    <td style={td(BLUE, { textAlign: 'left' })}>{r.label}</td>
                    <td style={td(BLUE)}>{money(r.doctorRaw)}</td>
                    <td style={td('#000')}>{money(Math.round((r.doctorRaw - r.doctorNet) * 100) / 100)}</td>
                    <td style={td(BLUE)}>{money(r.doctorNet)}</td>
                    <td style={td(r.share == null ? GRAY : BLUE)}>{r.share == null ? '未設拆帳' : money(r.share)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={td('#000', { textAlign: 'left', fontWeight: 700 })}>Total</td>
                  <td style={td('#000', { fontWeight: 700 })}>{money(report.totals.doctorRaw)}</td>
                  <td style={td('#000', { fontWeight: 700 })}>{money(Math.round((report.totals.doctorRaw - report.totals.doctorNet) * 100) / 100)}</td>
                  <td style={td('#000', { fontWeight: 700 })}>{money(report.totals.doctorNet)}</td>
                  <td style={td('#000', { fontWeight: 700, background: '#ffff00' })}>{money(report.totals.share) || '$0.00'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          </>)}

          <div className="px-4 py-3 text-xs text-gray-500 space-y-1 border-t">
            <div>TOTAL = 店舖營收（只計計入營收嘅付款方式）；灰字欄唔計。顏色同醫生月結 Excel 一樣：藍字 = 系統帶入，黑字粗體 = 合計，黃底 = 最終金額。</div>
            {!isKiosk && <div>醫生分成 = 收入淨額 × 拆帳比例；<b>未扣 Lab／植牙成本，未計 SP 補貼／轉介／調整</b> —— 實際應付以月結單為準。</div>}
            {!isKiosk && report.missingCommission.length > 0 && <div className="text-amber-700">未設拆帳（分成冇計）：{report.missingCommission.join('、')}</div>}
          </div>
        </Card>
      )}
    </div>
  )
}
