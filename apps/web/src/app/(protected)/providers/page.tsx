'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Plus, Edit2, EyeOff, Check, X } from 'lucide-react'

interface Clinic { id: string; name: string; shortName?: string | null }

export default function ProvidersPage() {
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [showInactive, setShowInactive] = useState(false)

  useEffect(() => { loadProviders(); loadClinics() }, [showInactive])

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
    </div>
  )
}
