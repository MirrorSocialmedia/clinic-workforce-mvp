'use client'

// ★ cwm-chequetpl-20261004：出糧總表匯出（老闆版）—— 揀月份＋模版；記住上次用嘅模版（per-viewer localStorage）
//   非老闆照用計糧頁原本嘅月份 select（舊格式）
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

const LS_KEY = 'cwm.chequeSheet.template'

export function ChequeSheetExport({ months }: { months: string[] }) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState('')
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([])
  const [tpl, setTpl] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { if (!month && months.length) setMonth(months[0]) }, [months, month])
  useEffect(() => {
    if (!open) return
    fetch('/api/cheque-sheet-templates', { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { templates: [] }))
      .then(d => {
        const list = (d.templates || []).map((t: any) => ({ id: t.id, name: t.name }))
        setTemplates(list)
        let saved = ''
        try { saved = localStorage.getItem(LS_KEY) ?? '' } catch { /* private mode */ }
        setTpl(list.some((t: any) => t.id === saved) ? saved : '')
      })
      .catch(() => setTemplates([]))
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const exportNow = () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return
    try { localStorage.setItem(LS_KEY, tpl) } catch { /* private mode */ }
    window.open(`/api/payroll-runs/cheque-sheet?month=${month}${tpl ? `&template=${encodeURIComponent(tpl)}` : ''}`, '_blank')
    setOpen(false)
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        className="px-3 py-2 rounded-md border bg-white hover:bg-slate-50 text-sm font-semibold">
        💰 出糧總表 ▾
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 rounded-lg border bg-white shadow-lg p-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">月份</span>
            <select value={month} onChange={e => setMonth(e.target.value)} className="border rounded-md px-2 py-2 text-sm">
              {months.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">模版</span>
            <select value={tpl} onChange={e => setTpl(e.target.value)} className="border rounded-md px-2 py-2 text-sm">
              <option value="">標準格式（原本）</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={exportNow} disabled={!month}
            className="h-10 rounded-md bg-brand text-white text-sm font-semibold disabled:opacity-50">匯出 Excel</button>
          <div className="flex gap-4 border-t pt-2 text-sm">
            <Link href="/payroll/cheque-sheet/templates" className="text-brand underline">⚙ 模版設定</Link>
            <Link href="/payroll/cheque-sheet/payers" className="text-brand underline">出糧診所同次序</Link>
          </div>
        </div>
      )}
    </div>
  )
}
