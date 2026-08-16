'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, AlertTriangle, Database, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface SyncStatus {
  lastSyncedAt: string | null
  unknownMethods: string[]
  needsReviewCount: number
  totalPayments: number
  totalBills: number
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
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      if (data.clinics != null) {
        toast.success(`同步完成：${data.clinics} 間診所，共 ${data.results?.length ?? 0} 筆結果`)
      } else {
        toast.success(`同步完成：${data.paymentsSynced} payments, ${data.billsChecked} bills`)
      }
      fetchStatus()
    } catch (e: any) {
      toast.error(`同步失敗: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

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

      {/* Unknown Methods */}
      {status && status.unknownMethods.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 flex items-center gap-2">
              <AlertTriangle size={14} className="text-yellow-500" />
              未知付款方式（needsReview）
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {status.unknownMethods.map(m => (
                <Badge key={m} variant="outline" className="text-yellow-700 border-yellow-300 bg-yellow-50">
                  {m}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sync Form */}
      <Card>
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
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-500 mb-1">結束日期</label>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
      <div className="flex gap-4">
        <a href="/apricot-sync/payment-methods" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <Database size={14} />
          付款方式規則設定
        </a>
        <a href="/apricot-sync" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <FileText size={14} />
          同步日誌
        </a>
      </div>
    </div>
  )
}
