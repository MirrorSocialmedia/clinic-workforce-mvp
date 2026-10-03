'use client'

/**
 * ★ cwm-bulkpayslip-20261003：一鍵匯出全部糧單（計糧管理頁）
 *
 * 揀月份 → 列出該月你睇得到嘅計糧單（每間診所一張）→ 下載一個 ZIP：
 *   <月份>_薪資明細/<診所>/薪資明細_<姓名>_<月份>.pdf（＋ 選填 <診所>_<月份>_計糧總表.xlsx）
 *
 * 每份 PDF = 員工明細頁〔匯出 PDF〕同一個 function（lib/payslip-pdf），喺隱藏 iframe 打開
 * `/payroll/<run>/employee/<emp>?embed=1` 砌，版面一模一樣。
 *
 * 權限／保密（唔准匯出唔應該匯出嘅嘢）：
 *   - 計糧單清單、單內員工全部經現有 API 拎 —— server 已按診所範圍 + getConfidentialScope 過濾，
 *     睇唔到嘅單／保密員工根本唔會出現喺清單
 *   - 每份 PDF 再經員工明細 API（canSeeConfidential）—— 403 = 跳過，唔會砌
 *   - 完成寫 PAYROLL_BULK_PDF_EXPORT audit
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PAYSLIP_EMBED_KEY, type PayslipEmbedHandle } from '@/lib/payslip-pdf'
import { toHKDateStr } from '@/lib/hk-date'

type RunRow = { id: string; periodMonth: string; status: string; clinic: { id: string; name: string } | null; itemCount?: number }
type Phase = 'pick' | 'running' | 'done'
const STATUS_LABEL: Record<string, string> = { DRAFT: '草稿', FINALIZED: '已確認', EXPORTED: '已匯出' }

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || '未命名'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function BulkPayslipExport({ months, defaultMonth }: { months: string[]; defaultMonth: string }) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(defaultMonth)
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [withXlsx, setWithXlsx] = useState(true)
  const [phase, setPhase] = useState<Phase>('pick')
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' })
  const [perRun, setPerRun] = useState<Record<string, { done: number; total: number }>>({})
  const [problems, setProblems] = useState<string[]>([])
  const [zipOk, setZipOk] = useState(false)
  const cancelRef = useRef(false)
  const frameHost = useRef<HTMLDivElement | null>(null)

  useEffect(() => { setMonth(defaultMonth) }, [defaultMonth])

  useEffect(() => {
    if (!open || !month) return
    setRuns(null)
    fetch(`/api/payroll-runs?periodMonth=${month}&pageSize=100`, { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { runs: [] }))
      .then(d => {
        const list: RunRow[] = (d.runs || []).filter((r: RunRow) => toHKDateStr(new Date(r.periodMonth)).slice(0, 7) === month)
        setRuns(list)
        // ★ 拍板：預設連草稿都匯出（先發畀員工確認，最後先「確認計糧」）
        setPicked(Object.fromEntries(list.map(r => [r.id, true])))
      })
      .catch(() => setRuns([]))
  }, [open, month])

  /** 隱藏 iframe 打開員工明細頁（embed），等佢掛 handle，再砌 PDF */
  const renderOne = async (runId: string, empId: string): Promise<{ data: Uint8Array } | { skip: string }> => {
    const host = frameHost.current!
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    // ★ 桌面闊度 —— 同老闆喺電腦撳〔匯出 PDF〕嗰陣同一個版面
    iframe.style.cssText = 'position:fixed;left:-12000px;top:0;width:1280px;height:2400px;border:0;opacity:0;pointer-events:none'
    iframe.src = `/payroll/${runId}/employee/${empId}?embed=1`
    host.appendChild(iframe)
    try {
      const t0 = Date.now()
      while (Date.now() - t0 < 60_000) {
        if (cancelRef.current) return { skip: '已取消' }
        const h = (iframe.contentWindow as any)?.[PAYSLIP_EMBED_KEY] as PayslipEmbedHandle | undefined
        if (h?.state === 'forbidden') return { skip: '保密員工（你冇權限）' }
        if (h?.state === 'error') return { skip: `載入失敗：${h.message}` }
        // ★ Blob 喺 iframe 嘅 realm 產生（instanceof 主頁 Blob = false，JSZip 會唔認）—— iframe 拆走前轉做 bytes
        if (h?.state === 'ready') return { data: new Uint8Array(await (await h.build()).arrayBuffer()) }
        await sleep(250)
      }
      return { skip: '載入超時' }
    } finally {
      iframe.remove()
    }
  }

  const start = async () => {
    const chosen = (runs ?? []).filter(r => picked[r.id])
    if (!chosen.length) return
    cancelRef.current = false
    setPhase('running')
    setProblems([])
    setZipOk(false)
    try {
      await runExport(chosen)
    } catch (e) {
      console.error('[bulk-payslip]', e)
      setProblems([`匯出失敗：${(e as Error)?.message ?? e}`])
      setPhase('done')
    }
  }

  const runExport = async (chosen: RunRow[]) => {
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    const root = zip.folder(`${month}_薪資明細`)!
    const probs: string[] = []

    // 先拎齊每張單嘅員工（server 已過濾保密／範圍）
    const plan: { run: RunRow; folder: string; items: { employeeId: string; name: string }[] }[] = []
    const usedFolders = new Set<string>()
    for (const run of chosen) {
      const res = await fetch(`/api/payroll-runs/${run.id}`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) { probs.push(`${run.clinic?.name ?? '全部診所'}：讀唔到計糧單（${res.status}）`); continue }
      const d = await res.json()
      const items = ((d.run?.items ?? d.items) || []).map((it: any) => ({ employeeId: it.employeeId, name: it.employee?.user?.name ?? it.employeeId }))
      let folder = safeName(run.clinic?.name ?? '全部診所')
      while (usedFolders.has(folder)) folder += '_2'
      usedFolders.add(folder)
      plan.push({ run, folder, items })
    }
    const total = plan.reduce((s, p) => s + p.items.length, 0)
    setPerRun(Object.fromEntries(plan.map(p => [p.run.id, { done: 0, total: p.items.length }])))
    setProgress({ done: 0, total, label: '' })

    let done = 0, pdfCount = 0
    for (const p of plan) {
      const dir = root.folder(p.folder)!
      if (withXlsx) {
        try {
          const r = await fetch(`/api/payroll-runs/${p.run.id}/export`, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'xlsx' }),
          })
          if (r.ok) dir.file(`${p.folder}_${month}_計糧總表.xlsx`, await r.blob())
          else probs.push(`${p.folder}：計糧總表匯出失敗（${r.status}）`)
        } catch { probs.push(`${p.folder}：計糧總表匯出失敗`) }
      }
      const usedNames = new Set<string>()
      for (const it of p.items) {
        if (cancelRef.current) break
        setProgress({ done, total, label: `${p.folder} · ${it.name}` })
        const r = await renderOne(p.run.id, it.employeeId)
        if ('data' in r) {
          let fname = `薪資明細_${safeName(it.name)}_${month}`
          while (usedNames.has(fname)) fname += '_2'
          usedNames.add(fname)
          dir.file(`${fname}.pdf`, r.data)
          pdfCount++
        } else if (r.skip !== '已取消') {
          probs.push(`${p.folder} · ${it.name}：${r.skip}`)
        }
        done++
        setPerRun(prev => ({ ...prev, [p.run.id]: { done: (prev[p.run.id]?.done ?? 0) + 1, total: p.items.length } }))
        setProgress({ done, total, label: `${p.folder} · ${it.name}` })
      }
      if (cancelRef.current) break
    }

    if (cancelRef.current) { setPhase('pick'); return }

    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${month}_薪資明細.zip`
    document.body.appendChild(a) // ★ 掛入 DOM 先 click —— 部分瀏覽器唔掛就唔跟 download 檔名
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    setZipOk(true)

    fetch('/api/payroll-runs/bulk-export-audit', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ periodMonth: month, runIds: plan.map(p => p.run.id), pdfCount, skipped: probs.length }),
    }).catch(() => { /* audit 失敗唔阻下載 */ })

    setProblems(probs)
    setPhase('done')
  }

  const close = () => { cancelRef.current = true; setOpen(false); setPhase('pick') }
  const chosenCount = (runs ?? []).filter(r => picked[r.id]).length

  return (
    <>
      <button type="button" onClick={() => { setOpen(true); setPhase('pick') }}
        className="px-4 py-2 rounded-md border bg-white hover:bg-slate-50 text-sm font-semibold transition-colors">
        📦 一鍵匯出全部糧單
      </button>
      <div ref={frameHost} />
      {open && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={phase === 'running' ? undefined : close}>
          <div className="bg-white rounded-xl p-5 w-full max-w-lg space-y-4 max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
            {phase === 'pick' && (<>
              <div className="text-lg font-bold">一鍵匯出全部糧單（PDF）</div>
              <div className="text-sm text-muted-foreground">每間診所一個文件夾，每個員工一份薪資明細 PDF，打包成一個 ZIP。</div>
              <label className="flex items-center gap-2 text-sm">月份
                <select value={month} onChange={e => setMonth(e.target.value)} className="px-2 py-2 rounded-md border">
                  {months.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <div className="space-y-2">
                <div className="text-sm font-semibold">計糧單</div>
                {runs === null && <div className="text-sm text-muted-foreground">載入中…</div>}
                {runs?.length === 0 && <div className="text-sm text-muted-foreground">呢個月未有你睇得到嘅計糧單</div>}
                {runs?.map(r => (
                  <label key={r.id} className="flex items-center gap-3 px-3 py-2 border rounded-lg text-sm">
                    <input type="checkbox" checked={!!picked[r.id]} onChange={e => setPicked(p => ({ ...p, [r.id]: e.target.checked }))} className="w-4 h-4" />
                    <span className="flex-1">{r.clinic?.name ?? '全部診所'}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${r.status === 'DRAFT' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={withXlsx} onChange={e => setWithXlsx(e.target.checked)} className="w-4 h-4" />
                每個文件夾加一份該店計糧總表 Excel
              </label>
              <div className="text-xs text-muted-foreground bg-slate-50 border rounded-md p-2 leading-relaxed">
                草稿都會匯出（先發畀員工確認）。只會包你有權限睇嘅計糧單同員工 —— 薪酬保密員工只有負責人匯出先會包埋。
                喺呢部電腦逐份砌，每份約 1–2 秒，期間唔好關呢頁。
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className="px-4 py-2 rounded-md border text-sm min-h-[44px]">取消</button>
                <button type="button" onClick={start} disabled={!chosenCount}
                  className="px-4 py-2 rounded-md bg-brand text-white text-sm font-semibold min-h-[44px] disabled:opacity-50">
                  開始匯出（{chosenCount} 間）
                </button>
              </div>
            </>)}
            {phase === 'running' && (<>
              <div className="text-lg font-bold">產生緊薪資明細 PDF…</div>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span className="truncate">{progress.label}</span><span>{progress.done} / {progress.total}</span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-200 overflow-hidden">
                <div className="h-full bg-brand transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <div className="space-y-1 text-sm">
                {(runs ?? []).filter(r => picked[r.id]).map(r => {
                  const pr = perRun[r.id]
                  const finished = pr && pr.done >= pr.total
                  return (
                    <div key={r.id} className={`flex justify-between px-3 py-2 rounded-md ${finished ? 'bg-green-50' : 'bg-slate-50'}`}>
                      <span>{r.clinic?.name ?? '全部診所'}</span>
                      <span>{pr ? `${pr.done} / ${pr.total}${finished ? ' 完成' : ''}` : '等候中'}</span>
                    </div>
                  )
                })}
              </div>
              <div className="text-xs text-muted-foreground">某個員工出錯會跳過、最後列出嚟，唔會成個失敗。</div>
              <div className="flex justify-end">
                <button type="button" onClick={() => { cancelRef.current = true }} className="px-4 py-2 rounded-md border text-sm min-h-[44px]">取消</button>
              </div>
            </>)}
            {phase === 'done' && (<>
              <div className="text-lg font-bold">{zipOk ? `已下載 ${month}_薪資明細.zip` : '匯出未完成'}</div>
              {zipOk && problems.length === 0
                ? <div className="text-sm text-green-700">全部 {progress.total} 份完成。</div>
                : (
                  <div className="text-sm">
                    <div className="text-amber-700 mb-1">以下 {problems.length} 項冇包入：</div>
                    <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                )}
              <div className="flex justify-end">
                <button type="button" onClick={close} className="px-4 py-2 rounded-md bg-brand text-white text-sm min-h-[44px]">完成</button>
              </div>
            </>)}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
