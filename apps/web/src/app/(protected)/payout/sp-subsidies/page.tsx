'use client'

/**
 * MD-D: SP Subsidies — 2人SP補貼確認
 * OWNER / provider_payout 權限
 * MD-R: R2 needsReview 琥珀邊框 + R3 前端篩選
 * S1: hasMarker 顯示 + S2: await loadSubsidies + S3: skip API
 * S4: reset 掣 + S5: 已確認完整資訊 + §七: 按醫生×診所分組
 * S6: 返回連結 + S8: 排序選擇
 */
import { useEffect, useState, useMemo, useRef } from 'react'
import { apiFetch } from '@/lib/api-client'
import { todayHK } from '@/lib/hk-date'
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
  // ★ cwm-spbulk-20261006：批量確認 —— 有 2P1K 標記嘅預先勾；需覆核嘅唔預先勾（要逐筆睇過先剔）
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const seenRef = useRef<Set<string>>(new Set()) // 已經見過嘅（之後重新載入唔會再自動勾返用戶取消咗嘅）
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState<BulkResultView | null>(null)

  // R3: 篩選 state
  const currentMonth = todayHK().slice(0, 7) // '2026-08'  // ★ cwm-consist S6 TZ-05b：HK 視角當月（舊版 toISOString = UTC slice，00:00–07:59 HK 會差月）
  const [month, setMonth] = useState(currentMonth)
  const [filterProvider, setFilterProvider] = useState('')
  const [filterClinic, setFilterClinic] = useState('')
  const [onlyWithAmount, setOnlyWithAmount] = useState(false)
  const [onlyReview, setOnlyReview] = useState(false)
  const [q, setQ] = useState('')

  // S8: 排序 state
  const [sortBy, setSortBy] = useState<'review' | 'date' | 'amount'>('review')

  // ★ cwm-sppreview-20261006：月結預覽「去 2人SP 確認」帶 ?month=&provider=<醫生名>&clinic=<診所名>（掛載後讀一次，避免 SSR hydration 唔一致）
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const m = sp.get('month')
    if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) { setMonth(m); setScanningMonth(m) }
    if (sp.get('provider')) setFilterProvider(sp.get('provider')!)
    if (sp.get('clinic')) setFilterClinic(sp.get('clinic')!)
  }, [])

  useEffect(() => {
    loadSubsidies()
  }, [month])

  async function loadSubsidies() {
    try {
      const res = await apiFetch<any>(`/api/sp-subsidies?periodMonth=${month}`)
      const list: SpSubsidy[] = (res as any).subsidies || []
      setSubsidies(list)
      const pending = list.filter(s => s.status === 'PENDING')
      // 第一次見到嘅先決定預設（updater 要 pure：StrictMode 會行兩次，唔可以喺入面改 ref）
      const fresh = pending.filter(s => !seenRef.current.has(s.id))
      fresh.forEach(s => seenRef.current.add(s.id))
      const autoPick = fresh.filter(s => !s.needsReview).map(s => s.id)
      setSelected(prev => {
        const pendingIds = new Set(pending.map(s => s.id))
        return new Set([...Array.from(prev).filter(id => pendingIds.has(id)), ...autoPick])
      })
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
      const r = res as any
      let msg = `掃描完成：新增 ${r.created ?? 0} · 更新 ${r.updated ?? 0}`
      if (r.skippedLocked > 0) msg += ` · 已鎖定跳過 ${r.skippedLocked}`
      if (r.failed?.length > 0) {
       msg += `\n⚠️ ${r.failed.length} 筆失敗：\n`
       msg += r.failed.slice(0, 5).map((f: any) => ` ${f.eleId}: ${f.error}`).join('\n')
      }
      alert(msg)
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

  async function handleBulkConfirm(rows: SpSubsidy[]) {
    if (bulkBusy || rows.length === 0) return
    setBulkBusy(true)
    try {
      const res = await apiFetch<any>('/api/sp-subsidies/bulk-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: rows.map(s => ({ id: s.id, amount: Number(s.amount) })) }),
      })
      const r = res as BulkResultView
      setBulkResult(r)
      setBulkOpen(false)
      // 冇確認到嘅（例如金額變咗）取消剔 —— 要人重新睇過先揀
      setSelected(prev => { const n = new Set(prev); r.rejected.forEach(x => n.delete(x.id)); return n })
      await loadSubsidies()
    } catch (e: any) {
      alert(`批量確認失敗: ${e.message}`)
    } finally {
      setBulkBusy(false)
    }
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
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

  // ★ cwm-spbulk：底部條只計睇得到（篩選後）而又揀咗嘅待確認
  const selectedRows = filteredPending.filter(s => selected.has(s.id))
  const selectedTotal = round2(selectedRows.reduce((a, s) => a + Number(s.amount), 0))
  const selectedReview = selectedRows.filter(s => s.needsReview).length
  const allVisibleSelected = filteredPending.length > 0 && selectedRows.length === filteredPending.length
  const pendingMarked = filteredPending.filter(s => !s.needsReview)
  const pendingReview = filteredPending.filter(s => s.needsReview)

  function toggleAll() {
    setSelected(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) filteredPending.forEach(s => next.delete(s.id))
      else filteredPending.forEach(s => next.add(s.id))
      return next
    })
  }

  function renderPendingRow(s: SpSubsidy) {
    return (
      <div key={s.id} className={`flex justify-between items-center gap-3 border rounded p-3 ${s.needsReview ? 'border-amber-400 border-2' : selected.has(s.id) ? 'bg-green-50/60' : ''}`}>
        <input type="checkbox" className="w-5 h-5 shrink-0" checked={selected.has(s.id)} onChange={() => toggle(s.id)}
          aria-label={`揀 帳單 ${s.billCode ?? s.id}`} disabled={bulkBusy} />
        <div className="text-sm flex-1">
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
            disabled={confirming === s.id || bulkBusy}
          >
            <Check className="w-3 h-3" /> {confirming === s.id ? '確認中...' : '確認'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleSkip(s.id)}
            disabled={bulkBusy}
          >
            <X className="w-3 h-3" /> 跳過
          </Button>
        </div>
      </div>
    )
  }

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

      {/* ★ cwm-spbulk：批量確認結果 */}
      {bulkResult && <BulkResultCard r={bulkResult} onClose={() => setBulkResult(null)} />}

      {/* Pending list — R2: needsReview 琥珀邊框；★ cwm-spbulk：剔格 + 底部批量確認 */}
      <Card className="p-4 mb-6">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
          <label className="flex items-center gap-2 font-semibold text-orange-700">
            <input type="checkbox" className="w-5 h-5" checked={allVisibleSelected} onChange={toggleAll}
              disabled={filteredPending.length === 0 || bulkBusy} aria-label="全選待確認" />
            待確認 ({filteredPending.length}) · 全選
          </label>
          {filteredPending.length > 0 && (
            <span className="text-xs text-gray-500">撳「全選」會連需覆核嘅都揀埋，確認前會再提一次</span>
          )}
        </div>
        {filteredPending.length === 0 && (
          <p className="text-gray-500 text-sm">暫無待確認補貼</p>
        )}
        {sortBy === 'review' ? (
          <>
            {pendingMarked.length > 0 && (
              <>
                <div className="text-sm font-semibold text-green-800 mb-2">✓ 有 2P1K 標記（{pendingMarked.length}）— 已預先勾選</div>
                <div className="space-y-2 mb-4">{pendingMarked.map(renderPendingRow)}</div>
              </>
            )}
            {pendingReview.length > 0 && (
              <>
                <div className="text-sm font-semibold text-amber-800 mb-2">⚠ 需覆核（{pendingReview.length}）— 冇預先勾，要逐筆睇過先剔</div>
                <div className="space-y-2">{pendingReview.map(renderPendingRow)}</div>
              </>
            )}
          </>
        ) : (
          <div className="space-y-2">{filteredPending.map(renderPendingRow)}</div>
        )}
      </Card>

      {selectedRows.length > 0 && (
        <div className="sticky bottom-3 z-20 mb-6 flex flex-wrap justify-between items-center gap-3 rounded-lg bg-slate-800 text-white px-4 py-3 shadow-lg" role="region" aria-label="批量確認">
          <span>
            已揀 <b>{selectedRows.length}</b> 筆 · 合共 <b>${selectedTotal}</b>
            <span className="text-slate-300 text-sm"> · 其中需覆核 {selectedReview} 筆</span>
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setSelected(prev => { const n = new Set(prev); selectedRows.forEach(s => n.delete(s.id)); return n })}
              disabled={bulkBusy} className="h-10 px-3 rounded border border-slate-500 text-sm">清除選擇</button>
            <button type="button" onClick={() => setBulkOpen(true)} disabled={bulkBusy}
              className="h-10 px-4 rounded bg-teal-600 hover:bg-teal-700 font-semibold disabled:opacity-50">✓ 確認已揀 {selectedRows.length} 筆</button>
          </div>
        </div>
      )}

      {bulkOpen && (
        <BulkConfirmDialog rows={selectedRows} month={month} busy={bulkBusy}
          onCancel={() => setBulkOpen(false)} onConfirm={() => handleBulkConfirm(selectedRows)} />
      )}

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

// ─── ★ cwm-spbulk-20261006：批量確認 ─────────────────────────────────────

interface BulkResultView {
  confirmed: Array<{ id: string; amount: number }>
  already: string[]
  rejected: Array<{ id: string; reason: 'AMOUNT_CHANGED' | 'LOCKED' | 'NOT_FOUND' | 'NOT_PENDING'; billCode?: string | null; providerName?: string | null; amount?: number; expected: number }>
}

function round2(n: number) { return Math.round(n * 100) / 100 }

function BulkConfirmDialog({ rows, month, busy, onCancel, onConfirm }: {
  rows: SpSubsidy[]; month: string; busy: boolean; onCancel: () => void; onConfirm: () => void
}) {
  const total = round2(rows.reduce((a, s) => a + Number(s.amount), 0))
  const review = rows.filter(s => s.needsReview).length
  const byDoc = useMemo(() => {
    const m = new Map<string, { n: number; rev: number; amt: number }>()
    for (const s of rows) {
      const k = s.providerName ?? '未知'
      const g = m.get(k) ?? { n: 0, rev: 0, amt: 0 }
      g.n++; if (s.needsReview) g.rev++; g.amt = round2(g.amt + Number(s.amount))
      m.set(k, g)
    }
    return Array.from(m.entries()).sort((a, b) => b[1].amt - a[1].amt)
  }, [rows])
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-auto" role="dialog" aria-modal="true" aria-label="確認已揀SP補貼">
      <div className="bg-white rounded-xl w-full max-w-xl p-6 mt-16 flex flex-col gap-4">
        <div className="text-xl font-bold">確認 {rows.length} 筆 2人SP補貼？</div>
        <div className="text-sm text-gray-600">{month} · 合共 <b className="text-gray-900">${total}</b></div>
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr><th className="text-left p-2">醫生</th><th className="text-right p-2">筆數</th><th className="text-right p-2">需覆核</th><th className="text-right p-2">金額</th></tr>
            </thead>
            <tbody>
              {byDoc.map(([doc, g]) => (
                <tr key={doc} className="border-t">
                  <td className="p-2 font-medium">{doc}</td>
                  <td className="p-2 text-right tabular-nums">{g.n}</td>
                  <td className={`p-2 text-right tabular-nums ${g.rev ? 'text-amber-700 font-semibold' : 'text-gray-500'}`}>{g.rev}</td>
                  <td className="p-2 text-right tabular-nums font-semibold">${g.amt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {review > 0 && (
          <div className="bg-amber-50 border border-amber-400 rounded p-3 text-sm text-amber-900">
            ⚠ 其中 <b>{review} 筆需覆核</b>（冇 2P1K 備註或者金額唔啱）。如果未逐筆核對，請返去取消剔。
          </div>
        )}
        <div className="text-xs text-gray-500">確認咗嘅會計入醫生月結。已鎖定月結、或者喺你睇完之後金額有變嘅，系統唔會確認，會逐筆話返你知。</div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>返回</Button>
          <Button onClick={onConfirm} disabled={busy}>{busy ? '確認中…' : `確認 ${rows.length} 筆（$${total}）`}</Button>
        </div>
      </div>
    </div>
  )
}

const REJECT_LABEL: Record<string, (r: BulkResultView['rejected'][number]) => string> = {
  AMOUNT_CHANGED: r => `金額由 $${r.expected} 變咗 $${r.amount}（有人重新掃描），請睇過再確認`,
  LOCKED: () => '呢個月結已經鎖定，改唔到',
  NOT_FOUND: () => '呢筆已經唔存在（可能已刪除）',
  NOT_PENDING: () => '已經被跳過，冇確認',
}

function BulkResultCard({ r, onClose }: { r: BulkResultView; onClose: () => void }) {
  const total = round2(r.confirmed.reduce((a, c) => a + c.amount, 0))
  return (
    <div className="mb-4 flex flex-col gap-2" role="status" aria-label="批量確認結果">
      <div className="flex justify-between items-start bg-green-50 border border-green-300 rounded p-3">
        <div>
          <div className="font-semibold text-green-800">✓ 已確認 {r.confirmed.length} 筆 · ${total}</div>
          <div className="text-xs text-gray-600">已移去「已確認」，個別仍然可以「取消確認」。{r.already.length > 0 && ` ${r.already.length} 筆本身已確認，冇重複寫。`}</div>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 underline">收埋</button>
      </div>
      {r.rejected.length > 0 && (
        <div className="bg-amber-50 border border-amber-400 rounded p-3 text-sm">
          <div className="font-semibold text-amber-800 mb-1">⚠ {r.rejected.length} 筆冇確認</div>
          <ul className="space-y-0.5 text-gray-700">
            {r.rejected.map(x => (
              <li key={x.id}>帳單 {x.billCode ?? '—'}{x.providerName ? ` · ${x.providerName}` : ''} —— {REJECT_LABEL[x.reason]?.(x) ?? x.reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
