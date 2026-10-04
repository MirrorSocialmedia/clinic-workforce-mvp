'use client'

// ============================================================
// ★ cwm-chequetpl-20261004：出糧總表 · 模版設定（只限老闆；API RBAC = OWNER）
//   左：模版清單／新增；中：已揀欄（拖 ⋮⋮ 或 ↑↓ 調次序、改表頭）＋可加欄；右：分組、排列、表頭選項
//   只影響出糧總表 Excel —— 計糧、明細、PDF 全部唔郁
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-client'
import { BackButton } from '@/components/BackButton'
import { SHEET_COLS, SHEET_COL_MAP, NEW_TEMPLATE_DEFAULT, describeConfig, type SheetConfig } from '@/lib/cheque-sheet/config'
import { excludeHint } from '@/lib/cheque-sheet/exclude-hint'
import { toHKDateStr } from '@/lib/hk-date'

interface Tpl { id: string; name: string; config: SheetConfig }

const clone = (c: SheetConfig): SheetConfig => ({ ...c, columns: c.columns.map(x => ({ ...x })) })

export default function ChequeSheetTemplatesPage() {
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null) // null = 未揀／新增中
  const [name, setName] = useState('')
  const [cfg, setCfg] = useState<SheetConfig>(clone(NEW_TEMPLATE_DEFAULT))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  const load = useCallback(async (pick?: string) => {
    try {
      const d: any = await apiFetch('/api/cheque-sheet-templates')
      const list: Tpl[] = d.templates || []
      setTemplates(list)
      const t = list.find(x => x.id === pick) ?? list[0]
      if (t) { setSelId(t.id); setName(t.name); setCfg(clone(t.config)) }
      else { setSelId(null); setName('支票表'); setCfg(clone(NEW_TEMPLATE_DEFAULT)) }
    } catch (e: any) { setLoadError(e?.message || '載入失敗') }
  }, [])
  useEffect(() => { load() }, [load])

  const pickTpl = (t: Tpl) => { setSelId(t.id); setName(t.name); setCfg(clone(t.config)); setMsg(null) }
  const newTpl = () => { setSelId(null); setName(''); setCfg(clone(NEW_TEMPLATE_DEFAULT)); setMsg(null) }

  const chosenKeys = useMemo(() => new Set(cfg.columns.map(c => c.key)), [cfg.columns])
  const setCols = (columns: SheetConfig['columns']) => setCfg(c => ({ ...c, columns }))
  const move = (from: number, to: number) => {
    if (to < 0 || to >= cfg.columns.length || from === to) return
    const next = [...cfg.columns]
    const [x] = next.splice(from, 1)
    next.splice(to, 0, x)
    setCols(next)
  }
  const toggleCol = (key: string, on: boolean) => {
    if (on) setCols([...cfg.columns, { key, header: SHEET_COL_MAP.get(key)!.header }])
    else setCols(cfg.columns.filter(c => c.key !== key))
  }

  const save = async () => {
    if (!name.trim()) { setMsg('請填模版名稱'); return }
    if (!cfg.columns.length) { setMsg('最少要揀一欄'); return }
    setSaving(true); setMsg(null)
    try {
      const body = JSON.stringify({ name, config: cfg })
      const headers = { 'Content-Type': 'application/json' }
      if (selId) {
        await apiFetch(`/api/cheque-sheet-templates/${selId}`, { method: 'PUT', headers, body })
        await load(selId)
      } else {
        const d: any = await apiFetch('/api/cheque-sheet-templates', { method: 'POST', headers, body })
        await load(d.id)
      }
      setMsg('已儲存 ✓')
    } catch (e: any) { setMsg(e?.message || '儲存失敗') } finally { setSaving(false) }
  }
  const remove = async () => {
    if (!selId || !confirm(`刪除模版「${name}」？`)) return
    try { await apiFetch(`/api/cheque-sheet-templates/${selId}`, { method: 'DELETE' }); await load() } catch (e: any) { alert(e?.message || '刪除失敗') }
  }

  const radio = (label: string, checked: boolean, onChange: () => void, disabled = false) => (
    <label className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-50' : ''}`}><input type="radio" checked={checked} onChange={onChange} disabled={disabled} />{label}</label>
  )
  const check = (label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <label className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-50' : ''}`}><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled} />{label}</label>
  )
  const grouped = cfg.groupBy !== 'NONE'

  return (
    <div className="p-6" style={{ maxWidth: 1400 }}>
      <BackButton to="/payroll" label="返回計糧" />
      <div className="flex items-end justify-between flex-wrap gap-2 mb-4">
        <div>
          <h1 className="text-2xl font-bold">出糧總表 · 模版設定</h1>
          <p className="text-sm text-muted-foreground mt-1">只影響匯出嘅 Excel，計糧、明細、PDF 全部唔郁</p>
        </div>
        <Link href="/payroll/cheque-sheet/payers" className="text-sm text-brand underline">出糧診所同次序 →</Link>
      </div>
      {loadError && <div className="text-sm text-red-600 mb-3">{loadError}</div>}

      <div className="flex flex-wrap gap-4 items-start">
        {/* 模版清單 */}
        <div className="w-full md:w-56 flex flex-col gap-2">
          <div className="text-xs font-semibold text-muted-foreground px-1">模版</div>
          {templates.map(t => (
            <button key={t.id} type="button" onClick={() => pickTpl(t)}
              className={`text-left p-3 rounded-lg border text-sm ${t.id === selId ? 'border-brand bg-teal-50 font-semibold' : 'bg-white'}`}>
              {t.name}
              <div className="text-xs font-normal text-muted-foreground mt-0.5">{describeConfig(t.config)}</div>
            </button>
          ))}
          <button type="button" onClick={newTpl} className={`p-3 rounded-lg border border-dashed text-sm text-brand ${selId === null ? 'bg-teal-50' : ''}`}>＋ 新增模版</button>
        </div>

        {/* 欄位 */}
        <div className="flex-1 min-w-[320px] flex flex-col gap-3">
          <label className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">模版名稱</span>
            <input value={name} onChange={e => setName(e.target.value)} maxLength={30} placeholder="例：支票表"
              className="border rounded-md px-3 py-2 text-sm w-56" />
          </label>
          <div className="flex justify-between items-baseline">
            <div className="font-semibold text-sm">匯出欄位（拖 ⋮⋮ 或 ↑↓ 調次序，可以改表頭字）</div>
            <div className="text-xs text-muted-foreground">已揀 {cfg.columns.length} / {SHEET_COLS.length}</div>
          </div>
          <div className="grid gap-4 2xl:grid-cols-2">
            <div className="border rounded-lg overflow-hidden bg-white">
              <div className="grid grid-cols-[24px_minmax(120px,1fr)_minmax(130px,1fr)_72px] gap-2 px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-600">
                <span></span><span>欄（Excel 次序）</span><span>表頭顯示做</span><span></span>
              </div>
              {cfg.columns.map((c, i) => (
                <div key={c.key} draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => { if (dragIdx !== null) move(dragIdx, i); setDragIdx(null) }}
                  className={`grid grid-cols-[24px_minmax(120px,1fr)_minmax(130px,1fr)_72px] gap-2 items-center px-3 py-1.5 border-t text-sm ${dragIdx === i ? 'bg-teal-50' : ''}`}>
                  <span className="cursor-grab text-slate-400 select-none" aria-hidden>⋮⋮</span>
                  <span>{SHEET_COL_MAP.get(c.key)?.label ?? c.key}</span>
                  <input value={c.header} maxLength={40} aria-label={`${SHEET_COL_MAP.get(c.key)?.label} 表頭`}
                    onChange={e => setCols(cfg.columns.map((x, j) => (j === i ? { ...x, header: e.target.value } : x)))}
                    className="border rounded px-2 py-1 text-xs font-mono" />
                  <span className="flex gap-1 justify-end">
                    <button type="button" aria-label="上移" onClick={() => move(i, i - 1)} className="px-1 text-slate-500 disabled:opacity-30" disabled={i === 0}>↑</button>
                    <button type="button" aria-label="下移" onClick={() => move(i, i + 1)} className="px-1 text-slate-500 disabled:opacity-30" disabled={i === cfg.columns.length - 1}>↓</button>
                    <button type="button" aria-label="移除" onClick={() => toggleCol(c.key, false)} className="px-1 text-red-500">×</button>
                  </span>
                </div>
              ))}
            </div>
            <div className="border rounded-lg overflow-hidden bg-white self-start">
              <div className="px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-600">可加嘅欄（剔就加去左邊最尾）</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 p-3">
                {SHEET_COLS.filter(c => !chosenKeys.has(c.key)).map(c => (
                  <label key={c.key} className="flex items-center gap-2 text-sm py-0.5">
                    <input type="checkbox" checked={false} onChange={() => toggleCol(c.key, true)} />{c.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 選項 */}
        <div className="w-full md:w-72 flex flex-col gap-5 bg-white border rounded-lg p-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="font-semibold text-sm mb-1">分組</legend>
            {radio('按【出糧診所】（公司 · 診所）', cfg.groupBy === 'CLINIC', () => setCfg(c => ({ ...c, groupBy: 'CLINIC' })))}
            {radio('按【出糧公司】', cfg.groupBy === 'COMPANY', () => setCfg(c => ({ ...c, groupBy: 'COMPANY' })))}
            {radio('唔分組', cfg.groupBy === 'NONE', () => setCfg(c => ({ ...c, groupBy: 'NONE' })))}
            {check('每組加小計', cfg.subtotals, v => setCfg(c => ({ ...c, subtotals: v })), !grouped)}
            {check('每組另開一張工作表（Sheet）', cfg.sheetPerGroup, v => setCfg(c => ({ ...c, sheetPerGroup: v })), !grouped)}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="font-semibold text-sm mb-1">組內員工排列</legend>
            {radio('暱稱 A → Z', cfg.sort === 'NICK', () => setCfg(c => ({ ...c, sort: 'NICK' })))}
            {radio('全名 A → Z', cfg.sort === 'FULL', () => setCfg(c => ({ ...c, sort: 'FULL' })))}
            {radio('自訂次序（喺「出糧診所」頁拖）', cfg.sort === 'CUSTOM', () => setCfg(c => ({ ...c, sort: 'CUSTOM' })))}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="font-semibold text-sm mb-1">表頭</legend>
            {check('第一行月份（例：SEP）', cfg.monthRow, v => setCfg(c => ({ ...c, monthRow: v })))}
            {check('最尾合計', cfg.totalRow, v => setCfg(c => ({ ...c, totalRow: v })))}
          </fieldset>
          {msg && <div className={`text-sm ${msg.includes('✓') ? 'text-green-700' : 'text-red-600'}`}>{msg}</div>}
          <div className="flex gap-2 justify-end flex-wrap">
            {selId && <button type="button" onClick={remove} className="h-10 px-3 rounded-md border text-sm text-red-600">刪除</button>}
            <button type="button" onClick={save} disabled={saving} className="h-10 px-4 rounded-md bg-brand text-white text-sm font-semibold disabled:opacity-60">
              {saving ? '儲存中…' : selId ? '儲存模版' : '新增模版'}
            </button>
          </div>
        </div>
      </div>

      {/* ★ cwm-chequeexcl-20261004：每個模版各自揀唔匯出嘅員工（系統唔自動剔，只提示試用期） */}
      <ExcludeEmployees
        excluded={cfg.excludedEmployeeIds}
        onChange={ids => setCfg(c => ({ ...c, excludedEmployeeIds: ids }))}
      />
    </div>
  )
}

interface ExEmp { id: string; name: string; resigned: boolean; joinDate: string | null; homeClinicId: string | null; payerClinicId: string | null }

/** 匯出邊啲員工：按出糧診所分組；剔走 = 呢個模版唔出（新員工預設照出） */
function ExcludeEmployees({ excluded, onChange }: { excluded: string[]; onChange: (ids: string[]) => void }) {
  const [emps, setEmps] = useState<ExEmp[]>([])
  const [clinics, setClinics] = useState<{ id: string; title: string }[]>([])
  useEffect(() => {
    apiFetch<any>('/api/cheque-sheet-payers')
      .then(d => { setEmps(d.employees || []); setClinics(d.clinics || []) })
      .catch(() => setEmps([]))
  }, [])
  const ex = useMemo(() => new Set(excluded), [excluded])
  const groups = useMemo(() => {
    const titleOf = (id: string | null) => clinics.find(c => c.id === id)?.title ?? '（冇所屬診所）'
    const m = new Map<string, ExEmp[]>()
    for (const e of emps) { const t = titleOf(e.payerClinicId ?? e.homeClinicId); m.set(t, [...(m.get(t) ?? []), e]) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-HK'))
      .map(([title, list]) => ({ title, list: list.sort((a, b) => a.name.localeCompare(b.name, 'en')) }))
  }, [emps, clinics])
  const toggle = (id: string, on: boolean) => onChange(on ? excluded.filter(x => x !== id) : [...excluded, id])
  const offCount = emps.filter(e => ex.has(e.id)).length

  return (
    <div className="mt-6 bg-white border rounded-lg">
      <div className="px-4 py-3 border-b flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div className="font-semibold">匯出邊啲員工</div>
        <div className="text-xs text-muted-foreground">每個模版各自揀；剔走嘅人呢個模版唔出，其他模版照出。系統唔會自動剔，只會提示。</div>
        <div className="flex-1" />
        <div className="text-sm text-muted-foreground">匯出 {emps.length - offCount} 人 · 唔匯出 {offCount} 人</div>
      </div>
      <div className="px-4 py-2 flex flex-wrap gap-4 text-xs text-muted-foreground border-b">
        <span><span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300">試用期中（3 個月）</span> 入職未滿 3 個月</span>
        <span><span className="px-2 py-0.5 rounded-full bg-red-50 text-red-800 border border-red-300">已過試用期</span> 但仲剔走緊，記得剔返</span>
      </div>
      <div className="p-4 grid gap-4 lg:grid-cols-2">
        {groups.map(g => (
          <div key={g.title} className="border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 text-sm font-semibold flex justify-between">
              <span>{g.title}</span>
              <span className="font-normal text-xs text-muted-foreground">匯出 {g.list.filter(e => !ex.has(e.id)).length} / {g.list.length}</span>
            </div>
            {g.list.map(e => {
              const on = !ex.has(e.id)
              const h = excludeHint(e.joinDate, !on)
              return (
                <label key={e.id} className={`flex items-center gap-3 px-3 py-2 border-t text-sm cursor-pointer ${on ? '' : 'bg-slate-50'}`}>
                  <input type="checkbox" checked={on} onChange={ev => toggle(e.id, ev.target.checked)} className="w-4 h-4" aria-label={`匯出 ${e.name}`} />
                  <span className={`w-28 ${on ? '' : 'text-slate-500 line-through'}`}>{e.name}{e.resigned && <span className="ml-1 text-xs text-muted-foreground no-underline">（已離職）</span>}</span>
                  <span className="text-xs text-slate-500 w-32 whitespace-nowrap">{e.joinDate ? `入職 ${toHKDateStr(e.joinDate)}` : ''}</span>
                  {h?.kind === 'PROBATION' && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300">
                      試用期中（3 個月，至 {h.lastDay}）{h.dayNo > 0 ? ` · 入職第 ${h.dayNo} 日` : ' · 未入職'}
                    </span>
                  )}
                  {h?.kind === 'PASSED_EXCLUDED' && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-800 border border-red-300">已過試用期（{h.lastDay}），仲係唔匯出</span>
                  )}
                </label>
              )
            })}
          </div>
        ))}
      </div>
      <div className="px-4 pb-3 text-xs text-muted-foreground">改完記得撳上面「儲存模版」。</div>
    </div>
  )
}
