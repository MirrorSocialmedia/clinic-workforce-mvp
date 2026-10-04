'use client'

// ============================================================
// ★ cwm-chequetpl-20261004：出糧總表 · 出糧診所同次序（只限老闆；API RBAC = OWNER）
//   預設 = 員工所屬診所；改咗只決定佢喺出糧總表出現喺邊組（例：匯樂元朗嘅人喺臻善大圍出糧）。
//   組內拖 ⋮⋮ 或 ↑↓ 調次序（模版揀「自訂次序」先用）。計糧、排更、考勤全部唔郁。
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-client'
import { BackButton } from '@/components/BackButton'

interface Emp { id: string; name: string; resigned: boolean; lastDay?: string | null; homeClinicId: string | null; homeTitle: string; payerClinicId: string | null; sortOrder: number | null }
interface ClinicOpt { id: string; title: string }

export default function ChequeSheetPayersPage() {
  const [emps, setEmps] = useState<Emp[]>([])
  const [clinics, setClinics] = useState<ClinicOpt[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ group: string; idx: number } | null>(null)

  const load = useCallback(async () => {
    try {
      const d: any = await apiFetch('/api/cheque-sheet-payers')
      setEmps(d.employees || []); setClinics(d.clinics || []); setDirty(false)
    } catch (e: any) { setLoadError(e?.message || '載入失敗') }
  }, [])
  useEffect(() => { load() }, [load])

  const titleOf = useCallback((id: string | null) => clinics.find(c => c.id === id)?.title ?? '（冇所屬診所）', [clinics])
  const effective = (e: Emp) => e.payerClinicId ?? e.homeClinicId ?? ''

  // 按出糧診所分組；組內：有次序排前，其餘按名
  const groups = useMemo(() => {
    const m = new Map<string, Emp[]>()
    for (const e of emps) { const k = effective(e); m.set(k, [...(m.get(k) ?? []), e]) }
    return [...m.entries()]
      .map(([k, list]) => ({
        key: k, title: titleOf(k || null),
        list: list.sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9) || a.name.localeCompare(b.name, 'en')),
      }))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-HK'))
  }, [emps, titleOf])

  const setPayer = (id: string, clinicId: string) => {
    setEmps(prev => prev.map(e => (e.id === id ? { ...e, payerClinicId: clinicId === e.homeClinicId ? null : clinicId, sortOrder: null } : e)))
    setDirty(true)
  }
  const reorder = (groupKey: string, from: number, to: number) => {
    const g = groups.find(x => x.key === groupKey)
    if (!g || to < 0 || to >= g.list.length || from === to) return
    const list = [...g.list]
    const [x] = list.splice(from, 1)
    list.splice(to, 0, x)
    const order = new Map(list.map((e, i) => [e.id, i]))
    setEmps(prev => prev.map(e => (order.has(e.id) ? { ...e, sortOrder: order.get(e.id)! } : e)))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      const items = emps.map(e => ({ employeeId: e.id, payerClinicId: e.payerClinicId, sortOrder: e.sortOrder }))
      await apiFetch('/api/cheque-sheet-payers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
      setMsg('已儲存 ✓'); await load()
    } catch (e: any) { setMsg(e?.message || '儲存失敗') } finally { setSaving(false) }
  }

  return (
    <div className="p-6" style={{ maxWidth: 960 }}>
      <BackButton to="/payroll" label="返回計糧" />
      <div className="flex items-end justify-between flex-wrap gap-2 mb-2">
        <h1 className="text-2xl font-bold">出糧總表 · 出糧診所同次序</h1>
        <Link href="/payroll/cheque-sheet/templates" className="text-sm text-brand underline">模版設定 →</Link>
      </div>
      <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
        預設 = 員工所屬診所。改咗只係決定佢喺出糧總表出現喺邊一組，計糧、排更、考勤全部照舊。
        組內拖 ⋮⋮ 或 ↑↓ 調次序（模版揀「自訂次序」先用）。
      </p>
      {loadError && <div className="text-sm text-red-600 mb-3">{loadError}</div>}

      <div className="flex flex-col gap-4">
        {groups.map(g => (
          <div key={g.key} className="border rounded-lg overflow-hidden bg-white">
            <div className="flex justify-between px-4 py-2 bg-slate-50 text-sm font-semibold">
              <span>{g.title}</span>
              <span className="font-normal text-muted-foreground text-xs">
                {g.list.length} 人{g.list.some(e => e.payerClinicId) ? `（${g.list.filter(e => e.payerClinicId).length} 人由其他診所調入）` : ''}
              </span>
            </div>
            <div className="hidden sm:grid grid-cols-[28px_1fr_1fr_240px_52px] gap-3 px-4 py-1.5 text-xs text-muted-foreground border-t">
              <span></span><span>員工</span><span>所屬診所</span><span>出糧診所</span><span></span>
            </div>
            {g.list.map((e, i) => (
              <div key={e.id} draggable
                onDragStart={() => setDrag({ group: g.key, idx: i })}
                onDragOver={ev => ev.preventDefault()}
                onDrop={() => { if (drag && drag.group === g.key) reorder(g.key, drag.idx, i); setDrag(null) }}
                className={`grid grid-cols-[28px_1fr_52px] sm:grid-cols-[28px_1fr_1fr_240px_52px] gap-3 items-center px-4 py-1.5 border-t text-sm ${e.payerClinicId ? 'bg-amber-50' : ''}`}>
                <span className="cursor-grab text-slate-400 select-none" aria-hidden>⋮⋮</span>
                <span>{e.name}{e.resigned && <span className="ml-1 text-xs text-muted-foreground">（已離職{e.lastDay ? `，最後一日 ${e.lastDay}` : ''}）</span>}</span>
                <span className="hidden sm:block text-slate-600">{e.homeTitle}</span>
                <span className="col-span-3 sm:col-span-1 flex items-center gap-2 order-last sm:order-none">
                  <select value={effective(e)} onChange={ev => setPayer(e.id, ev.target.value)} aria-label={`${e.name} 出糧診所`}
                    className={`flex-1 border rounded px-2 py-1 text-sm bg-white ${e.payerClinicId ? 'border-amber-500' : ''}`}>
                    {clinics.map(c => <option key={c.id} value={c.id}>{c.title}{c.id === e.homeClinicId ? '（所屬）' : ''}</option>)}
                  </select>
                  {e.payerClinicId && <span className="text-xs font-semibold text-amber-700">已改</span>}
                </span>
                <span className="flex gap-1 justify-end">
                  <button type="button" aria-label="上移" onClick={() => reorder(g.key, i, i - 1)} disabled={i === 0} className="px-1 text-slate-500 disabled:opacity-30">↑</button>
                  <button type="button" aria-label="下移" onClick={() => reorder(g.key, i, i + 1)} disabled={i === g.list.length - 1} className="px-1 text-slate-500 disabled:opacity-30">↓</button>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 mt-4 py-3 bg-background flex items-center justify-end gap-3">
        {msg && <span className={`text-sm ${msg.includes('✓') ? 'text-green-700' : 'text-red-600'}`}>{msg}</span>}
        <button type="button" onClick={load} disabled={!dirty || saving} className="h-10 px-4 rounded-md border text-sm disabled:opacity-50">還原</button>
        <button type="button" onClick={save} disabled={!dirty || saving} className="h-10 px-5 rounded-md bg-brand text-white text-sm font-semibold disabled:opacity-50">
          {saving ? '儲存中…' : '儲存'}
        </button>
      </div>
    </div>
  )
}
