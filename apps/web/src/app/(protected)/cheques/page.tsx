'use client'

// ============================================================
// ★ cwm-chequeprint-20261005：支票打印中心（只限老闆；API RBAC = OWNER）
//   揀月份＋出票戶口 → 員工／醫生／Lab 三個分頁 → 揀 → 逐張打印（每張確認「印得好」或者「作廢重印」）
//   打印：Chrome WebUSB 直送南天 PR2 Plus（冇 agent）
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-client'
import { ChequePreview } from '@/components/cheques/ChequePreview'
import { PrinterBadge, usePrinter } from '@/components/cheques/usePrinter'
import { layoutItems, type LayoutFields, type PrinterMode, type ChequeContent } from '@/lib/cheque-print/layout'
import { buildContent, hasNonAscii } from '@/lib/cheque-print/content'
import { encodeForPrinter, rasterWidthMm } from '@/lib/cheque-print/webusb'
import { todayHK } from '@/lib/hk-date'

type Tab = 'employees' | 'providers' | 'labs'
interface Row {
  sourceType: string; sourceId: string; clinicId: string | null; clinicName: string; payee: string | null
  label: string; detail: string; amount: number; blocker: string | null
  cheque: { id: string; chequeNo: string; status: string; confirmed: boolean; chequeDate: string } | null
  lab?: { labId: string; statementRef: string | null; note: string | null; systemCost: number }
}
interface Issued { id: string; chequeNo: string; sourceType: string; payeeName: string; amount: number; chequeDate: string; status: string; confirmed: boolean; voidReason: string | null }
interface Layout { id: string; name: string; fields: LayoutFields; offsetXmm: number; offsetYmm: number; printerMode: PrinterMode }
interface Center {
  account: { id: string; label: string; accountLast4: string | null; nextNoText: string | null; remaining: number | null }
  layout: Layout; employees: Row[]; providers: Row[]; labs: Row[]; issued: Issued[]
}
interface AccountOpt { id: string; label: string; accountLast4: string | null; nextNoText: string | null; isActive: boolean }

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rowKey = (r: Row) => `${r.sourceType}:${r.sourceId}`

function monthOptions(): string[] {
  const t = todayHK()
  let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7))
  const out: string[] = []
  for (let i = 0; i < 7; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m--; if (m === 0) { m = 12; y-- }
  }
  return out
}

/** 未出票、冇阻擋 → 驗證塞唔塞得落版面 */
function checkFits(r: Row, layout: Layout, date: string): string | null {
  if (!r.payee) return '未有抬頭'
  const res = buildContent({ payee: r.payee, amount: r.amount, date }, layout.fields, layout.printerMode)
  if (!res.ok) return res.error
  if (hasNonAscii(res.content.payee) && rasterWidthMm(res.content.payee) > layout.fields.payee.width) return '中文抬頭太長'
  return null
}

export default function ChequeCenterPage() {
  const printer = usePrinter()
  const months = useMemo(monthOptions, [])
  const [month, setMonth] = useState(months[1])
  const [accounts, setAccounts] = useState<AccountOpt[]>([])
  const [accountId, setAccountId] = useState('')
  const [chequeDate, setChequeDate] = useState(todayHK())
  const [data, setData] = useState<Center | null>(null)
  const [tab, setTab] = useState<Tab>('employees')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [err, setErr] = useState<string | null>(null)
  const [session, setSession] = useState<Row[] | null>(null)

  const loadAccounts = useCallback(async () => {
    try {
      const d: any = await apiFetch('/api/cheques/settings')
      const list: AccountOpt[] = (d.accounts || []).filter((a: AccountOpt) => a.isActive)
      setAccounts(list)
      setAccountId(prev => (list.some(a => a.id === prev) ? prev : list[0]?.id ?? ''))
    } catch (e: any) { setErr(e?.message || '載入失敗') }
  }, [])
  useEffect(() => { loadAccounts() }, [loadAccounts])

  const load = useCallback(async () => {
    if (!accountId) return
    setErr(null)
    try {
      const d = await apiFetch<Center>(`/api/cheques/center?month=${month}&accountId=${accountId}`)
      setData(d)
      // 預設揀晒可以出票嘅
      const all = [...d.employees, ...d.providers, ...d.labs]
      setPicked(new Set(all.filter(r => !r.blocker && !r.cheque).map(rowKey)))
    } catch (e: any) { setErr(e?.message || '載入失敗'); setData(null) }
  }, [month, accountId])
  useEffect(() => { load() }, [load])

  const rows = data?.[tab] ?? []
  const fitErr = useMemo(() => {
    const m = new Map<string, string | null>()
    if (!data) return m
    for (const r of [...data.employees, ...data.providers, ...data.labs]) {
      if (!r.blocker && !r.cheque) m.set(rowKey(r), checkFits(r, data.layout, chequeDate))
    }
    return m
  }, [data, chequeDate])
  const issuable = (r: Row) => !r.blocker && !r.cheque && !fitErr.get(rowKey(r))
  const selected = useMemo(() => {
    if (!data) return []
    return [...data.employees, ...data.providers, ...data.labs].filter(r => picked.has(rowKey(r)) && issuable(r))
  }, [data, picked, fitErr]) // eslint-disable-line react-hooks/exhaustive-deps -- issuable 只靠 fitErr
  const total = selected.reduce((s, r) => s + r.amount, 0)
  const toggle = (r: Row) => setPicked(p => { const n = new Set(p); n.has(rowKey(r)) ? n.delete(rowKey(r)) : n.add(rowKey(r)); return n })
  const tabRowsIssuable = rows.filter(issuable)
  const allOn = tabRowsIssuable.length > 0 && tabRowsIssuable.every(r => picked.has(rowKey(r)))
  const toggleAll = () => setPicked(p => {
    const n = new Set(p)
    tabRowsIssuable.forEach(r => (allOn ? n.delete(rowKey(r)) : n.add(rowKey(r))))
    return n
  })

  const voidCheque = async (c: Issued) => {
    const reason = window.prompt(`作廢支票 #${c.chequeNo}（${c.payeeName} HK$${money(c.amount)}）\n原因：`, '印壞')
    if (!reason) return
    try {
      await apiFetch(`/api/cheques/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'void', reason }) })
      await load(); await loadAccounts()
    } catch (e: any) { setErr(e?.message || '作廢失敗') }
  }

  const tabs: Array<[Tab, string]> = [['employees', '員工'], ['providers', '醫生'], ['labs', 'Lab']]

  return (
    <div className="p-6" style={{ maxWidth: 1280 }}>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">支票打印中心</h1>
          <div className="text-sm text-muted-foreground">只限老闆 · <Link href="/cheques/settings" className="underline">支票設定</Link> · <Link href="/cheques/printer" className="underline">打印機同校準</Link></div>
        </div>
        <PrinterBadge state={printer.state} onConnect={() => { printer.connect().catch(e => setErr(e?.message || '連接失敗')) }} />
      </div>

      {accounts.length === 0 && !err && (
        <div className="border rounded-lg bg-amber-50 border-amber-300 p-4 text-sm mb-4">未有出票戶口。請先去 <Link href="/cheques/settings" className="underline font-semibold">支票設定</Link> 開戶口、填支票簿號碼、揀診所。</div>
      )}

      <div className="flex flex-wrap gap-4 items-end mb-4">
        <label className="flex flex-col gap-1 text-xs text-slate-600">月份
          <select value={month} onChange={e => setMonth(e.target.value)} className="border rounded px-2 py-2 bg-white text-sm w-36">
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">出票戶口（支票簿）
          <select value={accountId} onChange={e => setAccountId(e.target.value)} className="border rounded px-2 py-2 bg-white text-sm w-80">
            {accounts.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountLast4 ? ` · ****${a.accountLast4}` : ''}{a.nextNoText ? `（下一張 ${a.nextNoText}）` : ''}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">支票日期
          <input type="date" value={chequeDate} onChange={e => e.target.value && setChequeDate(e.target.value)} className="border rounded px-2 py-1.5 bg-white text-sm" />
        </label>
        <div className="flex border rounded-md overflow-hidden bg-white" role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`px-4 py-2 text-sm border-l first:border-l-0 ${tab === k ? 'bg-brand text-white' : ''}`}>
              {label} {data ? data[k].length : ''}
            </button>
          ))}
        </div>
      </div>
      {err && <div className="text-sm text-red-600 mb-3" role="alert">{err}</div>}

      {data && (
        <div className="border rounded-lg bg-white overflow-hidden mb-4">
          <div className="hidden md:grid grid-cols-[40px_1.4fr_1.6fr_1fr_0.9fr_1.4fr] gap-3 px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-600 items-center">
            <input type="checkbox" checked={allOn} onChange={toggleAll} aria-label="全選" disabled={tabRowsIssuable.length === 0} />
            <span>收款人（支票抬頭）</span><span>來源</span><span className="text-right">金額</span><span>支票</span><span></span>
          </div>
          {rows.length === 0 && <div className="px-4 py-6 text-sm text-muted-foreground">呢個戶口 {month} 冇要出嘅{tabs.find(t => t[0] === tab)?.[1]}票</div>}
          {rows.map(r => tab === 'labs'
            ? <LabRow key={rowKey(r)} r={r} month={month} on={picked.has(rowKey(r))} canPick={issuable(r)} fitErr={fitErr.get(rowKey(r)) ?? null} onToggle={() => toggle(r)} onSaved={load} />
            : (
              <div key={rowKey(r)} className={`grid grid-cols-[40px_1fr] md:grid-cols-[40px_1.4fr_1.6fr_1fr_0.9fr_1.4fr] gap-x-3 gap-y-1 px-4 py-2.5 border-t text-sm items-center ${issuable(r) ? '' : 'bg-slate-50'}`}>
                <input type="checkbox" checked={picked.has(rowKey(r)) && issuable(r)} disabled={!issuable(r)} onChange={() => toggle(r)} aria-label={`揀 ${r.label}`} />
                <span><b className="font-medium">{r.payee ?? '—'}</b><br /><span className="text-xs text-slate-500">{r.label}</span></span>
                <span className="col-start-2 md:col-start-auto text-slate-600">{r.detail}</span>
                <span className="col-start-2 md:col-start-auto md:text-right font-mono">{money(r.amount)}</span>
                <span className="col-start-2 md:col-start-auto"><ChequeChip c={r.cheque} /></span>
                <span className="col-start-2 md:col-start-auto text-xs text-amber-700">{r.blocker ?? fitErr.get(rowKey(r)) ?? ''}</span>
              </div>
            ))}
        </div>
      )}

      {data && (
        <div className="sticky bottom-0 bg-white border rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3 mb-6 shadow-sm">
          <div className="text-sm">
            已揀 <b>{selected.length}</b> 張 · 合計 <b className="font-mono">HK${money(total)}</b>
            {data.account.nextNoText && <> · 由 <span className="font-mono">#{data.account.nextNoText}</span> 開始</>}
            {data.account.remaining != null && data.account.remaining < selected.length && <span className="text-red-600"> · 支票簿得返 {data.account.remaining} 張</span>}
          </div>
          <button type="button" disabled={selected.length === 0 || printer.state.kind !== 'ready'} onClick={() => setSession(selected)}
            className="h-11 px-6 rounded-md bg-brand text-white font-semibold disabled:opacity-50">
            {printer.state.kind !== 'ready' ? '未連接打印機' : '開始打印'}
          </button>
        </div>
      )}

      {data && data.issued.length > 0 && (
        <section className="border rounded-lg bg-white overflow-hidden">
          <h2 className="font-semibold px-4 py-3 border-b">{month} 已出票（{data.account.label}）</h2>
          {data.issued.map(c => (
            <div key={c.id} className={`grid grid-cols-[90px_1fr_120px_110px_1fr_70px] gap-3 px-4 py-2 border-t text-sm items-center ${c.status === 'VOID' ? 'text-slate-400' : ''}`}>
              <span className="font-mono">#{c.chequeNo}</span>
              <span className={c.status === 'VOID' ? 'line-through' : ''}>{c.payeeName}</span>
              <span className="font-mono text-right">{money(c.amount)}</span>
              <span>{c.chequeDate}</span>
              <span className="text-xs">{c.status === 'VOID' ? `已作廢：${c.voidReason ?? ''}` : c.confirmed ? '✓ 已確認' : <span className="text-amber-700">未確認印得好唔好</span>}</span>
              {c.status !== 'VOID' ? <button type="button" onClick={() => voidCheque(c)} className="text-xs text-red-700 underline justify-self-end">作廢</button> : <span />}
            </div>
          ))}
        </section>
      )}

      {session && data && (
        <PrintSession rows={session} layout={data.layout} accountId={accountId} accountLabel={data.account.label}
          month={month} chequeDate={chequeDate} firstNo={data.account.nextNoText} send={printer.send}
          onClose={() => { setSession(null); load(); loadAccounts() }} />
      )}
    </div>
  )
}

function ChequeChip({ c }: { c: Row['cheque'] }) {
  if (!c) return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">待出票</span>
  return <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-800 font-mono">#{c.chequeNo}{c.confirmed ? '' : ' 未確認'}</span>
}

function LabRow({ r, month, on, canPick, fitErr, onToggle, onSaved }: {
  r: Row; month: string; on: boolean; canPick: boolean; fitErr: string | null; onToggle: () => void; onSaved: () => void
}) {
  const hasAmount = !r.sourceId.startsWith('new:')
  const [amount, setAmount] = useState(hasAmount ? String(r.amount) : '')
  const [ref, setRef] = useState(r.lab?.statementRef ?? '')
  const [msg, setMsg] = useState<string | null>(null)
  const dirty = amount !== (hasAmount ? String(r.amount) : '') || ref !== (r.lab?.statementRef ?? '')
  const save = async () => {
    setMsg(null)
    try {
      await apiFetch('/api/cheques/lab-amounts', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labId: r.lab!.labId, clinicId: r.clinicId, month, amount: amount.trim() === '' ? null : amount, statementRef: ref }),
      })
      onSaved()
    } catch (e: any) { setMsg(e?.message || '儲存失敗') }
  }
  const locked = !!r.cheque
  return (
    <div className={`grid grid-cols-[40px_1fr] md:grid-cols-[40px_1.4fr_1.6fr_1fr_0.9fr_1.4fr] gap-x-3 gap-y-1 px-4 py-2.5 border-t text-sm items-center ${canPick ? '' : 'bg-slate-50'}`}>
      <input type="checkbox" checked={on && canPick} disabled={!canPick} onChange={onToggle} aria-label={`揀 ${r.label}`} />
      <span><b className="font-medium">{r.payee ?? '—'}</b><br /><span className="text-xs text-slate-500">{r.label} · {r.clinicName}</span></span>
      <span className="col-start-2 md:col-start-auto flex flex-col gap-1">
        <input value={ref} onChange={e => setRef(e.target.value)} disabled={locked} placeholder="月結單號（可留空）" aria-label={`${r.label} ${r.clinicName} 月結單號`} className="border rounded px-2 py-1 text-xs" />
        <span className="text-xs text-slate-500">系統成本記錄：{money(r.lab?.systemCost ?? 0)}（只供參考）</span>
      </span>
      <span className="col-start-2 md:col-start-auto flex gap-1 items-center md:justify-end">
        <input value={amount} onChange={e => setAmount(e.target.value)} disabled={locked} inputMode="decimal" placeholder="月結單金額" aria-label={`${r.label} ${r.clinicName} 金額`}
          className="border rounded px-2 py-1 text-sm font-mono text-right w-32" />
        {dirty && !locked && <button type="button" onClick={save} className="text-xs text-brand font-semibold">儲存</button>}
      </span>
      <span className="col-start-2 md:col-start-auto"><ChequeChip c={r.cheque} /></span>
      <span className="col-start-2 md:col-start-auto text-xs text-amber-700">{msg ?? (locked ? '已出票：要改金額先作廢張票' : r.blocker ?? fitErr ?? '')}</span>
    </div>
  )
}

// ---------- 逐張打印 ----------

type Phase =
  | { k: 'confirm' }
  | { k: 'sending'; row: Row }
  | { k: 'await'; row: Row; cheque: { id: string; chequeNo: string }; content: ChequeContent }
  | { k: 'error'; msg: string }
  | { k: 'done' }

interface Log { chequeNo: string; payee: string; amount: number; st: 'ok' | 'void' }

function PrintSession({ rows, layout, accountId, accountLabel, month, chequeDate, firstNo, send, onClose }: {
  rows: Row[]; layout: Layout; accountId: string; accountLabel: string; month: string; chequeDate: string
  firstNo: string | null; send: (b: Uint8Array) => Promise<void>; onClose: () => void
}) {
  const [queue, setQueue] = useState<Row[]>(rows)
  const [phase, setPhase] = useState<Phase>({ k: 'confirm' })
  const [log, setLog] = useState<Log[]>([])
  const [voidReason, setVoidReason] = useState('印壞／對位唔啱')
  const [busy, setBusy] = useState(false)
  const off = { x: layout.offsetXmm, y: layout.offsetYmm }

  const patch = (id: string, body: object) => apiFetch(`/api/cheques/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  const printNext = async (q: Row[]) => {
    const row = q[0]
    if (!row) { setPhase({ k: 'done' }); return }
    setQueue(q.slice(1))
    setPhase({ k: 'sending', row })
    const pre = buildContent({ payee: row.payee ?? '', amount: row.amount, date: chequeDate }, layout.fields, layout.printerMode)
    if (!pre.ok) { setPhase({ k: 'error', msg: `${row.label}：${pre.error}` }); return }
    let cheque: { id: string; chequeNo: string; payeeName: string; amount: number }
    try {
      const r: any = await apiFetch('/api/cheques/issue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, month, chequeDate, sourceType: row.sourceType, sourceId: row.sourceId }),
      })
      cheque = r.cheque
    } catch (e: any) { setPhase({ k: 'error', msg: `${row.label}：${e?.message || '攞唔到支票號碼'}` }); return }
    // 用伺服器確認嘅抬頭＋金額
    const built = buildContent({ payee: cheque.payeeName, amount: cheque.amount, date: chequeDate }, layout.fields, layout.printerMode)
    try {
      if (!built.ok) throw new Error(built.error)
      await send(encodeForPrinter(layoutItems(layout.fields, built.content, off, layout.printerMode), layout.printerMode))
    } catch (e: any) {
      await patch(cheque.id, { action: 'release' }).catch(() => null)
      setQueue(prev => [row, ...prev])
      setPhase({ k: 'error', msg: `#${cheque.chequeNo} 送唔到打印機（號碼已退返）：${e?.message || ''}` })
      return
    }
    setPhase({ k: 'await', row, cheque, content: built.content })
  }

  const good = async () => {
    if (phase.k !== 'await') return
    setBusy(true)
    try {
      await patch(phase.cheque.id, { action: 'confirm' })
      setLog(l => [...l, { chequeNo: phase.cheque.chequeNo, payee: phase.content.payee, amount: phase.row.amount, st: 'ok' }])
      await printNext(queue)
    } catch (e: any) { setPhase({ k: 'error', msg: e?.message || '確認失敗' }) } finally { setBusy(false) }
  }

  const bad = async () => {
    if (phase.k !== 'await') return
    setBusy(true)
    try {
      await patch(phase.cheque.id, { action: 'void', reason: voidReason || '印壞' })
      setLog(l => [...l, { chequeNo: phase.cheque.chequeNo, payee: phase.content.payee, amount: phase.row.amount, st: 'void' }])
      await printNext([phase.row, ...queue])
    } catch (e: any) { setPhase({ k: 'error', msg: e?.message || '作廢失敗' }) } finally { setBusy(false) }
  }

  const close = () => {
    if (phase.k === 'await' && !window.confirm(`#${phase.cheque.chequeNo} 未確認印得好唔好。關閉後可以喺「已出票」作廢。確定關閉？`)) return
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="逐張打印">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex justify-between items-center px-6 py-4 border-b">
          <div className="text-lg font-bold">
            {phase.k === 'confirm' ? `準備打印 ${rows.length} 張` : phase.k === 'done' ? '打印完成' : `打印中 · 剩 ${queue.length + (phase.k === 'await' || phase.k === 'sending' ? 1 : 0)} 張`}
          </div>
          <div className="text-sm text-slate-600">{accountLabel}</div>
        </div>

        <div className="px-6 py-5 flex flex-col gap-4">
          {phase.k === 'confirm' && (
            <>
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
                <div className="text-sm text-amber-900">第一張會用支票號碼</div>
                <div className="text-3xl font-bold font-mono my-1">#{firstNo ?? '—'}</div>
                <div className="text-sm">請確認支票簿最面嗰張實物支票係呢個號碼。唔啱就先去 <Link href="/cheques/settings" className="underline">支票設定</Link> 改「下一張」。</div>
              </div>
              <div className="text-sm text-slate-600">每張印完要睇一睇：「印得好」先印下一張；「作廢」= 呢個號碼記做作廢（實物支票剪角保留），用下一張重印。</div>
              <div className="flex justify-end gap-3">
                <button type="button" onClick={onClose} className="h-11 px-5 rounded-md border">取消</button>
                <button type="button" onClick={() => printNext(queue)} className="h-11 px-6 rounded-md bg-brand text-white font-semibold">號碼啱，開始</button>
              </div>
            </>
          )}

          {phase.k === 'sending' && <div className="text-sm text-slate-600 py-6 text-center">送緊 {phase.row.label} 去打印機…</div>}

          {phase.k === 'await' && (
            <>
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
                <div className="text-sm text-amber-900">請將呢張支票正面向上插入打印機（已送出，插入就自動印）</div>
                <div className="text-3xl font-bold font-mono my-1">#{phase.cheque.chequeNo}</div>
                <div>{phase.content.payee} · <span className="font-mono">HK${money(phase.row.amount)}</span></div>
              </div>
              <ChequePreview fields={layout.fields} items={layoutItems(layout.fields, phase.content, off, layout.printerMode)} mode={layout.printerMode} offset={off} width={680} />
              <div className="text-sm font-semibold">印好之後，#{phase.cheque.chequeNo} 印成點？</div>
              <div className="flex gap-3">
                <button type="button" disabled={busy} onClick={good} className="flex-1 h-12 rounded-lg bg-green-700 text-white font-bold disabled:opacity-50">印得好，{queue.length ? '下一張' : '完成'}</button>
                <button type="button" disabled={busy} onClick={bad} className="flex-1 h-12 rounded-lg border border-red-600 text-red-700 font-bold disabled:opacity-50">作廢，用下一張重印</button>
              </div>
              <label className="text-xs text-slate-600 flex items-center gap-2">作廢原因
                <input value={voidReason} onChange={e => setVoidReason(e.target.value)} className="border rounded px-2 py-1 text-sm flex-1" />
              </label>
            </>
          )}

          {phase.k === 'error' && (
            <>
              <div className="bg-red-50 border border-red-300 rounded-lg p-4 text-sm text-red-800" role="alert">{phase.msg}</div>
              <div className="flex justify-end gap-3">
                <button type="button" onClick={onClose} className="h-11 px-5 rounded-md border">停低</button>
                {queue.length > 0 && <button type="button" onClick={() => printNext(queue)} className="h-11 px-6 rounded-md bg-brand text-white font-semibold">再試／繼續</button>}
              </div>
            </>
          )}

          {phase.k === 'done' && <div className="text-sm text-green-800">全部完成。簽名後就可以寄出。</div>}

          {log.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              {log.map((l, i) => (
                <div key={i} className="grid grid-cols-[100px_1fr_120px_90px] gap-3 px-4 py-2 border-t first:border-t-0 text-sm">
                  <span className="font-mono">#{l.chequeNo}</span><span>{l.payee}</span>
                  <span className="font-mono text-right">{money(l.amount)}</span>
                  <span className={l.st === 'ok' ? 'text-green-700' : 'text-red-700'}>{l.st === 'ok' ? '✓ 已出票' : '已作廢'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t flex justify-between items-center">
          <div className="text-xs text-slate-500">中途停低都得：未印嘅保持「待出票」，號碼唔會用咗</div>
          {phase.k !== 'confirm' && <button type="button" onClick={close} className="h-10 px-4 rounded-md border text-sm">{phase.k === 'done' ? '關閉' : '暫停'}</button>}
        </div>
      </div>
    </div>
  )
}
