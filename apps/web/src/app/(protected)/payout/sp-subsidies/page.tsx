'use client'

/**
 * MD-D: SP Subsidies — 2人SP補貼確認
 * OWNER / provider_payout 權限
 */
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Check, X, Search } from 'lucide-react'

export default function SpSubsidiesPage() {
  const [subsidies, setSubsidies] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanningMonth, setScanningMonth] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    loadSubsidies()
  }, [])

  async function loadSubsidies() {
    try {
      const res = await apiFetch<any>('/api/sp-subsidies')
      setSubsidies((res as any).subsidies || [])
    } catch (e) {
      console.error('Failed to load SP subsidies', e)
    } finally {
      setLoading(false)
    }
  }

  async function handleScan() {
    if (!scanningMonth) {
      alert('請選擇月份')
      return
    }
    setScanning(true)
    try {
      const res = await apiFetch<any>('/api/sp-subsidies/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodMonth: scanningMonth }),
      })
      alert(`掃描完成，發現 ${(res as any).count} 筆候選`)
      loadSubsidies()
    } catch (e: any) {
      alert(`掃描失敗: ${e.message}`)
    } finally {
      setScanning(false)
    }
  }

  async function handleConfirm(id: string) {
    setConfirming(id)
    try {
      await apiFetch(`/api/sp-subsidies/${id}/confirm`, {
        method: 'POST',
      })
      loadSubsidies()
    } catch (e: any) {
      alert(`確認失敗: ${e.message}`)
    } finally {
      setConfirming(null)
    }
  }

  async function handleSkip(id: string) {
    if (!confirm('跳過此補貼？跳過後不會計入月結單。')) return
    // Remove from list (or mark as skipped)
    setSubsidies(subsidies.filter(s => s.id !== id))
  }

  if (loading) return <div className="p-6">載入中...</div>

  const unconfirmed = subsidies.filter(s => !s.confirmedBy)
  const confirmed = subsidies.filter(s => s.confirmedBy)

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">2人SP補貼確認</h1>

      {/* Scan section */}
      <Card className="p-4 mb-6">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Search className="w-4 h-4" /> 自動偵測
        </h2>
        <div className="flex gap-3 items-end">
          <div>
            <label className="block text-sm text-gray-600 mb-1">月份</label>
            <Input
              type="month"
              value={scanningMonth}
              onChange={e => setScanningMonth(e.target.value)}
              className="w-44"
            />
          </div>
          <Button onClick={handleScan} disabled={scanning || !scanningMonth}>
            {scanning ? '掃描中...' : '掃描候選'}
          </Button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          自動偵測有折扣嘅 SCALING & POLISHING / S&P / 潔牙 項目
        </p>
      </Card>

      {/* Unconfirmed list */}
      <Card className="p-4 mb-6">
        <h2 className="font-semibold mb-3 text-orange-700">待確認 ({unconfirmed.length})</h2>
        {unconfirmed.length === 0 && (
          <p className="text-gray-500 text-sm">暫無待確認補貼</p>
        )}
        <div className="space-y-2">
          {unconfirmed.map(s => (
            <div key={s.id} className="flex justify-between items-center border rounded p-3">
              <div className="text-sm">
                <div className="font-medium">{s.itemDes}</div>
                <div className="text-gray-500">
                  原價 ${s.listPrice} → 優惠價 ${s.actualPrice} × {s.headcount}人
                  {' '} ({s.splitPercent}%)
                </div>
                <div className="text-gray-500">月份: {s.periodMonth} | 來源: {s.source}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-bold text-green-700">${s.amount}</span>
                <Button
                  size="sm"
                  onClick={() => handleConfirm(s.id)}
                  disabled={confirming === s.id}
                >
                  <Check className="w-3 h-3" /> {confirming === s.id ? '確認中...' : '確認'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleSkip(s.id)}
                >
                  <X className="w-3 h-3" /> 跳過
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Confirmed list */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3 text-green-700">已確認 ({confirmed.length})</h2>
        {confirmed.length === 0 && (
          <p className="text-gray-500 text-sm">暫無已確認補貼</p>
        )}
        <div className="space-y-1 text-sm">
          {confirmed.map(s => (
            <div key={s.id} className="flex justify-between py-1 border-b last:border-0">
              <span>{s.itemDes} ({s.periodMonth})</span>
              <span className="text-green-700 font-medium">${s.amount}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
