'use client'

/**
 * T1: Payout Adjustment Entry — 手動調整錄入
 * OWNER / provider_payout 權限
 * ★ 2026-08-17: 加 clinicId 必填 — 每筆調整必須綁定診所
 * ★ cwm-adjedit-20261013: 錄錯可以改／刪（只限未入月結；已入月結要先解鎖刪草稿，或者下期加反向調整）
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Plus, ArrowLeft, Pencil, Trash2, Save } from 'lucide-react'
import { hasPermission } from '@/lib/permissions'

export default function AdjustmentsPage() {
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const canPayout = userRole ? hasPermission(userRole, 'provider_payout', grant, deny) : false

  // Form state
  const EMPTY_FORM = {
    providerId: '',
    clinicId: '',
    periodMonth: '',
    sourceMonth: '',
    reason: '',
    refCode: '',
    amount: '',
    note: '',
  }
  const [form, setForm] = useState(EMPTY_FORM)
  // ★ cwm-adjedit-20261013：editingId = 正在改邊筆（null = 新增）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  function startEdit(r: AdjRow) {
    setEditingId(r.id)
    setForm({
      providerId: r.providerId,
      clinicId: r.clinicId || '',
      periodMonth: r.periodMonth,
      sourceMonth: r.sourceMonth && r.sourceMonth !== r.periodMonth ? r.sourceMonth : '',
      reason: r.reason,
      refCode: r.refCode || '',
      amount: String(r.amount),
      note: r.note || '',
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  async function handleDelete(r: AdjRow) {
    const amt = `${r.amount < 0 ? '−' : '+'}$${Math.abs(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    if (!confirm(`確定刪除呢筆調整？\n\n${r.periodMonth} · ${r.providerName} · ${r.clinicName}\n${REASON_LABEL[r.reason] ?? r.reason} ${amt}${r.note ? `\n${r.note}` : ''}\n\n刪除後醫生月結預覽會即刻唔再計呢筆。`)) return
    setBusyId(r.id)
    try {
      await apiFetch(`/api/payout-adjustments/${r.id}`, { method: 'DELETE' })
      if (editingId === r.id) cancelEdit()
      loadList()
    } catch (e: any) {
      alert(`刪除失敗: ${e.message}`)
      loadList()
    } finally {
      setBusyId(null)
    }
  }

  // ★ cwm-adjlist-20261012：之前嘅手動調整記錄（預設全部最近 200 筆；可篩月份／醫生／診所）
  const [rows, setRows] = useState<AdjRow[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [fMonth, setFMonth] = useState('')
  const [fProvider, setFProvider] = useState('')
  const [fClinic, setFClinic] = useState('')
  const loadList = useCallback(async () => {
    setListLoading(true)
    setListError('')
    try {
      const q = new URLSearchParams()
      if (fMonth) q.set('month', fMonth)
      if (fProvider) q.set('providerId', fProvider)
      if (fClinic) q.set('clinicId', fClinic)
      const res = await apiFetch<{ adjustments: AdjRow[] }>(`/api/payout-adjustments?${q}`)
      setRows(res.adjustments || [])
    } catch (e: any) {
      setListError(e?.message || '載入記錄失敗')
    } finally {
      setListLoading(false)
    }
  }, [fMonth, fProvider, fClinic])
  useEffect(() => { loadList() }, [loadList])

  const REASONS = [
    { value: 'MANUAL', label: '手動調整' },
    { value: 'VOID', label: '作廢回沖' },
    { value: 'REFUND', label: '退款' },
  ]

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    try {
      const [provRes, clinicRes, meRes] = await Promise.all([
        apiFetch<any>('/api/providers'),
        apiFetch<any>('/api/clinics'),
        apiFetch<any>('/api/me'),
      ])
      setProviders((provRes as any).providers || [])
      setClinics((clinicRes as any).clinics || [])
      setUserRole((meRes as any).user?.role || '')
      setGrant((meRes as any).user?.grant || [])
      setDeny((meRes as any).user?.deny || [])
    } catch (e) {
      console.error('Failed to load data', e)
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.providerId || !form.clinicId || !form.periodMonth || !form.reason || !form.amount) {
      alert('providerId, clinicId, periodMonth, reason, amount 都係必填')
      return
    }
    const amt = Number(form.amount)
    if (!Number.isFinite(amt)) {
      alert('金額異常')
      return
    }
    if (form.reason === 'VOID' && amt > 0) {
      alert('作廢回沖金額必須係負數')
      return
    }
    setSaving(true)
    try {
      await apiFetch(editingId ? `/api/payout-adjustments/${editingId}` : '/api/payout-adjustments', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: form.providerId,
          clinicId: form.clinicId,
          periodMonth: form.periodMonth,
          sourceMonth: form.sourceMonth || form.periodMonth,
          reason: form.reason,
          refCode: form.refCode || null,
          amount: amt,
          note: form.note || '',
        }),
      })
      setForm(EMPTY_FORM)
      alert(editingId ? '調整記錄已修改' : '調整記錄已新增')
      setEditingId(null)
      loadList()
    } catch (e: any) {
      alert(`提交失敗: ${e.message}`)
      if (editingId) loadList()
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-6">載入中...</div>

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Button
        variant="ghost"
        onClick={() => window.history.back()}
        className="mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> 返回
      </Button>

      <h1 className="text-2xl font-bold mb-6">手動調整錄入</h1>

      {/* Form */}
      <Card className={`p-4 mb-6 ${editingId ? 'ring-2 ring-amber-400' : ''}`}>
        <h2 className="font-semibold mb-3">{editingId ? '✏️ 修改調整' : '新增調整'}</h2>
        {editingId && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
            你而家改緊下面記錄表入面一筆調整。儲存後醫生月結預覽會即刻用新數。
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">醫生 <span className="text-red-500">*</span></label>
              <select
                className="w-full border rounded px-3 py-2"
                value={form.providerId}
                onChange={e => setForm({ ...form, providerId: e.target.value })}
                required
              >
                <option value="">選擇醫生</option>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">診所 <span className="text-red-500">*</span></label>
              <select
                className="w-full border rounded px-3 py-2"
                value={form.clinicId}
                onChange={e => setForm({ ...form, clinicId: e.target.value })}
                required
              >
                <option value="">選擇診所</option>
                {clinics.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.shortName || c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">月份 <span className="text-red-500">*</span></label>
              <Input
                type="month"
                value={form.periodMonth}
                onChange={e => setForm({ ...form, periodMonth: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">原月份（可選）</label>
              <Input
                type="month"
                value={form.sourceMonth}
                onChange={e => setForm({ ...form, sourceMonth: e.target.value })}
                placeholder="預設=月份"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">原因 <span className="text-red-500">*</span></label>
              <select
                className="w-full border rounded px-3 py-2"
                value={form.reason}
                onChange={e => setForm({ ...form, reason: e.target.value })}
                required
              >
                <option value="">選擇原因</option>
                {REASONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">金額 <span className="text-red-500">*</span></label>
              <Input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                placeholder="負數=扣減，正數=加回"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">單據編號（可選）</label>
              <Input
                value={form.refCode}
                onChange={e => setForm({ ...form, refCode: e.target.value })}
                placeholder="如 Apricot 單據編號"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">備註</label>
              <Input
                value={form.note}
                onChange={e => setForm({ ...form, note: e.target.value })}
                placeholder="可選備註..."
              />
            </div>
          </div>

          <div className="text-xs text-gray-400">
            * 作廢回沖（VOID）金額必須為負數
          </div>

          {canPayout && (
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>
                {editingId ? <Save className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
                {saving ? '提交中...' : editingId ? '儲存修改' : '新增調整'}
              </Button>
              {editingId && (
                <Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>取消修改</Button>
              )}
            </div>
          )}
        </form>
      </Card>

      {/* ★ cwm-adjlist-20261012：之前嘅手動調整記錄 */}
      <Card className="p-4 mb-6">
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <h2 className="font-semibold mr-auto">之前嘅調整記錄</h2>
          <label className="text-xs text-gray-600 flex flex-col gap-1">月份
            <Input type="month" value={fMonth} onChange={e => setFMonth(e.target.value)} className="h-9" />
          </label>
          <label className="text-xs text-gray-600 flex flex-col gap-1">醫生
            <select className="border rounded px-2 h-9 text-sm" value={fProvider} onChange={e => setFProvider(e.target.value)}>
              <option value="">全部醫生</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-600 flex flex-col gap-1">診所
            <select className="border rounded px-2 h-9 text-sm" value={fClinic} onChange={e => setFClinic(e.target.value)}>
              <option value="">全部診所</option>
              {clinics.map(c => <option key={c.id} value={c.id}>{c.shortName || c.name}</option>)}
            </select>
          </label>
          {(fMonth || fProvider || fClinic) && (
            <button type="button" className="text-xs underline text-gray-500 h-9" onClick={() => { setFMonth(''); setFProvider(''); setFClinic('') }}>清除</button>
          )}
        </div>
        {listError && <div className="text-sm text-red-700 mb-2">⚠️ {listError}</div>}
        {listLoading ? (
          <div className="text-sm text-gray-500 py-4">載入中…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-gray-500 py-4">{fMonth || fProvider || fClinic ? '呢個篩選冇調整記錄' : '未有調整記錄'}</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b text-xs text-gray-500">
                    <th className="py-1.5 pr-2">月份</th>
                    <th className="py-1.5 pr-2">醫生</th>
                    <th className="py-1.5 pr-2">診所</th>
                    <th className="py-1.5 pr-2">原因</th>
                    <th className="py-1.5 pr-2 text-right">金額</th>
                    <th className="py-1.5 pr-2">單據／備註</th>
                    <th className="py-1.5 pr-2">月結</th>
                    <th className="py-1.5 pr-2">錄入</th>
                    {canPayout && <th className="py-1.5"></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className={`border-b last:border-0 align-top ${editingId === r.id ? 'bg-amber-50' : ''}`}>
                      <td className="py-1.5 pr-2 whitespace-nowrap">
                        {r.periodMonth}
                        {r.sourceMonth && r.sourceMonth !== r.periodMonth && <div className="text-xs text-gray-500">原 {r.sourceMonth}</div>}
                      </td>
                      <td className="py-1.5 pr-2">{r.providerName}</td>
                      <td className="py-1.5 pr-2 whitespace-nowrap">{r.clinicName}</td>
                      <td className="py-1.5 pr-2 whitespace-nowrap">{REASON_LABEL[r.reason] ?? r.reason}</td>
                      <td className={`py-1.5 pr-2 text-right tabular-nums whitespace-nowrap font-semibold ${r.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>
                        {r.amount < 0 ? '−' : '+'}${Math.abs(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-1.5 pr-2 text-xs text-gray-700 max-w-[220px]">
                        {r.refCode && <div className="font-mono">{r.refCode}</div>}
                        {r.note && <div className="break-words">{r.note}</div>}
                        {!r.refCode && !r.note && <span className="text-gray-400">—</span>}
                      </td>
                      <td className="py-1.5 pr-2 whitespace-nowrap text-xs">
                        {r.runStatus === 'LOCKED' ? <span className="text-green-700">🔒 已入月結</span>
                          : r.runStatus ? <span className="text-amber-700">草稿月結</span>
                          : <span className="text-gray-500">未入月結</span>}
                      </td>
                      <td className="py-1.5 pr-2 text-xs text-gray-500 whitespace-nowrap">
                        {r.createdByName}
                        <div>{new Date(r.createdAt).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</div>
                      </td>
                      {canPayout && (
                        <td className="py-1.5 whitespace-nowrap text-xs">
                          {r.runStatus === null ? (
                            <div className="flex gap-1">
                              <button type="button" title="修改" aria-label="修改" disabled={busyId === r.id}
                                className="inline-flex items-center gap-0.5 px-2 py-1 rounded border text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                onClick={() => startEdit(r)}><Pencil className="w-3 h-3" />修改</button>
                              <button type="button" title="刪除" aria-label="刪除" disabled={busyId === r.id}
                                className="inline-flex items-center gap-0.5 px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
                                onClick={() => handleDelete(r)}><Trash2 className="w-3 h-3" />{busyId === r.id ? '刪除中…' : '刪除'}</button>
                            </div>
                          ) : (
                            <span className="text-gray-400" title="已入月結單：要先解鎖並刪除嗰張月結草稿，或者喺下期加一筆反向調整">已入月結，唔可以改</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-gray-500 mt-2">
              共 {rows.length} 筆{rows.length >= 200 ? '（最多顯示最近 200 筆，請用月份／醫生篩選）' : ''} · 合計{' '}
              <b className="tabular-nums">{(() => { const t = Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100; return `${t < 0 ? '−' : '+'}$${Math.abs(t).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` })()}</b>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

interface AdjRow {
  id: string
  providerId: string
  providerName: string
  clinicId: string | null
  clinicName: string
  periodMonth: string
  sourceMonth: string
  reason: string
  refCode: string | null
  amount: number
  note: string
  createdByName: string
  createdAt: string
  runStatus: string | null
}

const REASON_LABEL: Record<string, string> = { MANUAL: '手動調整', VOID: '作廢回沖', REFUND: '退款' }
