'use client'

/**
 * T1: Payout Adjustment Entry — 手動調整錄入
 * OWNER / provider_payout 權限
 * ★ 2026-08-17: 加 clinicId 必填 — 每筆調整必須綁定診所
 */
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Plus, ArrowLeft } from 'lucide-react'
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
  const [form, setForm] = useState({
    providerId: '',
    clinicId: '',
    periodMonth: '',
    sourceMonth: '',
    reason: '',
    refCode: '',
    amount: '',
    note: '',
  })

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
      await apiFetch('/api/payout-adjustments', {
        method: 'POST',
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
      setForm({
        providerId: '', clinicId: '', periodMonth: '', sourceMonth: '',
        reason: '', refCode: '', amount: '', note: '',
      })
      alert('調整記錄已新增')
    } catch (e: any) {
      alert(`提交失敗: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-6">載入中...</div>

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Button
        variant="ghost"
        onClick={() => window.history.back()}
        className="mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> 返回
      </Button>

      <h1 className="text-2xl font-bold mb-6">手動調整錄入</h1>

      {/* Form */}
      <Card className="p-4 mb-6">
        <h2 className="font-semibold mb-3">新增調整</h2>
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
            <Button type="submit" disabled={saving}>
              <Plus className="w-4 h-4 mr-1" />
              {saving ? '提交中...' : '新增調整'}
            </Button>
          )}
        </form>
      </Card>
    </div>
  )
}
