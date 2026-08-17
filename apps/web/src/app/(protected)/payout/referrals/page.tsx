'use client'

/**
 * MD-U: Provider Referrals — 轉介錄入（改版 V1）
 * - U2: 帳單搜尋 + 勾選項目 + 批次轉介
 * - U3: 草稿系統（DRAFT/CONFIRMED）+ 取消確認
 * - V1: 分三區直排（草稿最前 → 已確認 → 帳單轉介）
 * OWNER / provider_payout 權限
 */
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Plus, Trash2, ArrowLeft, Search, Check, RotateCcw, FileText, ClipboardList,
} from 'lucide-react'

/** W1: Draft reference for completing a draft with bill data */
interface DraftRef {
  id: string
  fromProviderId: string
  fromProviderName?: string
  patientNote: string | null
  periodMonth: string
}

export default function ReferralsPage() {
  // ─── Data ───────────────────────────────────────────────────────
  const [referrals, setReferrals] = useState<any[]>([])
  const [providers, setProviders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // ─── Bill lookup state ─────────────────────────────────────────
  const [searchCode, setSearchCode] = useState('')
  const [billData, setBillData] = useState<any>(null)
  const [selectedItems, setSelectedItems] = useState<string[]>([])
  const [refPercent, setRefPercent] = useState('2')
  const [batchLoading, setBatchLoading] = useState(false)

  // W1: completingDraft state
  const [completingDraft, setCompletingDraft] = useState<DraftRef | null>(null)

  // ─── Draft form state ──────────────────────────────────────────
  const [showDraftForm, setShowDraftForm] = useState(false)
  const [draftForm, setDraftForm] = useState({
    fromProviderId: '',
    toProviderId: '',
    patientNote: '',
    periodMonth: new Date().toISOString().slice(0, 7),
  })
  const [draftSaving, setDraftSaving] = useState(false)

  // W1: fromProviderId for bill-referral-section (pre-filled from draft or bill)
  const [fromProviderId, setFromProviderId] = useState('')

  // ─── Effects ───────────────────────────────────────────────────
  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    try {
      const [refRes, provRes] = await Promise.all([
        apiFetch<any>('/api/provider-referrals'),
        apiFetch<any>('/api/providers'),
      ])
      setReferrals((refRes as any).referrals || [])
      setProviders((provRes as any).providers || [])
    } catch (e) {
      console.error('Failed to load data', e)
    } finally {
      setLoading(false)
    }
  }

  // ─── Bill lookup ───────────────────────────────────────────────
  async function lookupBill() {
    if (!searchCode.trim()) return
    try {
      const res = await apiFetch<any>(`/api/provider-referrals/bill-lookup?code=${encodeURIComponent(searchCode.trim())}`)
      setBillData(res)
      setSelectedItems([])
      // Pre-fill fromProviderId from bill if not already set (e.g. from draft)
      if (!completingDraft && res.providerId) {
        setFromProviderId(res.providerId)
      }
    } catch (e: any) {
      alert(`查找失敗: ${e.message || '帳單未找到'}`)
      setBillData(null)
    }
  }

  const toggleItem = (eleId: string) => {
    setSelectedItems(v => v.includes(eleId) ? v.filter(x => x !== eleId) : [...v, eleId])
  }

  const selectedTotal = useMemo(() => {
    const items = billData?.items.filter((i: any) => selectedItems.includes(i.eleId)) || []
    return items.reduce((sum: number, i: any) => sum + i.unitPrice * i.qty, 0)
  }, [billData, selectedItems])

  const refAmount = selectedTotal * (Number(refPercent) || 0) / 100

  // W1: handleSubmit — dual path (completingDraft → PUT / new → batch POST)
  async function handleSubmit() {
    if (completingDraft) {
      // 補草稿：只准一個項目
      if (selectedItems.length !== 1) {
        alert('補上帳單時只可以揀一個項目。如果要入多個，請取消後用新增。')
        return
      }
      if (!billData) { alert('請先搜尋帳單'); return }
      const it = billData.items.find((i: any) => i.eleId === selectedItems[0])
      if (!it) { alert('找不到選定項目'); return }
      setBatchLoading(true)
      try {
        await apiFetch(`/api/provider-referrals/${completingDraft.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            billExtId: billData.billExtId,
            billCode: billData.billCode,
            billItemEleId: it.eleId,
            itemDes: it.feeItemDes,
            unitPrice: it.unitPrice,
            qty: it.qty,
            refPercent,
            status: 'CONFIRMED',
          }),
        })
        setCompletingDraft(null)
        setFromProviderId('')
        setBillData(null)
        setSelectedItems([])
        setSearchCode('')
        await loadAll()
      } catch (e: any) {
        alert(`補上帳單失敗：${e.message}`)
      } finally {
        setBatchLoading(false)
      }
      return
    }

    // Batch new referral path
    if (selectedItems.length === 0) { alert('請勾選項目'); return }
    if (!billData) return
    setBatchLoading(true)
    try {
      const items = billData.items.filter((i: any) => selectedItems.includes(i.eleId))
      await apiFetch('/api/provider-referrals/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromProviderId,
          billExtId: billData.billExtId,
          refPercent: Number(refPercent),
          items: items.map((i: any) => ({
            eleId: i.eleId,
            itemDes: i.feeItemDes,
            unitPrice: i.unitPrice,
            qty: i.qty,
          })),
        }),
      })
      alert(`成功新增 ${items.length} 筆轉介`)
      setSelectedItems([])
      setBillData(null)
      setSearchCode('')
      loadAll()
    } catch (e: any) {
      alert(`批次轉介失敗: ${e.message}`)
    } finally {
      setBatchLoading(false)
    }
  }

  // ─── Draft operations ──────────────────────────────────────────
  async function handleCreateDraft(e: React.FormEvent) {
    e.preventDefault()
    if (!draftForm.fromProviderId || !draftForm.periodMonth) {
      alert('轉介醫生和月份為必填')
      return
    }
    setDraftSaving(true)
    try {
      await apiFetch('/api/provider-referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draftForm,
          status: 'DRAFT',
        }),
      })
      setDraftForm({
        fromProviderId: '', toProviderId: '', patientNote: '',
        periodMonth: new Date().toISOString().slice(0, 7),
      })
      setFromProviderId('')
      setShowDraftForm(false)
      loadAll()
    } catch (e: any) {
      alert(`建立草稿失敗: ${e.message}`)
    } finally {
      setDraftSaving(false)
    }
  }

  async function handleDeleteDraft(id: string) {
    if (!confirm('確定刪除此草稿？')) return
    try {
      await apiFetch(`/api/provider-referrals/${id}`, { method: 'DELETE' })
      loadAll()
    } catch (e: any) {
      alert(`刪除失敗: ${e.message}`)
    }
  }

  // W1: Navigate to bill referral section to complete a draft
  function goToBillReferral(draft: DraftRef) {
    setCompletingDraft(draft)
    setFromProviderId(draft.fromProviderId)
    setSearchCode('')
    setBillData(null)
    setSelectedItems([])
    document.getElementById('bill-referral-section')?.scrollIntoView({ behavior: 'smooth' })
  }

  // ─── Confirmed operations ──────────────────────────────────────
  async function handleReset(id: string) {
    if (!confirm('確定取消確認？轉介將變回草稿狀態。')) return
    try {
      await apiFetch(`/api/provider-referrals/${id}/reset`, { method: 'POST' })
      loadAll()
    } catch (e: any) {
      alert(`取消確認失敗: ${e.message}`)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('確定刪除此轉介記錄？')) return
    try {
      await apiFetch(`/api/provider-referrals/${id}`, { method: 'DELETE' })
      loadAll()
    } catch (e: any) {
      alert(`刪除失敗: ${e.message}`)
    }
  }

  // ─── Derived data ──────────────────────────────────────────────
  const drafts = referrals.filter(r => r.status !== 'CONFIRMED')
  const confirmed = referrals.filter(r => r.status === 'CONFIRMED')

  if (loading) return <div className="p-6">載入中...</div>

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <a href="/payout" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-2">
        <ArrowLeft size={14} /> 返回醫生月結單
      </a>
      <h1 className="text-2xl font-bold">轉介錄入</h1>

      {/* ═══════════════════════════════════════════════════════
          SECTION 1: Draft referrals (最前 — 未完成嘅工作)
          ═══════════════════════════════════════════════════════ */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2">
            <FileText className="w-4 h-4" />
            草稿（{drafts.length}）
          </h2>
          <Button size="sm" onClick={() => setShowDraftForm(v => !v)}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            {showDraftForm ? '收起表單' : '新增草稿'}
          </Button>
        </div>

        {/* Draft creation form */}
        {showDraftForm && (
          <form onSubmit={handleCreateDraft} className="mb-4 p-3 bg-amber-50 rounded space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">轉介醫生 *</label>
                <select
                  className="w-full border rounded px-3 py-2"
                  value={draftForm.fromProviderId}
                  onChange={e => setDraftForm({ ...draftForm, fromProviderId: e.target.value })}
                  required
                >
                  <option value="">選擇醫生</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">接手醫生（可選）</label>
                <select
                  className="w-full border rounded px-3 py-2"
                  value={draftForm.toProviderId}
                  onChange={e => setDraftForm({ ...draftForm, toProviderId: e.target.value })}
                >
                  <option value="">選擇醫生</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">病人備註</label>
              <Input
                value={draftForm.patientNote}
                onChange={e => setDraftForm({ ...draftForm, patientNote: e.target.value })}
                placeholder="病人名稱或識別資訊"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">月份 *</label>
              <Input
                type="month"
                value={draftForm.periodMonth}
                onChange={e => setDraftForm({ ...draftForm, periodMonth: e.target.value })}
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={draftSaving} size="sm">
                {draftSaving ? '提交中...' : '建立草稿'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowDraftForm(false)}>
                取消
              </Button>
            </div>
          </form>
        )}

        {/* Draft list */}
        {drafts.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">暫無草稿</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b bg-gray-50">
                <th className="py-2 px-2">轉介醫生</th>
                <th className="py-2 px-2">病人備註</th>
                <th className="py-2 px-2">月份</th>
                <th className="py-2 px-2 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d: any) => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="py-2 px-2">{d.fromProviderName || d.fromProviderId}</td>
                  <td className="py-2 px-2">{d.patientNote || '—'}</td>
                  <td className="py-2 px-2">{d.periodMonth}</td>
                  <td className="py-2 px-2 text-center space-x-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-blue-600 text-xs"
                      onClick={() => goToBillReferral({
                        id: d.id,
                        fromProviderId: d.fromProviderId,
                        fromProviderName: d.fromProviderName,
                        patientNote: d.patientNote,
                        periodMonth: d.periodMonth,
                      })}
                    >
                      <FileText className="w-3.5 h-3.5 mr-1" />
                      補上帳單
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteDraft(d.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ═══════════════════════════════════════════════════════
          SECTION 2: Confirmed referrals
          ═══════════════════════════════════════════════════════ */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Check className="w-4 h-4" />
          已確認（{confirmed.length}）
        </h2>

        {confirmed.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">暫無已確認轉介</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b bg-gray-50">
                <th className="py-2 px-2">轉介醫生</th>
                <th className="py-2 px-2">診所</th>
                <th className="py-2 px-2">帳單編號</th>
                <th className="py-2 px-2">項目</th>
                <th className="py-2 px-2 text-right">單價</th>
                <th className="py-2 px-2 text-right">數量</th>
                <th className="py-2 px-2 text-right">轉介%</th>
                <th className="py-2 px-2 text-right">金額</th>
                <th className="py-2 px-2 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {confirmed.map((r: any) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="py-2 px-2">{r.fromProviderName || r.fromProviderId}</td>
                  <td className="py-2 px-2">{r.clinicName || '—'}</td>
                  <td className="py-2 px-2">{r.billCode || '—'}</td>
                  <td className="py-2 px-2">{r.itemDes || '—'}</td>
                  <td className="py-2 px-2 text-right">
                    {r.unitPrice != null ? `$${r.unitPrice.toFixed(2)}` : '—'}
                  </td>
                  <td className="py-2 px-2 text-right">{r.qty}</td>
                  <td className="py-2 px-2 text-right">{r.refPercent}%</td>
                  <td className="py-2 px-2 text-right font-medium">
                    {r.amount != null ? `$${r.amount.toFixed(2)}` : '—'}
                  </td>
                  <td className="py-2 px-2 text-center space-x-1">
                    <button
                      onClick={() => handleReset(r.id)}
                      className="text-xs text-amber-600 underline hover:text-amber-800 flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      取消確認
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(r.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ═══════════════════════════════════════════════════════
          SECTION 3: Bill lookup + batch referral (入新轉介嘅表单)
          ═══════════════════════════════════════════════════════ */}
      <Card className="p-4" id="bill-referral-section">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Search className="w-4 h-4" /> 帳單轉介
        </h2>

        {/* W1: Status bar when completing a draft */}
        {completingDraft && (
          <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-3 flex justify-between items-center">
            <div className="text-sm">
              <span className="font-medium text-blue-800">補上帳單中</span>
              <span className="ml-2 text-gray-700">
                {completingDraft.fromProviderName ?? completingDraft.fromProviderId}
                {completingDraft.patientNote && ` · ${completingDraft.patientNote}`}
              </span>
            </div>
            <button
              onClick={() => {
                setCompletingDraft(null)
                setFromProviderId('')
                setBillData(null)
                setSelectedItems([])
                setSearchCode('')
              }}
              className="text-sm text-blue-600 underline"
            >
              取消
            </button>
          </div>
        )}

        <div className="flex flex-col gap-3 mb-4">
          {/* W1: fromProviderId select - disabled when completing draft */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-sm text-gray-600 mb-1">轉介醫生</label>
              <select
                className="w-full border rounded px-3 py-2"
                value={fromProviderId}
                disabled={!!completingDraft}
                onChange={e => setFromProviderId(e.target.value)}
              >
                <option value="">選擇醫生</option>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
          <Input
            value={searchCode}
            onChange={e => setSearchCode(e.target.value)}
            placeholder="輸入帳單編號（如 202607050007）"
            onKeyDown={e => e.key === 'Enter' && lookupBill()}
          />
          <Button onClick={lookupBill}>
            <Search className="w-4 h-4 mr-1" /> 搜尋
          </Button>
          </div>
        </div>

        {billData && (
          <div className="space-y-4">
            {/* Bill info */}
            <div className="flex flex-wrap gap-4 text-sm bg-gray-50 p-3 rounded">
              <span><strong>帳單:</strong> {billData.billCode}</span>
              <span><strong>醫生:</strong> {billData.providerName || '—'}</span>
              <span><strong>診所:</strong> {billData.clinicName || '—'}</span>
              <span><strong>日期:</strong> {new Date(billData.billTime).toLocaleDateString('zh-HK')}</span>
            </div>

            {/* Items table with checkboxes */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b bg-gray-50">
                    <th className="py-2 px-2 w-8">
                      <input
                        type="checkbox"
                        checked={billData.items.length > 0 && selectedItems.length === billData.items.filter((i: any) => !i.alreadyReferred).length}
                        onChange={e => {
                          if (e.target.checked) {
                            setSelectedItems(billData.items.filter((i: any) => !i.alreadyReferred).map((i: any) => i.eleId))
                          } else {
                            setSelectedItems([])
                          }
                        }}
                      />
                    </th>
                    <th className="py-2 px-2">項目</th>
                    <th className="py-2 px-2 text-right">單價</th>
                    <th className="py-2 px-2 text-right">數量</th>
                    <th className="py-2 px-2 text-right">小計</th>
                    <th className="py-2 px-2 text-center">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {billData.items.map((item: any) => (
                    <tr
                      key={item.eleId}
                      className={`border-b hover:bg-gray-50 ${item.alreadyReferred ? 'opacity-50' : ''}`}
                    >
                      <td className="py-2 px-2">
                        <input
                          type="checkbox"
                          checked={selectedItems.includes(item.eleId)}
                          onChange={() => toggleItem(item.eleId)}
                          disabled={item.alreadyReferred}
                        />
                      </td>
                      <td className="py-2 px-2">{item.feeItemDes}</td>
                      <td className="py-2 px-2 text-right">${item.unitPrice.toFixed(2)}</td>
                      <td className="py-2 px-2 text-right">{item.qty}</td>
                      <td className="py-2 px-2 text-right font-medium">${item.amt.toFixed(2)}</td>
                      <td className="py-2 px-2 text-center">
                        {item.alreadyReferred && (
                          <Badge variant="secondary" className="text-xs">已轉介</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Summary + submit */}
            {selectedItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-4 p-3 bg-blue-50 rounded">
                <div className="text-sm">
                  <span className="font-medium">已選 {selectedItems.length} 項</span>
                  <span className="text-gray-600 ml-2">
                    合計: <strong>${selectedTotal.toFixed(2)}</strong>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm">轉介%:</label>
                  <Input
                    type="number"
                    step="0.1"
                    value={refPercent}
                    onChange={e => setRefPercent(e.target.value)}
                    className="w-20"
                  />
                </div>
                <div className="text-sm">
                  轉介金額: <strong className="text-blue-700">${refAmount.toFixed(2)}</strong>
                </div>
                <div className="flex-1" />
                <Button onClick={handleSubmit} disabled={batchLoading}>
                  <Plus className="w-4 h-4 mr-1" />
                  {batchLoading ? '提交中...' : completingDraft ? '確認補上帳單' : `批次轉介 (${selectedItems.length} 項)`}
                </Button>
              </div>
            )}
          </div>
        )}

        {!billData && (
          <div className="text-center py-8 text-gray-400">
            <ClipboardList className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">輸入帳單編號搜尋項目</p>
          </div>
        )}
      </Card>
    </div>
  )
}
