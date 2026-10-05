'use client'

// ============================================================
// ★ cwm-chequeprint-20261005：打印機同版面校準（只限老闆；API RBAC = OWNER）
//   1. 連接（WebUSB；Ubuntu 一次性設定）  2. 測試（純文字 → ESC/P 格仔，決定模式）
//   3. 版面：每個欄位（日／月／年／抬頭／大寫兩行／金額）各自 x、y —— 預覽拖動、方向鍵或者數字微調；
//      打印機起點偏移另外一格（試印量度，一般唔使改）；印校準頁／對位格仔疊落真支票睇
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { BackButton } from '@/components/BackButton'
import { ChequePreview } from '@/components/cheques/ChequePreview'
import { PrinterBadge, usePrinter } from '@/components/cheques/usePrinter'
import { CPIS, FIELD_KEYS, FIELD_LABEL, HSBC_DEFAULT_FIELDS, HSBC_DEFAULT_OFFSET, TEXT_FIELDS, layoutItems, shiftAll, type Cpi, type FieldKey, type LayoutFields, type PrinterMode } from '@/lib/cheque-print/layout'
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
  'sudo apt install -y fonts-noto-cjk   # 中文抬頭用（通常已經有）',
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

  const [picked, setPicked] = useState<FieldKey | null>(null)

  const content = useMemo(() => {
    if (!form) return null
    const r = buildContent({ ...SAMPLE, date: todayHK() }, form.fields, form.printerMode)
    return r.ok ? r.content : null
  }, [form])
  const off = form ? { x: form.offsetXmm, y: form.offsetYmm } : { x: 0, y: 0 }
  // 預覽 = 支票座標（唔加打印機起點）；打印先加
  const previewItems = useMemo(() => (form && content ? layoutItems(form.fields, content, { x: 0, y: 0 }, form.printerMode) : []), [form, content])

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

  const r1 = (n: number) => Math.round(n * 10) / 10
  const setFields = (f: LayoutFields) => form && setForm({ ...form, fields: f })
  const move = (k: FieldKey, dx: number, dy: number) => {
    if (!form) return
    const cur = form.fields[k]
    setFields({ ...form.fields, [k]: { ...cur, x: Math.max(0, r1(cur.x + dx)), y: Math.max(0, r1(cur.y + dy)) } })
  }
  const setProp = (k: FieldKey, prop: 'x' | 'y' | 'width' | 'cpi', v: number) => {
    if (!form) return
    setFields({ ...form.fields, [k]: { ...form.fields[k], [prop]: v } })
  }

  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(layouts.find(l => l.id === form.id))
  const canPrint = !busy && printer.state.kind === 'ready'

  return (
    <div className="p-6" style={{ maxWidth: 1200 }}>
      <BackButton to="/cheques" label="返回支票打印" />
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h1 className="text-2xl font-bold">打印機同版面校準</h1>
        <PrinterBadge state={printer.state} onConnect={() => run('已連接', async () => { await printer.connect() })} />
      </div>
      {msg && <div className={`text-sm mb-3 ${msg.includes('✓') ? 'text-green-700' : 'text-red-600'}`} role="status">{msg}</div>}

      {form && (
        <section className="border rounded-lg bg-white p-4 mb-5">
          <div className="flex justify-between items-center flex-wrap gap-2 mb-2">
            <h2 className="font-semibold">版面同校準（匯豐支票）</h2>
            {layouts.length > 1 && (
              <select value={sel} onChange={e => { setSel(e.target.value); setForm(layouts.find(l => l.id === e.target.value) ?? null) }} className="border rounded px-2 py-1 text-sm bg-white" aria-label="版面">
                {layouts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
          </div>
          <ol className="text-sm text-slate-600 list-decimal pl-5 space-y-0.5 mb-3">
            <li>放一張作廢支票（或者剪成支票大細嘅白紙），撳「印校準頁」。</li>
            <li>邊個欄位唔喺位：喺預覽撳嗰個欄位，拖過去；或者用方向鍵／下面嘅箭咀微調（每下 0.5mm，Shift + 方向鍵 = 2mm）。每個欄位獨立移，包括上下。</li>
            <li>想知準確位置：用白紙撳「印對位格仔」，疊落真支票對光睇，格仔上嘅數字就係支票上嘅 mm。</li>
            <li>滿意就撳「儲存版面」。</li>
          </ol>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-5">
            <div>
              {content
                ? <ChequePreview fields={form.fields} items={previewItems} mode={form.printerMode} width={760} selected={picked} onSelect={setPicked} onMove={move} />
                : <div className="text-sm text-red-600">版面塞唔落樣本內容，請調闊欄位</div>}
              <div className="flex flex-wrap gap-2 mt-3">
                <button type="button" disabled={!canPrint || !content} onClick={() => run('已送出校準頁', async () => { await printer.send(encodeForPrinter(layoutItems(form.fields, content!, off, form.printerMode), form.printerMode)) })} className="h-10 px-4 rounded-md border border-brand text-brand text-sm font-semibold disabled:opacity-50">印校準頁（樣本內容）</button>
                <button type="button" disabled={!canPrint} onClick={() => run('已送出對位格仔', () => printer.send(escpGridPage(form.fields.paper, off)))} className="h-10 px-4 rounded-md border text-sm disabled:opacity-50">印對位格仔（每 10mm）</button>
                <button type="button" disabled={busy || !dirty} onClick={save} className="h-10 px-5 rounded-md bg-brand text-white text-sm font-semibold disabled:opacity-50">儲存版面</button>
                {dirty && <button type="button" onClick={() => setForm(layouts.find(l => l.id === form.id) ?? form)} className="h-10 px-3 text-sm text-slate-600 underline">還原未儲存</button>}
              </div>
            </div>

            <div className="flex flex-col gap-3">

              <div className="border rounded-lg p-3">
                <div className="text-sm font-medium mb-2">全部欄位一齊移</div>
                <div className="flex gap-2">
                  {([['←', -0.5, 0], ['→', 0.5, 0], ['↑', 0, -0.5], ['↓', 0, 0.5]] as const).map(([t, dx, dy]) => (
                    <button key={t} type="button" aria-label={`全部向${t}`} onClick={() => setFields(shiftAll(form.fields, dx, dy))} className="w-10 h-9 rounded border text-sm">{t}</button>
                  ))}
                  <span className="text-xs text-slate-500 self-center">每下 0.5mm</span>
                </div>
              </div>

              <details className="border rounded-lg p-3">
                <summary className="cursor-pointer text-sm font-medium">打印機起點偏移（一般唔使改）</summary>
                <p className="text-xs text-slate-500 my-2">打印機印唔到紙邊，起點會由紙邊向右、向下移少少。白紙試印量到約 4.5mm／4mm，預設已抵銷。所有欄位同時受影響。</p>
                <div className="grid grid-cols-2 gap-3">
                  <NumBox label="左右（mm）" value={form.offsetXmm} onChange={v => setForm({ ...form, offsetXmm: v })} />
                  <NumBox label="上下（mm）" value={form.offsetYmm} onChange={v => setForm({ ...form, offsetYmm: v })} />
                </div>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <NumBox label="支票闊（mm）" value={form.fields.paper.w} onChange={v => setFields({ ...form.fields, paper: { ...form.fields.paper, w: v } })} />
                  <NumBox label="支票高（mm）" value={form.fields.paper.h} onChange={v => setFields({ ...form.fields, paper: { ...form.fields.paper, h: v } })} />
                </div>
              </details>
              <button type="button" onClick={() => setForm({ ...form, fields: HSBC_DEFAULT_FIELDS, offsetXmm: HSBC_DEFAULT_OFFSET.x, offsetYmm: HSBC_DEFAULT_OFFSET.y })} className="text-xs text-slate-500 underline self-start">還原預設位置</button>
            </div>
          </div>
          <div className="border rounded-lg overflow-x-auto mt-5">
            <div className="grid grid-cols-[96px_190px_190px_90px_96px] gap-2 px-3 py-1.5 bg-slate-50 text-xs font-semibold text-slate-600">
              <span>欄位</span><span>左右 x</span><span>上下 y</span><span>闊</span><span>字距</span>
            </div>
            {FIELD_KEYS.map(k => {
              const f: any = form.fields[k]
              const isText = (TEXT_FIELDS as readonly string[]).includes(k)
              return (
                <div key={k} onClick={() => setPicked(k)} className={`grid grid-cols-[96px_190px_190px_90px_96px] gap-2 px-3 py-1.5 border-t items-center text-sm ${picked === k ? 'bg-blue-50' : ''}`}>
                  <span className="font-medium">{FIELD_LABEL[k]}</span>
                  <Stepper label={`${FIELD_LABEL[k]} 左右`} value={f.x} minus="←" plus="→" onChange={v => setProp(k, 'x', v)} />
                  <Stepper label={`${FIELD_LABEL[k]} 上下`} value={f.y} minus="↑" plus="↓" onChange={v => setProp(k, 'y', v)} />
                  {isText ? <NumBox label={`${FIELD_LABEL[k]} 闊`} value={f.width} onChange={v => setProp(k, 'width', v)} bare /> : <span />}
                  {isText && k !== 'words2' ? (
                    <select aria-label={`${FIELD_LABEL[k]} 字距`} value={f.cpi} onChange={e => {
                      const c = Number(e.target.value) as Cpi
                      // 大寫兩行用同一個字距
                      if (k === 'words1') setFields({ ...form.fields, words1: { ...form.fields.words1, cpi: c }, words2: { ...form.fields.words2, cpi: c } })
                      else setProp(k, 'cpi', c)
                    }} className="border rounded px-1 py-1 text-xs bg-white">
                      {CPIS.map(c => <option key={c} value={c}>{c} cpi</option>)}
                    </select>
                  ) : <span className="text-xs text-slate-400">{k === 'words2' ? '同第 1 行' : ''}</span>}
                </div>
              )
            })}
            <div className="grid grid-cols-[96px_190px] gap-2 px-3 py-1.5 border-t items-center text-sm">
              <span className="font-medium">日期字距</span>
              <Stepper label="日期每個數字距離" value={form.fields.datePitch} minus="−" plus="＋" onChange={v => setFields({ ...form.fields, datePitch: v })} />
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-2">字距：10 cpi 最大隻字；塞唔落會自動用細啲（12 → 15）。</p>
        </section>
      )}

      <section className="border rounded-lg bg-white p-4 mb-5">
        <h2 className="font-semibold mb-2">打印機測試（用白紙）</h2>
        <ol className="text-sm text-slate-700 list-decimal pl-5 space-y-1 mb-3">
          <li>「測試 1」印到 3 行英文 = USB 通咗。</li>
          <li>「測試 2」印到整齊嘅「+」格仔 = 打印機識 ESC/P，揀「ESC/P（準確，印到中文）」。</li>
          <li>測試 2 印出亂碼或者冇反應 = 揀「純文字」（位置會黐埋 2.5×4.2mm 格，抬頭只可以英文）。</li>
        </ol>
        <div className="flex gap-2 flex-wrap items-center">
          <button type="button" disabled={!canPrint} onClick={() => run('已送出測試 1', () => printer.send(plainTestPage()))} className="h-9 px-3 rounded-md border text-sm disabled:opacity-50">印測試 1：純文字</button>
          <button type="button" disabled={!canPrint} onClick={() => run('已送出測試 2', () => printer.send(escpGridPage(form?.fields.paper ?? HSBC_DEFAULT_FIELDS.paper)))} className="h-9 px-3 rounded-md border text-sm disabled:opacity-50">印測試 2：ESC/P 格仔</button>
          {form && (
            <span className="flex items-center gap-3 text-sm ml-2">
              模式：
              <label className="flex items-center gap-1"><input type="radio" name="mode" checked={form.printerMode === 'ESCP'} onChange={() => setForm({ ...form, printerMode: 'ESCP' })} />ESC/P（準確，印到中文）</label>
              <label className="flex items-center gap-1"><input type="radio" name="mode" checked={form.printerMode === 'TEXT'} onChange={() => setForm({ ...form, printerMode: 'TEXT' })} />純文字</label>
            </span>
          )}
        </div>
      </section>

      <section className="border rounded-lg bg-white p-4 mb-5">
        <h2 className="font-semibold mb-2">Ubuntu 機一次性設定</h2>
        <p className="text-sm text-slate-600 mb-2">打印機用 USB 接 inbox 嗰部 Ubuntu 機（唔使裝 driver）。喺 Ubuntu 開終端機，逐行貼入以下指令：</p>
        <pre className="text-xs bg-slate-900 text-slate-100 rounded p-3 overflow-x-auto whitespace-pre">{SETUP_CMDS}</pre>
        <div className="flex gap-2 mt-3 flex-wrap">
          <button type="button" onClick={() => navigator.clipboard?.writeText(SETUP_CMDS.split('\n').filter(l => l && !l.startsWith('#')).join('\n'))} className="h-9 px-3 rounded-md border text-sm">複製指令</button>
          <button type="button" onClick={() => run('已連接', async () => { await printer.connect() })} className="h-9 px-3 rounded-md bg-brand text-white text-sm">揀打印機</button>
        </div>
      </section>
    </div>
  )
}

/** 數字＋兩個箭咀（每下 0.5mm） */
function Stepper({ label, value, minus, plus, onChange }: { label: string; value: number; minus: string; plus: string; onChange: (v: number) => void }) {
  const r1 = (n: number) => Math.round(n * 10) / 10
  return (
    <span className="flex items-center gap-1">
      <button type="button" aria-label={`${label} ${minus}`} onClick={e => { e.stopPropagation(); onChange(Math.max(0, r1(value - 0.5))) }} className="w-7 h-7 rounded border text-xs shrink-0">{minus}</button>
      <NumBox label={label} value={value} onChange={onChange} bare />
      <button type="button" aria-label={`${label} ${plus}`} onClick={e => { e.stopPropagation(); onChange(r1(value + 0.5)) }} className="w-7 h-7 rounded border text-xs shrink-0">{plus}</button>
    </span>
  )
}

function NumBox({ label, value, onChange, bare }: { label: string; value: number; onChange: (v: number) => void; bare?: boolean }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const input = (
    <input value={text} inputMode="decimal" aria-label={bare ? label : undefined}
      onChange={e => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n) }}
      className="border rounded px-1.5 py-1 font-mono text-sm w-full min-w-0 text-center" />
  )
  if (bare) return input
  return <label className="flex flex-col gap-1 text-xs text-slate-600">{label}{input}</label>
}
