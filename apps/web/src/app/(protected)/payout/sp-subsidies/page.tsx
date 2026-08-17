'use client'

/**
 * MD-D: SP Subsidies — 2人SP補貼確認
 * OWNER / provider_payout 權限
 * MD-R: R2 needsReview 琥珀邊框 + R3 前端篩選
 * S1: hasMarker 顯示 + S2: await loadSubsidies + S3: skip API
 * S4: reset 掣 + S5: 已確認完整資訊 + §七: 按醫生×診所分組
 * S6: 返回連結 + S8: 排序選擇
 */
import { useEffect, useState, useMemo } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Check, X, Search, ArrowLeft } from 'lucide-react'
import { SP_2P1K_PER_PERSON } from '@/lib/payout/constants'

interface SpSubsidy {
  id: string
  itemDes: string
  listPrice: number | null
  actualPrice: number | null
  headcount: number
  splitPercent: number
  amount: number
  needsReview: boolean
  source: string
  status: string // PENDING | CONFIRMED | SKIPPED
  hasMarker: boolean
  confirmedBy: string | null
  periodMonth: string
  providerName: string | null
  clinicName: string | null
  billCode: string | null
  billTime: string | null
}

function spReviewReason(s: SpSubsidy): string {
  // S1: hasMarker 放最前
  if (!s.hasMarker) return '冇 2P1K 備註，只係實收啱 $500，請核對係咪 2 人同行'
  if (s.listPrice == null || Number(s.listPrice) === Number(s.actualPrice)) {
    return '揾唔到標準價，請去項目標準價設定'
  }
  if (Number(s.splitPercent) === 0) {
    return '該醫生未設拆帳 %，請去醫生管理'
  }
  return `實收 $${Number(s.actualPrice)} 唔係預期嘅 $${SP_2P1K_PER_PERSON}，請核對帳單`
}

export default function SpSubsidiesPage() {
  const [subsidies, setSubsidies] = useState<SpSubsidy[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanningMonth, setScanningMonth] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  // R3: 篩選 state
  const [month, setMonth] = useState('')
  const [filterProvider, setFilterProvider] = useState('')
  const [filterClinic, setFilterClinic] = useState('')
  const [onlyWithAmount, setOnlyWithAmount] = useState(false)
  const [onlyReview, setOnlyReview] = useState(false)
  const [q, setQ] = useState('')

  // S8: 排序 state
  const [sortBy, setSortBy] = useState<'review' | 'date' | 'amount'>('review')

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
      await loadSubsidies()
    } catch (e: any) {
      alert(`掃描失敗: ${e.message}`)
    } finally {
      setScanning(false)
    }
  }

  // S2: await loadSubsidies()
  async function handleConfirm(id: string) {
    setConfirming(id)
    try {
      await apiFetch(`/api/sp-subsidies/${id}/confirm`, {
        method: 'POST',
      })
      await loadSubsidies() // ★ await
    } catch (e: any) {
      alert(`確認失敗: ${e.message}`)
    } finally {
      setConfirming(null)
    }
  }

  // S3: skip 打 API
  async function handleSkip(id: string) {
    if (!confirm('跳過此補貼？')) return
    try {
      await apiFetch(`/api/sp-subsidies/${id}/skip`, { method: 'POST' })
      await loadSubsidies()
    } catch (e: any) {
      alert(`跳過失敗: ${e.message}`)
    }
  }

  // S4: reset 打 API
  async function handleReset(id: string) {
    if (!confirm('取消此操作？')) return
    try {
      await apiFetch(`/api/sp-subsidies/${id}/reset`, { method: 'POST' })
      await loadSubsidies()
    } catch (e: any) {
      alert(`取消失敗: ${e.message}`)
    }
  }

  // R3: 篩選邏輯
  const filtered = useMemo(() => subsidies.filter(s => {
    if (month && s.periodMonth !== month) return false
    if (filterProvider && s.providerName !== filterProvider) return false
    if (filterClinic && s.clinicName !== filterClinic) return false
    if (onlyWithAmount && Number(s.amount) === 0) return false
    if (onlyReview && !s.needsReview) return false
    if (q && !s.billCode?.includes(q)) return false
    return true
  }), [subsidies, month, filterProvider, filterClinic, onlyWithAmount, onlyReview, q])

  // S8: 排序邏輯 — 用戶揀咗排序 → needsReview 唔強制排最前
  const sorted = useMemo(() => {
    const arr = [...filtered]
    switch (sortBy) {
      case 'date':
        arr.sort((a, b) => {
          const ta = a.billTime ? new Date(a.billTime).getTime() : 0
          const tb = b.billTime ? new Date(b.billTime).getTime() : 0
          return ta - tb
        })
        break
      case 'amount':
        arr.sort((a, b) => Number(b.amount) - Number(a.amount))
        break
      case 'review':
      default:
        // needsReview 強制排最前
        arr.sort((a, b) => {
          if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1
          const ta = a.billTime ? new Date(a.billTime).getTime() : 0
          const tb = b.billTime ? new Date(b.billTime).getTime() : 0
          if (ta !== tb) return ta - tb
          return (a.billCode ?? '').localeCompare(b.billCode ?? '')
        })
    }
    return arr
  }, [filtered, sortBy])

  // 選項由資料導出
  const providerOptions = useMemo(() => [...new Set(subsidies.map(s => s.providerName).filter(Boolean))] as string[], [subsidies])
  const clinicOptions = useMemo(() => [...new Set(subsidies.map(s => s.clinicName).filter(Boolean))] as string[], [subsidies])

  // R3: 摘要跟住篩選變
  const filteredPending = sorted.filter(s => s.status === 'PENDING')
  const filteredConfirmed = sorted.filter(s => s.status === 'CONFIRMED')
  const filteredSkipped = sorted.filter(s => s.status === 'SKIPPED')
  const filteredWithSubsidy = sorted.filter(s => Number(s.amount) > 0)
  const filteredTotalSubsidy = filteredWithSubsidy.reduce((sum, s) => sum + Number(s.amount), 0)
  const filteredNeedsReview = sorted.filter(s => s.needsReview)

  // §七: 摘要按醫生 × 診所分組
  const confirmedGroups = useMemo(() => {
    const map = new Map<string, { count: number; total: number; key: string }>()
    for (const s of filteredConfirmed) {
      const key = `${s.providerName ?? '未知'} · ${s.clinicName ?? '未知'}`
      const entry = map.get(key)
      if (entry) {
        entry.count++
        entry.total += Number(s.amount)
      } else {
        map.set(key, { count: 1, total: Number(s.amount), key })
      }
    }
    return [...map.values()].sort((a, b) => b.total - a.total)
  }, [filteredConfirmed])

  if (loading) return <div className="p-6">載入中...</div>

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* S6: 返回連結 */}
      <a href="/payout" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-4">
        <ArrowLeft size={14} /> 返回醫生月結單
      </a>

      <h1 className="text-2xl font-bold mb-6">2人SP補貼確認</h1>

      {/* R3: 篩選區 */}
      <Card className="p-4 mb-4">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">月份</label>
            <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">醫生</label>
            <select value={filterProvider} onChange={e => setFilterProvider(e.target.value)}>
              <option value="">全部</option>
              {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">診所</label>
            <select value={filterClinic} onChange={e => setFilterClinic(e.target.value)}>
              <option value="">全部</option>
              {clinicOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={onlyWithAmount} onChange={e => setOnlyWithAmount(e.target.checked)} />
            只顯示有補貼
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={onlyReview} onChange={e => setOnlyReview(e.target.checked)} />
            只顯示需覆核
          </label>
          <input placeholder="帳單編號" value={q} onChange={e => setQ(e.target.value)} className="w-40" />
          {/* S8: 排序選擇 */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">排序</label>
            <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
              <option value="review">需覆核優先</option>
              <option value="date">日期（早→遲）</option>
              <option value="amount">金額（大→細）</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Summary bar — R3: 跟住篩選變 */}
      {sorted.length > 0 && (
        <div className="text-sm text-gray-600 mb-4">
          {sorted.length} / {subsidies.length} 筆
          {' · '}{filteredWithSubsidy.length} 筆有補貼（合共 ${filteredTotalSubsidy}）
          {' · '}{filteredNeedsReview.length} 筆需覆核
        </div>
      )}

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

      {/* Pending list — R2: needsReview 琥珀邊框 */}
      <Card className="p-4 mb-6">
        <h2 className="font-semibold mb-3 text-orange-700">待確認 ({filteredPending.length})</h2>
        {filteredPending.length === 0 && (
          <p className="text-gray-500 text-sm">暫無待確認補貼</p>
        )}
        <div className="space-y-2">
          {filteredPending.map(s => (
            <div key={s.id} className={`flex justify-between items-center border rounded p-3 ${s.needsReview ? 'border-amber-400 border-2' : ''}`}>
              <div className="text-sm">
                <div className="font-medium">
                  {s.itemDes}
                  {s.providerName && <> · {s.providerName}</>}
                  {s.clinicName && <> · {s.clinicName}</>}
                </div>
                {(s.billCode || s.billTime) && (
                  <div className="text-gray-500">
                    帳單 {s.billCode ?? '—'} · {s.billTime ? new Date(s.billTime).toLocaleDateString('zh-HK') : '—'}
                  </div>
                )}
                <div className="text-gray-500">
                  原價 ${s.listPrice} → 優惠價 ${s.actualPrice} × {s.headcount}人 ({s.splitPercent}%)
                </div>
                <div className="text-gray-500">
                  月份: {s.periodMonth} | 來源: {s.source}
                  {/* S1: hasMarker 顯示 */}
                  {' · '}{s.hasMarker ? '✅ 2P1K 標記' : '⚠️ 冇標記（金額吻合）'}
                </div>
                {/* R2: needsReview 原因 */}
                {s.needsReview && (
                  <div className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    ⚠️ 需要覆核：{spReviewReason(s)}
                  </div>
                )}
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

      {/* Confirmed list — S5: 完整資訊 + §七: 按醫生×診所分組 */}
      <Card className="p-4 mb-6">
        <h2 className="font-semibold mb-3 text-green-700">
          已確認 ({filteredConfirmed.length}) · 合共 ${filteredConfirmed.reduce((sum, s) => sum + Number(s.amount), 0)}
        </h2>
        {/* §七: 按醫生 × 診所分組摘要 */}
        {confirmedGroups.length > 0 && (
          <div className="text-sm text-gray-500 mb-3 space-y-0.5">
            {confirmedGroups.map(g => (
              <div key={g.key}> {g.key} {g.count} 筆 ${g.total}</div>
            ))}
          </div>
        )}
        {filteredConfirmed.length === 0 && (
          <p className="text-gray-500 text-sm">暫無已確認補貼</p>
        )}
        <div className="space-y-2">
          {filteredConfirmed.map(s => (
            <div key={s.id} className={`flex justify-between items-center border rounded p-3 ${s.needsReview ? 'border-amber-400 border-2' : ''}`}>
              <div className="text-sm">
                <div className="font-medium">
                  {s.itemDes}
                  {s.providerName && <> · {s.providerName}</>}
                  {s.clinicName && <> · {s.clinicName}</>}
                </div>
                {(s.billCode || s.billTime) && (
                  <div className="text-gray-500">
                    帳單 {s.billCode ?? '—'} · {s.billTime ? new Date(s.billTime).toLocaleDateString('zh-HK') : '—'}
                  </div>
                )}
                <div className="text-gray-500">
                  原價 ${s.listPrice} → 優惠價 ${s.actualPrice}
                </div>
                {s.needsReview && (
                  <div className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    ⚠️ {spReviewReason(s)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-bold text-green-700">${s.amount}</span>
                {/* S4: 取消確認 */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleReset(s.id)}
                >
                  取消確認
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Skipped list */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3 text-gray-500">已跳過 ({filteredSkipped.length})</h2>
        {filteredSkipped.length === 0 && (
          <p className="text-gray-500 text-sm">暫無已跳過補貼</p>
        )}
        <div className="space-y-2">
          {filteredSkipped.map(s => (
            <div key={s.id} className={`flex justify-between items-center border rounded p-3 ${s.needsReview ? 'border-amber-400 border-2' : ''}`}>
              <div className="text-sm">
                <div className="font-medium">
                  {s.itemDes}
                  {s.providerName && <> · {s.providerName}</>}
                  {s.clinicName && <> · {s.clinicName}</>}
                </div>
                {(s.billCode || s.billTime) && (
                  <div className="text-gray-500">
                    帳單 {s.billCode ?? '—'} · {s.billTime ? new Date(s.billTime).toLocaleDateString('zh-HK') : '—'}
                  </div>
                )}
                <div className="text-gray-500">
                  原價 ${s.listPrice} → 優惠價 ${s.actualPrice}
                </div>
                {s.needsReview && (
                  <div className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    ⚠️ {spReviewReason(s)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-bold text-gray-500">${s.amount}</span>
                {/* S4: 取消跳過 */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleReset(s.id)}
                >
                  取消跳過
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
