'use client'

// ============================================================
// ★ cwm-chequeprint-20261005：打印機同版面校準（只限老闆；API RBAC = OWNER）
//   1. 連接（WebUSB；Ubuntu 一次性設定）  2. 測試（純文字 → ESC/P 格仔，決定模式）
//   3. 版面（欄位 mm）＋整體偏移；印校準頁疊落真支票對光睇
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { BackButton } from '@/components/BackButton'
import { ChequePreview } from '@/components/cheques/ChequePreview'
import { PrinterBadge, usePrinter } from '@/components/cheques/usePrinter'
import { HSBC_DEFAULT_FIELDS, layoutItems, type LayoutFields, type PrinterMode } from '@/lib/cheque-print/layout'
import { buildContent } from '@/lib/cheque-print/content'
import { escpGridPage, plainTestPage } from '@/lib/cheque-print/encode'
import { encodeForPrinter } from '@/lib/cheque-print/webusb'
import { todayHK } from '@/lib/hk-date'

interface Layout { id: string; name: string; fields: LayoutFields; offsetXmm: number; offsetYmm: number; printerMode: PrinterMode }

const UDEV_RULE = 'SUBSYSTEM=="usb", ATTR{idVendor}=="206d", ATTR{idProduct}=="0201", MODE="0666"'
const SETUP_CMDS = [
  '# 1. 裝 Google Chrome（唔好用 snap 版 Chromium，snap 版攞唔到 USB）',
  'wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb',
  'sudo apt install ./google-chrome-stable_current_amd64.deb',
  '',
  '# 2. 俾 Chrome 用部打印機（206d:0201 = 南天／GWI PR2 Plus）',
  `echo '${UDEV_RULE}' | sudo tee /etc/udev/rules.d/60-cheque-printer.rules`,
  'sudo udevadm control --reload-rules && sudo udevadm trigger',
  '',
  '# 3. 停用系統 usblp driver（佢會霸住部打印機；呢部機只印支票，冇影響）',
  "echo 'blacklist usblp' | sudo tee /etc/modprobe.d/no-usblp.conf",
  'sudo rmmod usblp 2>/dev/null; true',
  '',
  '# 4. 拔插打印機 USB，用 Chrome 開系統登入，去呢版撳「揀打印機」',
].join('\n')

const SAMPLE = { payee: 'SAMPLE PAYEE NAME', amount: 12345.67 }

export default function ChequePrinterPage() {
  const printer = usePrinter()
  const [layouts, setLayouts] = useState<Layout[]>([])
  const [sel, setSel] = useState<string>('')
  const [form, setForm] = useState<Layout | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d: any = await apiFetch('/api/cheques/settings')
      setLayouts(d.layouts || [])
      const first = (d.layouts || []).find((l: Layout) => l.id === sel) ?? d.layouts?.[0]
      if (first) { setSel(first.id); setForm(first) }
    } catch (e: any) { setMsg(e?.message || '載入失敗') }
  }, [sel])
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 只喺開頁載入

  const content = useMemo(() => {
    if (!form) return null
    const r = buildContent({ ...SAMPLE, date: todayHK() }, form.fields, form.printerMode)
    return r.ok ? r.content : null
  }, [form])
  const items = useMemo(() => (form && content ? layoutItems(form.fields, content, { x: form.offsetXmm, y: form.offsetYmm }, form.printerMode) : []), [form, content])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true); setMsg(null)
    try { await fn(); setMsg(`${label} ✓`) } catch (e: any) { setMsg(e?.message || `${label}失敗`) } finally { setBusy(false) }
  }

  const save = () => run('已儲存', async () => {
    if (!form) return
    await apiFetch(`/api/cheques/layouts/${form.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.name, fields: form.fields, offsetXmm: form.offsetXmm, offsetYmm: form.offsetYmm, printerMode: form.printerMode }),
    })
    await load()
  })

  const setField = (key: keyof LayoutFields, prop: string, v: string) => {
    if (!form) return
    const n = Number(v)
    if (!Number.isFinite(n)) return
    setForm({ ...form, fields: { ...form.fields, [key]: { ...(form.fields[key] as any), [prop]: n } } })
  }

  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(layouts.find(l => l.id === form.id))

  return (
    <div className="p-6" style={{ maxWidth: 1100 }}>
      <BackButton to="/cheques" label="返回支票打印" />
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h1 className="text-2xl font-bold">打印機同版面校準</h1>
        <PrinterBadge state={printer.state} onConnect={() => run('已連接', async () => { await printer.connect() })} />
      </div>
      {msg && <div className={`text-sm mb-3 ${msg.includes('✓') ? 'text-green-700' : 'text-red-600'}`} role="status">{msg}</div>}

      <section className="border rounded-lg bg-white p-4 mb-5">
        <h2 className="font-semibold mb-2">① 連接（Ubuntu 機做一次）</h2>
        <p className="text-sm text-slate-600 mb-2">打印機用 USB 接 inbox 嗰部 Ubuntu 機。喺 Ubuntu 開終端機，逐行貼入以下指令：</p>
        <pre className="text-xs bg-slate-900 text-slate-100 rounded p-3 overflow-x-auto whitespace-pre">{SETUP_CMDS}</pre>
        <div className="flex gap-2 mt-3 flex-wrap">
          <button type="button" onClick={() => navigator.clipboard?.writeText(SETUP_CMDS.split('\n').filter(l => l && !l.startsWith('#')).join('\n'))} className="h-9 px-3 rounded-md border text-sm">複製指令</button>
          <button type="button" onClick={() => run('已連接', async () => { await printer.connect() })} className="h-9 px-3 rounded-md bg-brand text-white text-sm">揀打印機</button>
        </div>
      </section>

      <section className="border rounded-lg bg-white p-4 mb-5">
        <h2 className="font-semibold mb-2">② 測試（用白紙）</h2>
        <ol className="text-sm text-slate-700 list-decimal pl-5 space-y-1 mb-3">
          <li>放一張白紙入打印機，撳「測試 1」。印到 3 行英文 = USB 通咗。</li>
          <li>再放白紙，撳「測試 2」。印到整齊嘅「+」格仔（每格 10mm）= 打印機識 ESC/P，揀「ESC/P（準確，印到中文）」。</li>
          <li>測試 2 印出亂碼或者冇反應 = 打印機用緊 PR2 指令，揀「純文字」（位置會黐埋 2.5×4.2mm 格，抬頭只可以英文）。或者喺打印機設定轉做 Epson LQ 仿真再試。</li>
        </ol>
        <div className="flex gap-2 flex-wrap items-center">
          <button type="button" disabled={busy || printer.state.kind !== 'ready'} onClick={() => run('已送出測試 1', () => printer.send(plainTestPage()))} className="h-9 px-3 rounded-md border text-sm disabled:opacity-50">印測試 1：純文字</button>
          <button type="button" disabled={busy || printer.state.kind !== 'ready'} onClick={() => run('已送出測試 2', () => printer.send(escpGridPage(form?.fields.paper ?? HSBC_DEFAULT_FIELDS.paper)))} className="h-9 px-3 rounded-md border text-sm disabled:opacity-50">印測試 2：ESC/P 格仔</button>
          {form && (
            <span className="flex items-center gap-3 text-sm ml-2">
              模式：
              <label className="flex items-center gap-1"><input type="radio" name="mode" checked={form.printerMode === 'ESCP'} onChange={() => setForm({ ...form, printerMode: 'ESCP' })} />ESC/P（準確，印到中文）</label>
              <label className="flex items-center gap-1"><input type="radio" name="mode" checked={form.printerMode === 'TEXT'} onChange={() => setForm({ ...form, printerMode: 'TEXT' })} />純文字</label>
            </span>
          )}
        </div>
      </section>

      {form && (
        <section className="border rounded-lg bg-white p-4 mb-5">
          <div className="flex justify-between items-center flex-wrap gap-2 mb-3">
            <h2 className="font-semibold">③ 版面同校準</h2>
            {layouts.length > 1 && (
              <select value={sel} onChange={e => { setSel(e.target.value); setForm(layouts.find(l => l.id === e.target.value) ?? null) }} className="border rounded px-2 py-1 text-sm bg-white" aria-label="版面">
                {layouts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
          </div>
          <p className="text-sm text-slate-600 mb-3">
            匯豐冇公開欄位位置，預設值係按香港支票（約 180×88mm）估。第一次用：撳「印校準頁」用白紙（剪成支票大細）或者一張作廢支票印，
            疊落真支票對光睇偏咗幾多 mm，填「整體左右／上下」；個別欄唔啱先改下面欄位。正數 = 向右／向下。
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
            <div>
              {content ? <ChequePreview fields={form.fields} items={items} mode={form.printerMode} offset={{ x: form.offsetXmm, y: form.offsetYmm }} /> : <div className="text-sm text-red-600">版面塞唔落樣本內容，請調闊欄位</div>}
            </div>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Num label="整體左右（mm）" value={form.offsetXmm} onChange={v => setForm({ ...form, offsetXmm: v })} />
                <Num label="整體上下（mm）" value={form.offsetYmm} onChange={v => setForm({ ...form, offsetYmm: v })} />
              </div>
              <button type="button" disabled={busy || printer.state.kind !== 'ready' || !content} onClick={() => run('已送出校準頁', async () => { await printer.send(encodeForPrinter(items, form.printerMode)) })} className="h-10 rounded-md border border-brand text-brand text-sm font-semibold disabled:opacity-50">印校準頁（樣本內容）</button>
              <button type="button" disabled={busy || !dirty} onClick={save} className="h-10 rounded-md bg-brand text-white text-sm font-semibold disabled:opacity-50">儲存版面</button>
              <button type="button" onClick={() => setForm({ ...form, fields: HSBC_DEFAULT_FIELDS, offsetXmm: 0, offsetYmm: 0 })} className="text-xs text-slate-500 underline self-start">還原預設位置</button>
            </div>
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">個別欄位位置（mm，由支票左上角計）</summary>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-sm">
              <Num label="日期 左" value={form.fields.date.x} onChange={v => setField('date', 'x', String(v))} />
              <Num label="日期 上" value={form.fields.date.y} onChange={v => setField('date', 'y', String(v))} />
              <Num label="日期 每格闊" value={form.fields.date.pitch} onChange={v => setField('date', 'pitch', String(v))} />
              <Num label="日期 日月年之間" value={form.fields.date.gap1} onChange={v => setForm({ ...form, fields: { ...form.fields, date: { ...form.fields.date, gap1: v, gap2: v } } })} />
              {(['payee', 'words1', 'words2', 'amount'] as const).map(k => (
                <FieldGroup key={k} label={{ payee: '抬頭', words1: '大寫第 1 行', words2: '大寫第 2 行', amount: '金額' }[k]}
                  f={form.fields[k]} onChange={(p, v) => setField(k, p, String(v))} />
              ))}
              <Num label="支票闊" value={form.fields.paper.w} onChange={v => setField('paper', 'w', String(v))} />
              <Num label="支票高" value={form.fields.paper.h} onChange={v => setField('paper', 'h', String(v))} />
              <label className="flex flex-col gap-1 text-xs text-slate-600">大寫字距
                <select value={form.fields.wordsCpi} onChange={e => setForm({ ...form, fields: { ...form.fields, wordsCpi: e.target.value === '10' ? 10 : 12 } })} className="border rounded px-2 py-1.5 bg-white">
                  <option value="12">12 cpi（細啲，塞到多啲）</option>
                  <option value="10">10 cpi</option>
                </select>
              </label>
            </div>
          </details>
        </section>
      )}
    </div>
  )
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-600">{label}
      <input value={text} inputMode="decimal" onChange={e => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n) }}
        className="border rounded px-2 py-1.5 font-mono text-sm" />
    </label>
  )
}

function FieldGroup({ label, f, onChange }: { label: string; f: { x: number; y: number; width: number }; onChange: (p: 'x' | 'y' | 'width', v: number) => void }) {
  return (
    <>
      <Num label={`${label} 左`} value={f.x} onChange={v => onChange('x', v)} />
      <Num label={`${label} 上`} value={f.y} onChange={v => onChange('y', v)} />
      <Num label={`${label} 闊`} value={f.width} onChange={v => onChange('width', v)} />
      <span className="hidden sm:block" />
    </>
  )
}
