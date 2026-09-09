'use client'

// ============================================================
// 雜項收入錄入（cwm-payoutxlsx-20260908 D3）
// 版面照 cost-entry/materials/page.tsx（Card + table + modal 套路）。
// ★ 底部三行（合計/手續費/淨額）口徑：
//   合計 = Σ 非 void amount；手續費 = Σ(逐行 feePercent × amount)；淨額 = 合計 − 手續費
//   feePercent 用 API 帶返嘅值（server 端 resolveMethodRule，同寫入驗證同一口徑）——
//   前端唔重算，兩邊唔會出兩個數。void 行唔入合計。
// ============================================================

import { useEffect, useState, useCallback, useMemo, type CSSProperties } from 'react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import { toHKDateStr, todayHK } from '@/lib/hk-date'
import { Card } from '@/components/ui/card'
import { Plus, Loader2 } from 'lucide-react'

interface MiscRow {
  id: string
  clinicId: string
  incomeAt: string
  category: string
  itemName: string
  note: string | null
  methodNorm: string
  amount: number
  feePercent: number | null // ★ server resolve（規則已刪 = null，按 0 計）
  periodMonth: string
  isVoid: boolean
}

const CATEGORY_OPTIONS = [
  { value: 'PRODUCT', label: '產品銷售' },
  { value: 'DEPOSIT', label: '器材按金' },
  { value: 'OTHER', label: '其他' },
] as const

const CATEGORY_LABELS: Record<string, string> = {
  PRODUCT: '產品銷售',
  DEPOSIT: '器材按金',
  OTHER: '其他',
}

// ★ canonical 付款方式清單 — 同來源：lib/apricot/normalize.ts METHOD_MAP（顯示名 → methodNorm）。
//   下拉 = 此清單 ∪ PaymentMethodRule 現有 method（rules API 讀得到時；cost_entry 無
//   provider_payout → 403 → 照用 canonical 清單）。dev（0 rules）同生產都有選項；
//   選咗無規則嘅方法 → API 照舊 400（唔准靜靜當 0%）。
const METHOD_OPTIONS: { display: string; norm: string }[] = [
  { display: 'CASH', norm: 'CASH' },
  { display: 'HCV', norm: 'HCV' },
  { display: 'FPS', norm: 'FPS' },
  { display: 'CREDIT', norm: 'CREDIT' },
  { display: 'VISA', norm: 'VISA' },
  { display: 'MASTER', norm: 'MASTERCARD' },
  { display: 'AE', norm: 'AMEX' },
  { display: 'ALIPAY HK', norm: 'ALIPAY' },
  { display: 'UNION PAY', norm: 'UNIONPAY' },
  { display: 'OCTOPUS', norm: 'OCTOPUS' },
  { display: 'WECHAT PAY', norm: 'WECHAT' },
  { display: 'PAYME', norm: 'PAYME' },
  { display: 'CCF', norm: 'CCF' },
  { display: 'FREE SP', norm: 'FREE_SP' },
]

const round2 = (n: number) => Math.round(n * 100) / 100

export default function MiscIncomePage() {
  const [rows, setRows] = useState<MiscRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])

  // Filters
  const [clinics, setClinics] = useState<any[]>([])
  const [filterClinicId, setFilterClinicId] = useState('')
  const [filterPeriodMonth, setFilterPeriodMonth] = useState('') // '' = 全部月份

  // Modal（新增 / 編輯共用）
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<MiscRow | null>(null)
  const [form, setForm] = useState({
    incomeAt: '',
    category: 'OTHER',
    itemName: '',
    note: '',
    methodNorm: '',
    amount: '',
  })
  const [saving, setSaving] = useState(false)

  // 作廢（confirm）
  const [voidTarget, setVoidTarget] = useState<MiscRow | null>(null)

  // rules API 讀得到時嘅額外面值（canonical 之外）
  const [extraMethods, setExtraMethods] = useState<{ display: string; norm: string }[]>([])

  // 新增 / 編輯 / 作廢 同一權限門（cost_entry）
  const canEdit = userRole ? hasPermission(userRole, 'cost_entry', grant, deny) : false

  const loadAuth = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/me')
      setUserRole(data.user?.role || '')
      setGrant(data.user?.grant ?? [])
      setDeny(data.user?.deny ?? [])
    } catch (e) {
      console.error('[misc-income] load auth failed', e)
      setLoadError('權限載入失敗')
    }
  }, [])

  const loadClinics = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/clinics')
      const list = data.clinics || []
      setClinics(list)
      // ★ 錄入頁：診所必選（無「全部診所」），預設第一間
      setFilterClinicId(prev => prev || (list[0]?.id ?? ''))
    } catch (e) {
      console.error('[misc-income] load clinics failed', e)
      setLoadError('載入診所列表失敗')
    }
  }, [])

  // ★ canonical ∪ 現有 PaymentMethodRule method（讀唔到 = 403 → 只用 canonical，照有選項）
  const loadRules = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/payment-method-rules')
      const canon = new Set(METHOD_OPTIONS.map(o => o.norm))
      const seen = new Set<string>()
      const extras: { display: string; norm: string }[] = []
      for (const r of data.rules || []) {
        if (!canon.has(r.method) && !seen.has(r.method)) {
          seen.add(r.method)
          extras.push({ display: r.label || r.method, norm: r.method })
        }
      }
      setExtraMethods(extras)
    } catch {
      // cost_entry 用戶無 provider_payout → 403，靜默（canonical 清單已經有）
    }
  }, [])

  const loadRows = useCallback(async () => {
    if (!filterClinicId) {
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('clinicId', filterClinicId)
      if (filterPeriodMonth) params.set('periodMonth', filterPeriodMonth)
      const data: any = await apiFetch(`/api/misc-income?${params}`)
      setRows(data.items || [])
    } catch (e) {
      console.error('[misc-income] load rows failed', e)
      setLoadError('雜項收入列表載入失敗')
    } finally {
      setLoading(false)
    }
  }, [filterClinicId, filterPeriodMonth])

  useEffect(() => {
    loadAuth()
    loadClinics()
    loadRules()
  }, [loadAuth, loadClinics, loadRules])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  // 下拉選項：canonical + rules 額外 + 編輯中该行嘅 methodNorm（唔會彈出選項外）
  const methodOptions = useMemo(() => {
    const opts = [...METHOD_OPTIONS, ...extraMethods]
    if (editing && !opts.some(o => o.norm === editing.methodNorm)) {
      opts.unshift({ display: editing.methodNorm, norm: editing.methodNorm })
    }
    return opts
  }, [extraMethods, editing])

  // ★ 底部三行（同月報 Clinic 頁口徑）— 永遠排除 void
  const totals = useMemo(() => {
    const active = rows.filter(r => !r.isVoid)
    const total = round2(active.reduce((s, r) => s + r.amount, 0))
    // 逐行 feePercent × amount（逐行 round2 先加總；feePercent null = 規則已刪 → 0）
    const fee = round2(active.reduce((s, r) => s + (r.feePercent != null ? round2((r.amount * r.feePercent) / 100) : 0), 0))
    return { total, fee, net: round2(total - fee) }
  }, [rows])

  // ★ 作廢行紅線灰字（同 cost-entry/page.tsx voidStyle）
  const voidStyle: CSSProperties = {
    color: '#9ca3af',
    textDecoration: 'line-through',
    textDecorationColor: '#dc2626',
    textDecorationThickness: '1.5px',
  }

  const openCreate = () => {
    setEditing(null)
    setForm({ incomeAt: todayHK(), category: 'OTHER', itemName: '', note: '', methodNorm: '', amount: '' })
    setModalOpen(true)
  }

  const openEdit = (row: MiscRow) => {
    setEditing(row)
    setForm({
      incomeAt: toHKDateStr(row.incomeAt),
      category: row.category,
      itemName: row.itemName,
      note: row.note ?? '',
      methodNorm: row.methodNorm,
      amount: String(row.amount),
    })
    setModalOpen(true)
  }

  const submit = async () => {
    if (!form.incomeAt || !form.itemName.trim() || !form.methodNorm || form.amount === '') {
      alert('日期、項目、付款方式、金額為必填')
      return
    }
    const amount = Number(form.amount)
    if (!isFinite(amount) || amount <= 0) {
      alert('金額必須大於 0')
      return
    }
    setSaving(true)
    const body = {
      clinicId: filterClinicId,
      incomeAt: form.incomeAt, // YYYY-MM-DD → server new Date() = UTC 午夜 = HK 當日
      category: form.category,
      itemName: form.itemName.trim(),
      note: form.note.trim() || null,
      methodNorm: form.methodNorm,
      amount,
    }
    try {
      if (editing) {
        await apiFetch(`/api/misc-income/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        await apiFetch('/api/misc-income', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      setModalOpen(false)
      setEditing(null)
      loadRows()
    } catch (e: any) {
      alert(`${editing ? '更新' : '新增'}失敗: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const doVoid = async () => {
    if (!voidTarget) return
    if (!window.confirm(`確定作廢「${voidTarget.itemName}」（$${voidTarget.amount.toFixed(2)}）？`)) {
      setVoidTarget(null)
      return
    }
    try {
      await apiFetch(`/api/misc-income/${voidTarget.id}`, { method: 'DELETE' })
      setVoidTarget(null)
      loadRows()
    } catch (e: any) {
      alert(`作廢失敗: ${e.message}`)
    }
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={24} /></div>
  }

  const selectedClinic = clinics.find(c => c.id === filterClinicId)

  return (
    <div className="p-6 space-y-4">
      {loadError && (
        <div className="text-red-500 text-sm p-2 bg-red-50 rounded">{loadError}</div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">雜項收入</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">唔經 Apricot 嘅店舖收入（全歸公司，唔參與醫生拆帳）</span>
          <a href="/cost-entry" className="text-sm text-blue-600 hover:underline">← 返回成本錄入</a>
        </div>
      </div>

      {!canEdit && (
        <Card className="p-3 bg-yellow-50 text-yellow-700 text-sm">
          ⚠️ 新增／編輯／作廢雜項收入需要 cost_entry 權限
        </Card>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={filterClinicId}
            onChange={e => setFilterClinicId(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm"
          >
            {clinics.map((c: any) => (
              <option key={c.id} value={c.id}>{c.name || c.shortName || c.id}</option>
            ))}
          </select>
          <input type="month" value={filterPeriodMonth} disabled={filterPeriodMonth === ''}
            onChange={e => setFilterPeriodMonth(e.target.value)}
            style={{ opacity: filterPeriodMonth === '' ? 0.4 : 1 }}
            className="border rounded px-2 py-1.5 text-sm" />
          <label className="flex items-center gap-1 text-sm cursor-pointer select-none whitespace-nowrap">
            <input type="checkbox" checked={filterPeriodMonth === ''}
              onChange={e => setFilterPeriodMonth(e.target.checked ? '' : todayHK().slice(0, 7))} />
            全部月份
          </label>
        </div>
        <div className="flex justify-end">
          {canEdit && (
            <button onClick={openCreate}
              className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 flex items-center gap-1">
              <Plus size={14} /> 新增雜項收入
            </button>
          )}
        </div>
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-2">日期</th>
              <th className="text-left p-2">類別</th>
              <th className="text-left p-2">項目</th>
              <th className="text-left p-2">備註</th>
              <th className="text-left p-2">付款方式</th>
              <th className="text-right p-2">金額</th>
              {canEdit && <th className="text-left p-2">操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} className="border-b hover:bg-gray-50" style={row.isVoid ? voidStyle : undefined}>
                <td className="p-2 whitespace-nowrap">{toHKDateStr(row.incomeAt)}</td>
                <td className="p-2">{CATEGORY_LABELS[row.category] || row.category}</td>
                <td className="p-2 font-medium">{row.itemName}</td>
                <td className="p-2 text-gray-500">{row.note || '—'}</td>
                <td className="p-2">{row.methodNorm}</td>
                <td className="p-2 text-right font-mono">${row.amount.toFixed(2)}</td>
                {canEdit && (
                  <td className="p-2">
                    <div className="flex gap-1">
                      {!row.isVoid && (
                        <>
                          <button onClick={() => openEdit(row)}
                            className="px-2 py-0.5 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50">
                            編輯
                          </button>
                          <button onClick={() => setVoidTarget(row)}
                            className="px-2 py-0.5 text-xs border border-red-300 text-red-700 rounded hover:bg-red-50">
                            作廢
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={canEdit ? 7 : 6} className="p-8 text-center text-gray-400">暫無雜項收入記錄</td></tr>
            )}
          </tbody>
        </table>

        {/* ★ 底部三行（同月報 Clinic 頁口徑，人手對數用）— 永遠排除 void */}
        <div className="border-t px-3 py-2 text-sm space-y-1">
          <div className="flex justify-between">
            <span>合計（{selectedClinic?.name || ''} · {filterPeriodMonth || '全部月份'} · 非 void {rows.filter(r => !r.isVoid).length} 筆）</span>
            <span className="font-mono">${totals.total.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-amber-700">
            <span>手續費（逐行按 PaymentMethodRule 費率）</span>
            <span className="font-mono">−${totals.fee.toFixed(2)}</span>
          </div>
          <div className="flex justify-between font-bold border-t pt-1">
            <span>淨額</span>
            <span className="font-mono">${totals.net.toFixed(2)}</span>
          </div>
        </div>
      </Card>

      {/* 新增 / 編輯 Modal（共用） */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">{editing ? '編輯雜項收入' : '新增雜項收入'}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">日期 *</label>
                <input type="date" value={form.incomeAt} onChange={e => setForm({ ...form, incomeAt: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-sm mb-1">類別 *</label>
                <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm">
                  {CATEGORY_OPTIONS.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">項目 *</label>
                <input value={form.itemName} onChange={e => setForm({ ...form, itemName: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="例如：售賣護理產品（最多 100 字）" maxLength={100} />
              </div>
              <div>
                <label className="block text-sm mb-1">備註（最多 200 字）</label>
                <input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" maxLength={200} />
              </div>
              <div>
                <label className="block text-sm mb-1">付款方式 *</label>
                <select value={form.methodNorm} onChange={e => setForm({ ...form, methodNorm: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm">
                  <option value="">選擇付款方式</option>
                  {methodOptions.map(o => (
                    <option key={o.norm} value={o.norm}>{o.display}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">金額 *</label>
                <input type="number" step="0.01" min="0.01" value={form.amount}
                  onChange={e => setForm({ ...form, amount: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="0.00" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setModalOpen(false); setEditing(null) }}
                className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={submit} disabled={saving}
                className="px-4 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50 flex items-center gap-1">
                {saving && <Loader2 size={14} className="animate-spin" />} 確定
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* 作廢 confirm */}
      {voidTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-2">作廢確認</h2>
            <p className="text-sm text-gray-600 mb-4">
              確定作廢「{voidTarget.itemName}」（${voidTarget.amount.toFixed(2)}）？作廢後唔入合計，可喺列表中見灰線行。
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setVoidTarget(null)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={doVoid}
                className="px-4 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700">
                確認作廢
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
