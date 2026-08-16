'use client'

/**
 * MD-D: Provider Referrals — 轉介錄入
 * OWNER / provider_payout 權限
 */
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Plus, Trash2, ArrowLeft } from 'lucide-react'

export default function ReferralsPage() {
  const [referrals, setReferrals] = useState<any[]>([])
  const [providers, setProviders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Form state
  const [form, setForm] = useState({
    fromProviderId: '',
    toProviderId: '',
    billExtId: '',
    billCode: '',
    billItemEleId: '',
    itemDes: '',
    unitPrice: '',
    qty: '1',
    refPercent: '2',
    periodMonth: '',
    note: '',
  })

  useEffect(() => {
    loadAll()
  }, [])

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

  const calculatedAmount = (() => {
    const up = Number(form.unitPrice) || 0
    const qty = Number(form.qty) || 1
    const rp = Number(form.refPercent) || 2
    return (up * qty * rp / 100).toFixed(2)
  })()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.fromProviderId || !form.billItemEleId || !form.itemDes || !form.unitPrice || !form.periodMonth) {
      alert('必填欄位未填寫')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/api/provider-referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          unitPrice: Number(form.unitPrice),
          qty: Number(form.qty),
          refPercent: Number(form.refPercent),
        }),
      })
      setForm({
        fromProviderId: '', toProviderId: '', billExtId: '', billCode: '',
        billItemEleId: '', itemDes: '', unitPrice: '', qty: '1',
        refPercent: '2', periodMonth: '', note: '',
      })
      loadAll()
    } catch (e: any) {
      alert(`提交失敗: ${e.message}`)
    } finally {
      setSaving(false)
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

  if (loading) return <div className="p-6">載入中...</div>

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <a href="/payout" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-4">
        <ArrowLeft size={14} /> 返回醫生月結單
      </a>
      <h1 className="text-2xl font-bold mb-6">轉介錄入</h1>

      {/* Form */}
      <Card className="p-4 mb-6">
        <h2 className="font-semibold mb-3">新增轉介</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">轉介醫生</label>
              <select
                className="w-full border rounded px-3 py-2"
                value={form.fromProviderId}
                onChange={e => setForm({ ...form, fromProviderId: e.target.value })}
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
                value={form.toProviderId}
                onChange={e => setForm({ ...form, toProviderId: e.target.value })}
              >
                <option value="">選擇醫生</option>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">單據編號</label>
              <Input
                value={form.billCode}
                onChange={e => setForm({ ...form, billCode: e.target.value })}
                placeholder="202607050007"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">月份</label>
              <Input
                type="month"
                value={form.periodMonth}
                onChange={e => setForm({ ...form, periodMonth: e.target.value })}
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-600 mb-1">項目描述</label>
            <Input
              value={form.itemDes}
              onChange={e => setForm({ ...form, itemDes: e.target.value })}
              placeholder="IMPLANT / BRIDGE / ..."
              required
            />
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">單價</label>
              <Input
                type="number"
                step="0.01"
                value={form.unitPrice}
                onChange={e => setForm({ ...form, unitPrice: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">數量</label>
              <Input
                type="number"
                value={form.qty}
                onChange={e => setForm({ ...form, qty: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">轉介%（預設2%）</label>
              <Input
                type="number"
                step="0.01"
                value={form.refPercent}
                onChange={e => setForm({ ...form, refPercent: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">金額（自動計算）</label>
              <Input value={`$${calculatedAmount}`} readOnly className="bg-gray-50" />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-600 mb-1">備註</label>
            <Input
              value={form.note}
              onChange={e => setForm({ ...form, note: e.target.value })}
              placeholder="可選備註..."
            />
          </div>

          <Button type="submit" disabled={saving}>
            <Plus className="w-4 h-4 mr-1" />
            {saving ? '提交中...' : '新增轉介'}
          </Button>
        </form>
      </Card>

      {/* List */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3">轉介記錄</h2>
        {referrals.length === 0 && <p className="text-gray-500 text-sm">暫無轉介記錄</p>}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-1">醫生</th>
              <th className="py-1">項目</th>
              <th className="py-1 text-right">單價</th>
              <th className="py-1 text-right">數量</th>
              <th className="py-1 text-right">金額</th>
              <th className="py-1">月份</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {referrals.map(r => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="py-1">{r.fromProviderId}</td>
                <td className="py-1">{r.itemDes}</td>
                <td className="py-1 text-right">${r.unitPrice}</td>
                <td className="py-1 text-right">{r.qty}</td>
                <td className="py-1 text-right font-medium">${r.amount}</td>
                <td className="py-1">{r.periodMonth}</td>
                <td className="py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(r.id)}
                  >
                    <Trash2 className="w-3 h-3 text-red-500" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
