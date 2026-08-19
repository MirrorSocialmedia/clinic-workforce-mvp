'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Database, Loader2, Square, CheckCircle2, XCircle } from 'lucide-react'
import { toast } from 'sonner'

interface PerClinicStatus {
  clinicId: string
  name: string
  payments: number
  lastSyncedAt: string | null
  latestPaidAt: string | null
  earliestPaidAt: string | null
}

interface ReviewDetail {
  paymentExtId: string
  billCode: string | null
  providerName: string | null
  clinicName: string | null
  paidAt: string
  methodNorm: string
  methodRaw: string | null
  amount: number
}

interface SyncStatus {
  lastSyncedAt: string | null
  unknownMethods: string[]
  needsReviewCount: number
  reviewDetails: ReviewDetail[]
  totalPayments: number
  totalBills: number
  perClinic: PerClinicStatus[]
}

interface SyncJob {
  id: string
  status: string
  totalClinics: number
  doneClinics: number
  paymentsSynced: number
  billsChecked: number
  allocRows: number
  currentStep: string | null
  cancelRequested: boolean
  errorMessage: string | null
  startedAt: string
  endedAt: string | null
  createdBy: string
}

// ★ MD-AC3: 店鋪營收卡片
type ClinicRevenueItem = {
  clinicId: string
  name: string
  shortName: string | null
  apricotClinicId: string | null
  bound: boolean
  revenue: number
  allocationRowCount: number
  paymentCount: number
  firstPaidAt: string | null
  lastPaidAt: string | null
  lastSyncedAt: string | null
  providerCount: number
  payoutRunCount: number
  hasData: boolean
}

interface ClinicRevenueData {
  periodMonth: string
  totalRevenue: number
  totalPayments: number
  unsyncedCount: number
  unboundClinics: { id: string; name: string }[]
  clinics: ClinicRevenueItem[]
}

export default function ApricotSyncPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [clinicId, setClinicId] = useState('')
  const [clinics, setClinics] = useState<any[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showReview, setShowReview] = useState(false)

  // ★ MD-Q: Job progress state
  const [activeJob, setActiveJob] = useState<SyncJob | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ★ H3: Load clinics for dropdown
  useEffect(() => {
    fetch('/api/clinics', { credentials: 'include' })
      .then(r => r.json())
      .then((d: any) => setClinics(d.clinics || []))
      .catch(e => { console.error('[apricot-sync] load clinics failed', e); setLoadError('診所名單載入失敗') })
  }, [])

  const syncable = clinics.filter(c => c.apricotClinicId)
  const unboundCount = clinics.length - syncable.length

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/apricot/status', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStatus(data)
    } catch (e: any) {
      toast.error(`載入同步狀態失敗: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // ★ MD-AC3: 店鋪營收（換月 → 數字跟住變）
  const [revenueMonth, setRevenueMonth] = useState(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit' }).format(new Date())
  )
  const [revenue, setRevenue] = useState<ClinicRevenueData | null>(null)
  const [revenueLoading, setRevenueLoading] = useState(true)
  const syncFormRef = useRef<HTMLDivElement | null>(null)

  const fetchRevenue = useCallback(async (month: string) => {
    try {
      const res = await fetch(`/api/apricot/clinic-revenue?periodMonth=${month}`, {
        credentials: 'include',
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRevenue(await res.json())
    } catch (e: any) {
      toast.error(`載入店鋪營收失敗: ${e.message}`)
    } finally {
      setRevenueLoading(false)
    }
  }, [])

  useEffect(() => {
    setRevenueLoading(true)
    fetchRevenue(revenueMonth)
  }, [revenueMonth, fetchRevenue])

  // 「同步 YYYY-MM」掣 — 填好下方手動同步表單（日期 + 診所），唔會自動開始同步
  const handleSyncMonth = (c: ClinicRevenueItem) => {
    const [y, m] = revenueMonth.split('-').map(Number)
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
    setFromDate(`${revenueMonth}-01`)
    setToDate(`${revenueMonth}-${String(lastDay).padStart(2, '0')}`)
    if (c.apricotClinicId) setClinicId(c.apricotClinicId) // ★ 表單 select 用 apricotClinicId 做 value
    syncFormRef.current?.scrollIntoView({ behavior: 'smooth' })
    toast.info(`已為 ${c.name} 填好 ${revenueMonth} 日期範圍，撳「開始同步」`)
  }

  // ★ MD-Q: Poll job progress
  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/apricot/sync/jobs/${jobId}`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (data.job) {
        setActiveJob(data.job)

        // Terminal states: stop polling
        if (['DONE', 'FAILED', 'CANCELLED'].includes(data.job.status)) {
          setSyncing(false)
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
          }

          if (data.job.status === 'DONE') {
            toast.success('同步完成')
            fetchStatus()
          } else if (data.job.status === 'FAILED') {
            toast.error(`同步失敗: ${data.job.errorMessage || '未知錯誤'}`)
          } else if (data.job.status === 'CANCELLED') {
            toast.info('同步已停止')
          }
        }
      }
    } catch (e) {
      console.error('[apricot-sync] poll job failed', e)
    }
  }, [fetchStatus])

  // ★ MD-Q: Stop polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [])

  const handleSync = async () => {
    if (!fromDate || !toDate) {
      toast.error('請填齊起始日期、結束日期')
      return
    }

    setSyncing(true)
    try {
      const res = await fetch('/api/apricot/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          clinicId: clinicId || null,
          from: `${fromDate}T00:00:00+08:00`,
          to: `${toDate}T23:59:59+08:00`,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (res.status === 409 && data.jobId) {
          // 已有 job 進行中，直接開始 poll
          setActiveJob(null)
          pollJob(data.jobId)
          pollTimerRef.current = setInterval(() => pollJob(data.jobId), 2000)
          toast.info('已有同步任務進行中，顯示進度...')
          return
        }
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      if (data.jobId) {
        // ★ MD-Q: 即刻開始 poll
        pollJob(data.jobId)
        pollTimerRef.current = setInterval(() => pollJob(data.jobId), 2000)
        toast.info('同步已開始，請留意進度...')
      }
    } catch (e: any) {
      toast.error(`同步失敗: ${e.message}`)
      setSyncing(false)
    }
  }

  const handleCancel = async () => {
    if (!activeJob) return
    try {
      const res = await fetch(`/api/apricot/sync/jobs/${activeJob.id}`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '取消失敗')
      }
      toast.info('已發送停止指令...')
    } catch (e: any) {
      toast.error(`取消失敗: ${e.message}`)
    }
  }

  // ★ MD-Q: 計算用時
  const formatDuration = (startedAt: string, endedAt: string | null) => {
    const start = new Date(startedAt).getTime()
    const end = endedAt ? new Date(endedAt).getTime() : Date.now()
    const seconds = Math.floor((end - start) / 1000)
    if (seconds < 60) return `${seconds} 秒`
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return secs > 0 ? `${minutes} 分鐘 ${secs} 秒` : `${minutes} 分鐘`
  }

  // ★ MD-Q: 進度條寬度
  const progressPercent = activeJob
    ? activeJob.totalClinics > 0 ? Math.round((activeJob.doneClinics / activeJob.totalClinics) * 100) : 0
    : 0

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[200px]">
        <Loader2 className="animate-spin text-gray-400" size={24} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Apricot 同步狀態</h1>
        <p className="text-sm text-gray-500 mt-1">管理 Apricot payment / bill 數據同步</p>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500">最後同步</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold">
              {status?.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString('zh-HK') : '尚未同步'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500">Payments</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold">{status?.totalPayments ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500">Bills</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold">{status?.totalBills ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500">待覆核</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold">
              {status?.needsReviewCount ?? 0}
              {status && status.needsReviewCount > 0 && (
                <Badge variant="destructive" className="ml-2">needsReview</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ★ MD-AC3: 店鋪營收卡片 — 喺逐診所同步狀態表之上（營收比同步狀態重要） */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-lg font-semibold flex items-center gap-2">
            <Database size={18} />
            店鋪營收
          </div>
          <input
            type="month"
            value={revenueMonth}
            onChange={e => e.target.value && setRevenueMonth(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-white"
          />
        </div>

        {/* 頂部合計 — ★ 唔顯示手續費 */}
        {revenue && (
          <div className="text-sm text-gray-600">
            {revenue.clinics.filter(c => c.bound).length} 間合計{' '}
            <strong className="text-gray-900">${revenue.totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
            <span className="mx-1">·</span>
            付款 {revenue.totalPayments.toLocaleString()} 筆
            {revenue.unsyncedCount > 0 && (
              <>
                <span className="mx-1">·</span>
                <span className="text-amber-600">⚠️ {revenue.unsyncedCount} 間未同步呢個月</span>
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {revenueLoading && (
            <div className="flex items-center justify-center py-8 text-gray-400 text-sm">
              <Loader2 size={16} className="animate-spin mr-2" />
              載入中...
            </div>
          )}
          {revenue && revenue.clinics.filter(c => c.bound).map(c => (
            <ClinicRevenueCard
              key={c.clinicId}
              c={c}
              periodMonth={revenueMonth}
              totalRevenue={revenue.totalRevenue}
              onSyncMonth={handleSyncMonth}
            />
          ))}
          {/* ★ 未綁 Apricot ID：虛線卡，唔好隱藏（隱藏就唔知佢存在） */}
          {revenue && revenue.unboundClinics.map(u => (
            <div key={u.id} className="rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium text-gray-500">{u.name}</span>
              </div>
              <div className="text-sm text-gray-400 mt-2">未綁 Apricot ID</div>
              <div className="text-sm text-gray-500 mt-1">唔會同步、亦唔會出月結單</div>
              <a href="/clinics" className="inline-block text-sm text-blue-600 underline mt-2">
                去診所管理 →
              </a>
            </div>
          ))}
        </div>
      </div>

      {/* Per-Clinic Status (I3) */}
      {status && status.perClinic && status.perClinic.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500">逐診所同步狀態</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="py-2 pr-4">診所</th>
                    <th className="py-2 pr-4">付款數</th>
                    <th className="py-2 pr-4">最後同步</th>
                    <th className="py-2">付款日期範圍</th>
                  </tr>
                </thead>
                <tbody>
                  {status.perClinic.map((c) => (
                    <tr key={c.clinicId} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{c.name}</td>
                      <td className="py-2 pr-4">{c.payments}</td>
                      <td className="py-2 pr-4">
                        {c.lastSyncedAt ? (
                          new Date(c.lastSyncedAt).toLocaleString('zh-HK')
                        ) : (
                          <span className="text-amber-600">⚠️ 未同步過</span>
                        )}
                      </td>
                      <td className="py-2">
                        {c.latestPaidAt ? (
                          <span className="text-xs">
                            {c.earliestPaidAt
                              ? `${new Date(c.earliestPaidAt).toLocaleDateString('zh-HK')} → ${new Date(c.latestPaidAt).toLocaleDateString('zh-HK')}`
                              : new Date(c.latestPaidAt).toLocaleDateString('zh-HK')}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Needs Review Details + Unknown Methods */}
      {status && status.needsReviewCount > 0 && (
        <Card className="p-4 mb-4 border-amber-300 bg-amber-50">
          <div className="flex items-center justify-between">
            <div className="text-sm text-amber-800">
              ⚠️ {status.needsReviewCount} 筆付款方式未設定費率
              {status.unknownMethods.map(m => (
                <span key={m} className="ml-1 px-2 py-0.5 border border-amber-400 rounded text-xs">{m}</span>
              ))}
            </div>
            <button onClick={() => setShowReview(v => !v)} className="text-sm text-blue-600 underline">
              {showReview ? '收起' : `展開明細 (${status.reviewDetails.length})`}
            </button>
          </div>

          {showReview && (
            <table className="w-full text-xs mt-3">
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left py-1">日期</th>
                  <th className="text-left py-1">醫生</th>
                  <th className="text-left py-1">診所</th>
                  <th className="text-left py-1">帳單</th>
                  <th className="text-left py-1">方式</th>
                  <th className="text-right py-1">金額</th>
                </tr>
              </thead>
              <tbody>
                {status.reviewDetails.map(d => (
                  <tr key={`${d.paymentExtId}-${d.methodNorm}`} className="border-t border-amber-200">
                    <td className="py-1">{new Date(d.paidAt).toLocaleDateString('zh-HK')}</td>
                    <td className="py-1">{d.providerName ?? '—'}</td>
                    <td className="py-1">{d.clinicName ?? '—'}</td>
                    <td className="py-1 font-mono">{d.billCode ?? '—'}</td>
                    <td className="py-1">
                      {d.methodNorm}
                      {d.methodRaw && <span className="text-gray-400">（{d.methodRaw}）</span>}
                    </td>
                    <td className="py-1 text-right">${d.amount.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="text-xs text-amber-700 mt-2">
            處理方法：去 <a href="/apricot-sync/payment-methods" className="underline">付款方式規則設定</a>
            加返呢啲方式嘅費率，然後 <strong>重跑同步</strong>（費率係快照，唔會自動重算）
          </div>
        </Card>
      )}

      {/* ★ MD-Q: Progress Card */}
      {activeJob && (
        <Card className={
          activeJob.status === 'DONE' ? 'border-green-300 bg-green-50' :
          activeJob.status === 'FAILED' ? 'border-red-300 bg-red-50' :
          activeJob.status === 'CANCELLED' ? 'border-amber-300 bg-amber-50' :
          'border-blue-300 bg-blue-50'
        }>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              {activeJob.status === 'RUNNING' && <Loader2 size={16} className="animate-spin text-blue-500" />}
              {activeJob.status === 'DONE' && <CheckCircle2 size={16} className="text-green-500" />}
              {activeJob.status === 'FAILED' && <XCircle size={16} className="text-red-500" />}
              {activeJob.status === 'CANCELLED' && <Square size={16} className="text-amber-500" />}

              {activeJob.status === 'RUNNING' && '同步進行中'}
              {activeJob.status === 'DONE' && '同步完成'}
              {activeJob.status === 'FAILED' && '同步失敗'}
              {activeJob.status === 'CANCELLED' && '已停止'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeJob.status === 'RUNNING' && (
              <div className="space-y-3">
                {/* Clinic progress */}
                <div className="text-sm font-medium">
                  診所 {activeJob.doneClinics} / {activeJob.totalClinics}
                </div>

                {/* Progress bar */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-3 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-500"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <span className="text-sm font-mono text-gray-600 w-12 text-right">{progressPercent}%</span>
                </div>

                {/* Current step */}
                {activeJob.currentStep && (
                  <div className="text-sm text-gray-600">
                    目前：{activeJob.currentStep}
                  </div>
                )}

                {/* Synced counts */}
                <div className="text-sm text-gray-700">
                  已同步 付款 {activeJob.paymentsSynced.toLocaleString()} · 帳單 {activeJob.billsChecked.toLocaleString()} · 分配 {activeJob.allocRows.toLocaleString()}
                </div>

                {/* Cancel button */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  className="gap-2 text-amber-700 border-amber-300 hover:bg-amber-100"
                >
                  <Square size={14} />
                  停止同步（已同步嘅資料會保留）
                </Button>
              </div>
            )}

            {activeJob.status === 'DONE' && (
              <div className="space-y-1">
                <div className="text-sm font-medium text-green-700">
                  ✅ 同步完成 · {activeJob.doneClinics} 間診所 · 用時 {formatDuration(activeJob.startedAt, activeJob.endedAt)}
                </div>
                <div className="text-sm text-green-600">
                  付款 {activeJob.paymentsSynced.toLocaleString()} · 帳單 {activeJob.billsChecked.toLocaleString()} · 分配 {activeJob.allocRows.toLocaleString()}
                </div>
              </div>
            )}

            {activeJob.status === 'FAILED' && (
              <div className="space-y-1">
                <div className="text-sm font-medium text-red-700">
                  ❌ 同步失敗 · 完成 {activeJob.doneClinics} / {activeJob.totalClinics} 間
                </div>
                {activeJob.errorMessage && (
                  <div className="text-sm text-red-600">{activeJob.errorMessage}</div>
                )}
                <div className="text-xs text-red-500">★ 已同步嘅資料會保留</div>
              </div>
            )}

            {activeJob.status === 'CANCELLED' && (
              <div className="space-y-1">
                <div className="text-sm font-medium text-amber-700">
                  ⚠️ 已停止 · 完成 {activeJob.doneClinics} / {activeJob.totalClinics} 間
                </div>
                <div className="text-sm text-amber-600">
                  付款 {activeJob.paymentsSynced.toLocaleString()} · 帳單 {activeJob.billsChecked.toLocaleString()} · 分配 {activeJob.allocRows.toLocaleString()}
                </div>
                <div className="text-xs text-amber-500">★ 已同步嘅資料會保留</div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Sync Form */}
      <Card ref={syncFormRef}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw size={18} />
            手動同步
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div>
              <label className="block text-sm text-gray-500 mb-1">診所</label>
              <select
                value={clinicId}
                onChange={e => setClinicId(e.target.value)}
                disabled={syncing}
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                <option value="">全部診所（{syncable.length} 間）</option>
                {syncable.map(c => (
                  <option key={c.id} value={c.apricotClinicId}>{c.name}</option>
                ))}
              </select>
              {unboundCount > 0 && (
                <p className="text-xs text-amber-700 mt-1">
                  ⚠️ {unboundCount} 間診所未綁 Apricot ID，唔會同步
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm text-gray-500 mb-1">起始日期</label>
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                disabled={syncing}
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-500 mb-1">結束日期</label>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                disabled={syncing}
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
            </div>
            <Button
              onClick={handleSync}
              disabled={syncing}
              className="gap-2"
            >
              {syncing ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  同步中...
                </>
              ) : (
                <>
                  <RefreshCw size={16} />
                  開始同步
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Links */}
      <div className="flex gap-4 flex-wrap">
        <a href="/apricot-sync/payment-methods" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <Database size={14} />
          付款方式規則設定
        </a>
        <a href="/apricot-sync/fee-item-prices" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <Database size={14} />
          項目標準價設定
        </a>
      </div>
    </div>
  )
}

// ============================================================
// ★ MD-AC3: 店鋪營收卡片
// ============================================================

const HK = { timeZone: 'Asia/Hong_Kong' } as const

/** $1,234,567.89 格式 */
function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 1/7 格式（day/month） */
function fmtDM(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-HK', { day: 'numeric', month: 'numeric', ...HK })
}

/** 17/8 11:13 格式 */
function fmtSyncTime(iso: string): string {
  const d = new Date(iso)
  const date = d.toLocaleDateString('zh-HK', { day: 'numeric', month: 'numeric', ...HK })
  const time = d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', ...HK })
  return `${date} ${time}`
}

function ClinicRevenueCard({
  c,
  periodMonth,
  totalRevenue,
  onSyncMonth,
}: {
  c: ClinicRevenueItem
  periodMonth: string
  totalRevenue: number
  onSyncMonth: (c: ClinicRevenueItem) => void
}) {
  // ★ 付款日期範圍少過 80% 月份長度 → 標紅（backfill 只做到一半就唔可以當成真實營收）
  const [y, m] = periodMonth.split('-').map(Number)
  const monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const daysCovered = c.firstPaidAt && c.lastPaidAt
    ? Math.round((+new Date(c.lastPaidAt) - +new Date(c.firstPaidAt)) / 86400000) + 1
    : 0
  const rangeIncomplete = c.hasData && daysCovered < monthDays * 0.8

  // 進度條 = 該店營收佔合計比例
  const pct = totalRevenue > 0 ? Math.round((c.revenue / totalRevenue) * 100) : 0

  // 該月未同步（有綁但呢個月冇任何數據）
  if (!c.hasData) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
        <div className="flex items-center justify-between">
          <span className="font-medium">{c.name}</span>
          {c.shortName && <span className="text-xs text-gray-400">{c.shortName}</span>}
        </div>
        <div className="text-sm text-amber-700 mt-2">⚠️ 呢個月未同步</div>
        <div className="text-xs text-gray-500 mt-1">
          最後同步：{c.lastSyncedAt ? fmtSyncTime(c.lastSyncedAt) : '無紀錄'}
        </div>
        <button
          onClick={() => onSyncMonth(c)}
          className="mt-3 text-sm px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
        >
          同步 {periodMonth}
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{c.name}</span>
        {c.shortName && <span className="text-xs text-gray-400">{c.shortName}</span>}
      </div>

      {/* 營收 — ★ 原始金額，唔扣手續費 */}
      <div className="text-xl font-semibold mt-2">{fmtMoney(c.revenue)}</div>

      <div className="text-sm text-gray-600 mt-1">
        付款 {c.paymentCount.toLocaleString()} 筆
      </div>

      {/* ★ 付款日期範圍唔可以慳 */}
      <div className={`text-sm mt-1 ${rangeIncomplete ? 'text-red-600 font-medium' : 'text-gray-600'}`}>
        {c.firstPaidAt && c.lastPaidAt
          ? `${fmtDM(c.firstPaidAt)} – ${fmtDM(c.lastPaidAt)}`
          : '—'}
        {c.lastSyncedAt && (
          <span className={rangeIncomplete ? 'text-red-400' : 'text-gray-400'}>
            {' '}· 同步 {fmtSyncTime(c.lastSyncedAt)}
          </span>
        )}
      </div>

      {/* ★ 只有呢一行做連結去 /payout（卡片本身唔做連結） */}
      <a
        href={`/payout?clinicId=${c.clinicId}&month=${periodMonth}`}
        className="block text-sm text-blue-600 hover:underline mt-1"
      >
        醫生 {c.providerCount} 位 · 已出月結 {c.payoutRunCount} / {c.providerCount}
      </a>

      {/* 營收佔比 */}
      <div className="flex items-center gap-2 mt-2">
        <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
      </div>
    </div>
  )
}
