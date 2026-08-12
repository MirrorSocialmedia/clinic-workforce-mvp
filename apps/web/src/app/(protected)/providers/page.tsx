'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Plus, Edit2, EyeOff, Check, X, Wallet } from 'lucide-react'
import { hasPermission } from '@/lib/permissions'

interface Clinic { id: string; name: string; shortName?: string | null }

export default function ProvidersPage() {
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [showInactive, setShowInactive] = useState(false)

  // ★ Commission panel state
  const [commissionPanel, setCommissionPanel] = useState<string | null>(null)
  const [commissions, setCommissions] = useState<any[]>([])
  const [commissionForm, setCommissionForm] = useState({ percent: '', basis: 'NET', minGuarantee: '', effectiveFrom: '', effectiveTo: '', note: '', clinicId: '' })
  const [savingCommission, setSavingCommission] = useState(false)
  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const canPayout = userRole ? hasPermission(userRole, 'provider_payout', grant, deny) : false

  useEffect(() => { loadProviders(); loadClinics(); loadMe() }, [showInactive])

  async function loadMe() {
    try {
      const res = await apiFetch<any>('/api/me')
      setUserRole(res.user?.role || '')
      setGrant(res.user?.grant || [])
      setDeny(res.user?.deny || [])
    } catch {}
  }

  async function loadCommissions(providerId: string) {
    try {
      const res = await apiFetch<any>(`/api/provider-commissions?providerId=${providerId}`)
      setCommissions(res.commissions || [])
    } catch {}
  }

  async function saveCommission() {
    if (!commissionForm.percent || !commissionForm.effectiveFrom) {
      alert('比例和生效日期必填')
      return
    }
    setSavingCommission(true)
    try {
      await apiFetch<any>('/api/provider-commissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: commissionPanel,
          percent: parseFloat(commissionForm.percent),
          basis: commissionForm.basis,
          minGuarantee: commissionForm.minGuarantee ? parseFloat(commissionForm.minGuarantee) : undefined,
          effectiveFrom: commissionForm.effectiveFrom,
          effectiveTo: commissionForm.effectiveTo || undefined,
          note: commissionForm.note || undefined,
          clinicId: commissionForm.clinicId || undefined,
        }),
      })
      alert('拆帳設定已新增')
      setCommissionForm({ percent: '', basis: 'NET', minGuarantee: '', effectiveFrom: '', effectiveTo: '', note: '', clinicId: '' })
      if (commissionPanel) loadCommissions(commissionPanel)
    } catch (e: any) { alert(e?.message || '儲存失敗') }
    finally { setSavingCommission(false) }
  }

  async function loadProviders() {
    try {
      const res = await apiFetch<any>(`/api/providers${showInactive ? '?includeInactive=1' : ''}`)
      setProviders(res.providers || [])
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  async function loadClinics() {
    try {
      const res = await apiFetch<any>('/api/clinics')
      setClinics(res.clinics || [])
    } catch (e) { console.error(e) }
  }

  function startAdd() {
    setEditing('__new__')
    setForm({ name: '', shortName: '', phone: '', apricotId: '', color: '', isActive: true, sortOrder: 0, clinicIds: [] })
  }

  function startEdit(p: any) {
    setEditing(p.id)
    setForm({ ...p, clinicIds: p.clinicIds || [] })
  }

  function toggleClinic(cid: string) {
    const ids = form.clinicIds?.includes(cid)
      ? (form.clinicIds || []).filter((id: string) => id !== cid)
      : [...(form.clinicIds || []), cid]
    setForm({ ...form, clinicIds: ids })
  }

  async function save() {
    if (!form.name?.trim()) return alert('名稱必填')
    try {
      if (editing === '__new__') {
        const res = await apiFetch<any>('/api/providers', { method: 'POST', body: JSON.stringify(form) })
        setProviders(prev => [...prev, res.provider].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)))
      } else {
        const res = await apiFetch<any>(`/api/providers/${editing}`, { method: 'PUT', body: JSON.stringify(form) })
        setProviders(prev => prev.map(p => p.id === editing ? res.provider : p))
      }
      setEditing(null)
    } catch (e: any) { alert(e?.message || '儲存失敗') }
  }

  async function remove(id: string) {
    if (!confirm('確定停用呢位醫生？')) return
    try {
      await apiFetch<any>(`/api/providers/${id}`, { method: 'DELETE' })
      setProviders(prev => prev.filter(p => p.id !== id))
    } catch (e: any) {
      console.error('[providers] 停用失敗', e)
      alert(e?.message || '停用失敗')
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">醫生管理</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            顯示已停用
          </label>
          <Button onClick={startAdd} size="sm"><Plus className="w-4 h-4 mr-1" /> 新增醫生</Button>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-3">名稱</th>
              <th className="text-left p-3">簡稱</th>
              <th className="text-left p-3">電話</th>
              <th className="text-left p-3">Apricot ID</th>
              <th className="text-left p-3">顏色</th>
              <th className="text-left p-3">排序</th>
              <th className="text-left p-3">應診診所</th>
              <th className="text-left p-3">狀態</th>
              <th className="text-right p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {editing === '__new__' && (
              <tr className="bg-yellow-50 border-b">
                <td className="p-2"><Input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="陳大文醫生" /></td>
                <td className="p-2"><Input value={form.shortName || ''} onChange={e => setForm({ ...form, shortName: e.target.value })} placeholder="陳" /></td>
                <td className="p-2"><Input value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="電話" /></td>
                <td className="p-2"><Input value={form.apricotId || ''} onChange={e => setForm({ ...form, apricotId: e.target.value.trim() })} placeholder="Apricot 醫生 ID（可留空）" /></td>
                <td className="p-2"><Input type="color" value={form.color || '#888888'} onChange={e => setForm({ ...form, color: e.target.value })} /></td>
                <td className="p-2"><Input type="number" value={form.sortOrder ?? 0} onChange={e => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} className="w-20" /></td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    {clinics.map(c => (
                      <label key={c.id} className="flex items-center gap-0.5 text-xs cursor-pointer">
                        <input type="checkbox" checked={(form.clinicIds || []).includes(c.id)} onChange={() => toggleClinic(c.id)} />
                        {c.shortName || c.name}
                      </label>
                    ))}
                  </div>
                </td>
                <td className="p-2"><input type="checkbox" checked={form.isActive ?? true} onChange={e => setForm({ ...form, isActive: e.target.checked })} /></td>
                <td className="p-2 text-right">
                  <Button size="sm" onClick={save} className="mr-1"><Check className="w-4 h-4" /></Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}><X className="w-4 h-4" /></Button>
                </td>
              </tr>
            )}
            {providers.map(p => p.id === editing ? (
              <tr key={p.id} className="bg-yellow-50 border-b">
                <td className="p-2"><Input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="陳大文醫生" /></td>
                <td className="p-2"><Input value={form.shortName || ''} onChange={e => setForm({ ...form, shortName: e.target.value })} placeholder="陳" /></td>
                <td className="p-2"><Input value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="電話" /></td>
                <td className="p-2"><Input value={form.apricotId || ''} onChange={e => setForm({ ...form, apricotId: e.target.value.trim() })} placeholder="Apricot 醫生 ID（可留空）" /></td>
                <td className="p-2"><Input type="color" value={form.color || '#888888'} onChange={e => setForm({ ...form, color: e.target.value })} /></td>
                <td className="p-2"><Input type="number" value={form.sortOrder ?? 0} onChange={e => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} className="w-20" /></td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    {clinics.map(c => (
                      <label key={c.id} className="flex items-center gap-0.5 text-xs cursor-pointer">
                        <input type="checkbox" checked={(form.clinicIds || []).includes(c.id)} onChange={() => toggleClinic(c.id)} />
                        {c.shortName || c.name}
                      </label>
                    ))}
                  </div>
                </td>
                <td className="p-2"><input type="checkbox" checked={form.isActive ?? true} onChange={e => setForm({ ...form, isActive: e.target.checked })} /></td>
                <td className="p-2 text-right">
                  <Button size="sm" onClick={save} className="mr-1"><Check className="w-4 h-4" /></Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}><X className="w-4 h-4" /></Button>
                </td>
              </tr>
            ) : (
              <tr key={p.id} className="border-b hover:bg-muted/30">
                <td className="p-3 font-medium">{p.name}</td>
                <td className="p-3">{p.shortName || '—'}</td>
                <td className="p-3">{p.phone || '—'}</td>
                <td className="p-3">
                  {p.apricotId
                    ? <code className="text-xs">{p.apricotId}</code>
                    : <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">未綁定</span>}
                </td>
                <td className="p-3">
                  {p.color ? <span style={{ display: 'inline-block', width: 16, height: 16, borderRadius: 4, background: p.color, border: '1px solid #ccc' }} /> : '—'}
                </td>
                <td className="p-3">{p.sortOrder ?? 0}</td>
                <td className="p-3">
                  {(p.clinicIds || []).length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {(p.clinicIds || []).map((cid: string) => {
                        const clinic = clinics.find(c => c.id === cid)
                        return <span key={cid} className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">{clinic?.shortName || clinic?.name || cid}</span>
                      })}
                    </div>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </td>
                <td className="p-3">{p.isActive ? '✅ 活躍' : '⛔ 停用'}</td>
                <td className="p-3 text-right">
                  <Button size="sm" variant="ghost" onClick={() => startEdit(p)} className="mr-1"><Edit2 className="w-4 h-4" /></Button>
                  {canPayout && <Button size="sm" variant="ghost" onClick={() => { setCommissionPanel(p.id); loadCommissions(p.id) }} className="mr-1"><Wallet className="w-4 h-4" /></Button>}
                  {p.isActive && <Button size="sm" variant="ghost" onClick={() => remove(p.id)}><EyeOff className="w-4 h-4 text-red-500" /></Button>}
                </td>
              </tr>
            ))}
            {!loading && providers.length === 0 && (
              <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">暫時未新增醫生</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* ★ Commission Panel (slide-in) */}
      {canPayout && commissionPanel && (
        <Card className="mt-4 p-4" style={{ border: '2px solid #fbbf24' }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold">拆帳設定 — {providers.find(p => p.id === commissionPanel)?.name}</h3>
            <button onClick={() => setCommissionPanel(null)}><X className="w-4 h-4" /></button>
          </div>

          {/* History list */}
          <div className="mb-4">
            <div className="text-xs font-medium mb-2">歷史記錄（append-only，新 % 開新一條）</div>
            {commissions.length === 0 ? (
              <div className="text-xs text-muted-foreground">暫無拆帳設定</div>
            ) : (
              <div className="space-y-1">
                {commissions.map(c => (
                  <div key={c.id} className="text-xs p-2 rounded bg-muted/30">
                    <span className="font-medium">{c.percent}% {c.basis}</span>
                    {c.minGuarantee && <span className="text-muted-foreground ml-2">保底 ${c.minGuarantee}</span>}
                    <span className="text-muted-foreground ml-2">生效 {new Date(c.effectiveFrom).toISOString().slice(0, 10)}</span>
                    {c.effectiveTo && <span className="text-muted-foreground">– {new Date(c.effectiveTo).toISOString().slice(0, 10)}</span>}
                    {c.note && <span className="ml-2 text-amber-700">·{c.note}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add new */}
          <div className="border-t pt-3">
            <div className="text-xs font-medium mb-2">新增拆帳設定</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground">比例 (%)</label>
                <input type="number" step="0.01" value={commissionForm.percent} onChange={e => setCommissionForm({ ...commissionForm, percent: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-xs" placeholder="40" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">計費基準</label>
                <select value={commissionForm.basis} onChange={e => setCommissionForm({ ...commissionForm, basis: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-xs">
                  <option value="GROSS">總營業額 (GROSS)</option>
                  <option value="NET">淨收入 (NET)</option>
                  <option value="CONSULT_ONLY">診金 Only</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">保底 (可選)</label>
                <input type="number" step="0.01" value={commissionForm.minGuarantee} onChange={e => setCommissionForm({ ...commissionForm, minGuarantee: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-xs" placeholder="HK$" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">生效日期 *</label>
                <input type="date" value={commissionForm.effectiveFrom} onChange={e => setCommissionForm({ ...commissionForm, effectiveFrom: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">到期日（可選）</label>
                <input type="date" value={commissionForm.effectiveTo} onChange={e => setCommissionForm({ ...commissionForm, effectiveTo: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">備註</label>
                <input value={commissionForm.note} onChange={e => setCommissionForm({ ...commissionForm, note: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-xs" placeholder="可選" />
              </div>
            </div>
            <div className="flex justify-end mt-2">
              <button onClick={saveCommission} disabled={savingCommission}
                className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50">
                {savingCommission ? '儲存中...' : '新增'}
              </button>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
