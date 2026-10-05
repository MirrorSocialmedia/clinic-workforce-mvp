'use client'

/**
 * ★ cwm-labdoc P1（CHUNK 6）：LabDocViewer — 單據檢視器（共用 component，全屏 modal）
 *
 * §4.3 檔案檢視器：
 * - 左／上：頁面圖（縮放 1×–4×、拖動、旋轉 90° 只係顯示、上一頁／下一頁、頁碼；
 *   手機左右掃轉頁、雙指縮放）
 * - 右／下：單據資料（Lab、診所、醫生、單號、日期、總數、狀態、上傳人）
 *   ＋「下載原檔」掣（audit 由 API 側寫 LAB_DOC_FILE_DOWNLOAD）
 * - 頁圖一律 `<img src>` 同源載入（§4.3：唔准 public URL／signed URL／base64 塞 JSON）
 * - 已 purge（purgedAt）→ 灰色佔位＋「原檔已按保留政策（7 年）於 {日期} 刪除」（410 文案）
 *
 * 入口（P1）：檔案庫列表行。P2 再擴：成本錄入「單」icon、invoice 對數頁「睇相」、
 * 月結單「睇原檔」、待處理「睇單」（§4.3 第 3 點）——component 已自足，加入口即可。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileImage,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  RotateCw,
  X,
} from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { fmtMoney, hkDate, hkDateTime, kindLabel, statusMeta } from './status-meta'

interface ViewerPage {
  id: string
  pageNo: number
  sortOrder: number
  file: {
    id: string
    mime: string
    pageCount: number
    hasTextLayer: boolean
    purgedAt: string | null
  }
}

interface ViewerDocument {
  id: string
  kind: string
  status: string
  labName: string | null
  labNameRaw: string | null
  clinicId: string | null
  providerId: string | null
  docNo: string | null
  docDate: string | null
  deliveryDate: string | null
  statementMonth: string | null
  total: string | null
  readIssues: unknown
  voidReason: string | null
  uploadedBy: string
  uploadedAt?: string
  createdAt: string
}

interface Props {
  docId: string
  onClose: () => void
  /** 列表行已知道嘅 meta（列表 API 有 uploadedByName，詳情 API 只有 id） */
  meta?: { uploadedByName?: string | null }
}

const MIN_ZOOM = 1
const MAX_ZOOM = 4

function pageImgUrl(p: ViewerPage): string {
  return `/api/lab-docs/files/${p.file.id}/pages/${p.pageNo}?v=display`
}

export default function LabDocViewer({ docId, onClose, meta }: Props) {
  const [doc, setDoc] = useState<ViewerDocument | null>(null)
  const [pages, setPages] = useState<ViewerPage[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const [idx, setIdx] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [rot, setRot] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [imgState, setImgState] = useState<'loading' | 'ok' | 'purged' | 'error'>('loading')
  const [imgMsg, setImgMsg] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const [dlMsg, setDlMsg] = useState<string | null>(null)

  const [clinicNames, setClinicNames] = useState<Record<string, string>>({})
  const [providerNames, setProviderNames] = useState<Record<string, string>>({})

  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const touchRef = useRef<{ x: number; y: number; t: number; pinch: number | null; panStart: { x: number; y: number } | null }>({
    x: 0,
    y: 0,
    t: 0,
    pinch: null,
    panStart: null,
  })

  // —— 載入詳情＋名稱對照（graceful：名稱 API 失敗唔阻檢視） ——
  useEffect(() => {
    let alive = true
    setDoc(null)
    setPages([])
    setLoadErr(null)
    apiFetch<{ document: ViewerDocument; pages: ViewerPage[] }>(`/api/lab-docs/${docId}`)
      .then((data) => {
        if (!alive) return
        setDoc(data.document)
        setPages(data.pages)
      })
      .catch((e) => alive && setLoadErr(e.message || '單據載入失敗'))
    apiFetch<{ clinics: Array<{ id: string; name: string }> }>('/api/clinics')
      .then((d) => alive && setClinicNames(Object.fromEntries((d.clinics || []).map((c) => [c.id, c.name]))))
      .catch(() => { /* graceful */ })
    apiFetch<{ providers: Array<{ id: string; name: string }> }>('/api/providers')
      .then((d) => alive && setProviderNames(Object.fromEntries((d.providers || []).map((p) => [p.id, p.name]))))
      .catch(() => { /* graceful */ })
    return () => { alive = false }
  }, [docId])

  const page = pages[idx] ?? null

  // 頁圖狀態：purge 直接佔位；其餘由 <img> onLoad/onError 推進
  useEffect(() => {
    if (!page) return
    if (page.file.purgedAt) {
      setImgState('purged')
      setImgMsg(`原檔已按保留政策（7 年）於 ${hkDate(page.file.purgedAt)} 刪除`)
      return
    }
    setImgState('loading')
    setImgMsg('')
  }, [page, retryKey])

  const handleImgError = useCallback(async () => {
    if (!page) return
    if (page.file.purgedAt) {
      setImgState('purged')
      setImgMsg(`原檔已按保留政策（7 年）於 ${hkDate(page.file.purgedAt)} 刪除`)
      return
    }
    try {
      const r = await fetch(pageImgUrl(page), { credentials: 'include' })
      if (r.status === 410) {
        const j = await r.json().catch(() => null)
        setImgState('purged')
        setImgMsg(j?.error || '原檔已按保留政策刪除')
      } else if (!r.ok) {
        setImgState('error')
        setImgMsg(`頁圖載入失敗（${r.status}）`)
      } else {
        setImgState('error')
        setImgMsg('頁圖載入失敗，請重試')
      }
    } catch {
      setImgState('error')
      setImgMsg('頁圖載入失敗（網絡錯誤）')
    }
  }, [page])

  // —— 鍵盤：Esc 關、←/→ 轉頁 ——
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && idx > 0) setIdx(idx - 1)
      else if (e.key === 'ArrowRight' && idx < pages.length - 1) setIdx(idx + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [idx, pages.length, onClose])

  const goPage = useCallback(
    (n: number) => {
      if (n < 0 || n >= pages.length) return
      setIdx(n)
      setPan({ x: 0, y: 0 })
    },
    [pages.length],
  )

  const zoomBy = useCallback((d: number) => {
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((z + d) * 100) / 100)))
  }, [])

  const resetView = useCallback(() => {
    setZoom(1)
    setRot(0)
    setPan({ x: 0, y: 0 })
  }, [])

  // —— 滑鼠拖動（zoom > 1 先有效；pointerType=mouse 先處理，touch 用 touch 事件） ——
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || zoom <= MIN_ZOOM) return
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setPan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) })
  }
  const onPointerUp = () => { dragRef.current = null }

  // —— 觸控：單指橫掃轉頁（zoom=1）、雙指縮放 ——
  const onTouchStart = (e: React.TouchEvent) => {
    const st = touchRef.current
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      st.pinch = Math.hypot(dx, dy)
      st.panStart = null
      return
    }
    st.pinch = null
    st.x = e.touches[0].clientX
    st.y = e.touches[0].clientY
    st.t = Date.now()
    // zoom > 1 時單指拖動 = pan（錨點 = 開始時嘅 pan）
    st.panStart = zoom > MIN_ZOOM ? { ...pan } : null
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const st = touchRef.current
    if (e.touches.length === 2 && st.pinch) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.hypot(dx, dy)
      const ratio = dist / st.pinch
      if (ratio > 0) setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * ratio)))
      st.pinch = dist
      return
    }
    if (e.touches.length === 1 && st.panStart) {
      setPan({
        x: st.panStart.x + (e.touches[0].clientX - st.x),
        y: st.panStart.y + (e.touches[0].clientY - st.y),
      })
    }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const st = touchRef.current
    if (e.touches.length > 0) return
    st.pinch = null
    const wasPan = st.panStart !== null
    st.panStart = null
    if (wasPan) return // pan 過就唔當 swipe
    const dx = (e.changedTouches[0]?.clientX ?? st.x) - st.x
    const dy = (e.changedTouches[0]?.clientY ?? st.y) - st.y
    if (Date.now() - st.t < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) goPage(idx + 1)
      else goPage(idx - 1)
    }
    st.x = 0; st.y = 0
  }

  // —— 下載原檔（§4.3：original 讀 API；410 = 已 purge） ——
  const originalUrl = page ? `/api/lab-docs/files/${page.file.id}/original` : ''
  const downloadOriginal = async () => {
    if (!doc || !page) return
    setDownloading(true)
    setDlMsg(null)
    try {
      const r = await fetch(originalUrl, { credentials: 'include' })
      if (r.status === 410) {
        const j = await r.json().catch(() => null)
        setDlMsg(j?.error || '原檔已按保留政策刪除')
        return
      }
      if (!r.ok) {
        const j = await r.json().catch(() => null)
        setDlMsg(j?.error || `下載失敗（${r.status}）`)
        return
      }
      const blob = await r.blob()
      const ext = r.headers.get('content-type')?.includes('pdf') ? 'pdf' : 'jpg'
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `labdoc-${doc.id}.${ext}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } catch {
      setDlMsg('下載失敗（網絡錯誤）')
    } finally {
      setDownloading(false)
    }
  }

  const info = useMemo(() => {
    if (!doc) return null
    const sm = statusMeta(doc.status)
    return (
      <div className="space-y-2 text-sm">
        <InfoRow label="類型" value={kindLabel(doc.kind)} />
        <InfoRow label="Lab" value={doc.labName ?? doc.labNameRaw ?? '（未識別）'} />
        <InfoRow label="診所" value={doc.clinicId ? clinicNames[doc.clinicId] ?? '（未識別）' : '（未識別）'} />
        <InfoRow label="醫生" value={doc.providerId ? providerNames[doc.providerId] ?? '（未識別）' : '（未識別）'} />
        <InfoRow label="單號" value={doc.docNo ?? '（未識別）'} />
        <InfoRow
          label="日期"
          value={
            doc.kind === 'STATEMENT'
              ? doc.statementMonth || '（未識別）'
              : hkDate(doc.docDate ?? doc.deliveryDate) || '（未識別）'
          }
        />
        <InfoRow label="總數" value={fmtMoney(doc.total)} />
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">狀態</span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sm.cls}`}>{sm.label}</span>
        </div>
        <InfoRow label="上傳人" value={meta?.uploadedByName || '—'} />
        <InfoRow label="上傳時間" value={hkDateTime(doc.createdAt)} />
        <InfoRow label="讀法" value={page?.file.hasTextLayer ? '文字（PDF 有文字層）' : '相（掃描）'} />
        {doc.status === 'VOID' && doc.voidReason && <InfoRow label="作廢原因" value={doc.voidReason} />}
      </div>
    )
  }, [doc, page, clinicNames, providerNames, meta])

  if (loadErr) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center gap-3 text-gray-300 p-8">
          <FileImage size={40} />
          <div>{loadErr}</div>
          <button onClick={onClose} className="mt-2 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700">
            返回
          </button>
        </div>
      </Shell>
    )
  }

  if (!doc || !page) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 text-gray-300">
          <Loader2 size={20} className="animate-spin" /> 載入單據…
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      {/* 頂 bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 bg-black/60 z-10">
        <div className="min-w-0 flex-1 mr-2">
          <div className="text-sm text-white truncate font-medium">
            {doc.docNo || kindLabel(doc.kind)}
            <span className="text-gray-400 font-normal ml-2">
              {doc.labName ?? doc.labNameRaw ?? 'Lab 未識別'}
            </span>
          </div>
        </div>
        <div className="text-xs text-gray-400 tabular-nums mr-2">
          {idx + 1} / {pages.length}
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white"
          aria-label="關閉"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* 頁圖區（手機上／電腦左） */}
        <div
          className="relative flex-1 min-h-0 bg-gray-950 flex items-center justify-center overflow-hidden select-none"
          style={{ touchAction: zoom > MIN_ZOOM ? 'none' : 'pan-y' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onWheel={(e) => zoomBy(e.deltaY < 0 ? 0.25 : -0.25)}
          onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
        >
          {imgState === 'purged' && (
            <div className="flex flex-col items-center justify-center gap-3 p-8 max-w-sm text-center">
              <div className="w-40 h-52 rounded-lg bg-gray-800 flex items-center justify-center">
                <FileImage size={40} className="text-gray-600" />
              </div>
              <div className="text-sm text-gray-400">{imgMsg}</div>
            </div>
          )}
          {imgState === 'error' && (
            <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="w-40 h-52 rounded-lg bg-gray-800 flex items-center justify-center">
                <FileImage size={40} className="text-gray-600" />
              </div>
              <div className="text-sm text-gray-400">{imgMsg}</div>
              <button
                onClick={() => { setRetryKey((k) => k + 1) }}
                className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm flex items-center gap-1.5"
              >
                <RefreshCw size={14} /> 重試
              </button>
            </div>
          )}
          {(imgState === 'loading' || imgState === 'ok') && (
            <>
              {imgState === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-gray-400 pointer-events-none">
                  <Loader2 size={20} className="animate-spin" /> 載入頁 {page.pageNo}…
                </div>
              )}
              <div
                className="max-w-full max-h-full flex items-center justify-center"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${zoom})`, transition: dragRef.current ? 'none' : 'transform 80ms' }}
              >
                <img
                  key={`${page.file.id}-${page.pageNo}-${retryKey}`}
                  src={pageImgUrl(page)}
                  alt={`第 ${page.pageNo} 頁`}
                  className="max-w-full max-h-full object-contain"
                  style={{ maxHeight: 'calc(100vh - 180px)', maxWidth: '100%' }}
                  draggable={false}
                  onLoad={() => setImgState('ok')}
                  onError={handleImgError}
                />
              </div>
            </>
          )}

          {/* 左右翻頁 */}
          {idx > 0 && (
            <button
              onClick={() => goPage(idx - 1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70"
              aria-label="上一頁"
            >
              <ChevronLeft size={22} />
            </button>
          )}
          {idx < pages.length - 1 && (
            <button
              onClick={() => goPage(idx + 1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70"
              aria-label="下一頁"
            >
              <ChevronRight size={22} />
            </button>
          )}

          {/* 底 bar：縮放／旋轉 */}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-full bg-black/60 text-white">
            <button onClick={() => zoomBy(-0.25)} className="p-1.5 hover:bg-gray-800 rounded-full" aria-label="縮小" disabled={zoom <= MIN_ZOOM}>
              <Minimize2 size={15} />
            </button>
            <span className="text-xs tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => zoomBy(0.25)} className="p-1.5 hover:bg-gray-800 rounded-full" aria-label="放大" disabled={zoom >= MAX_ZOOM}>
              <Maximize2 size={15} />
            </button>
            <button onClick={() => setRot((r) => (r + 90) % 360)} className="p-1.5 hover:bg-gray-800 rounded-full" aria-label="旋轉 90°">
              <RotateCw size={15} />
            </button>
            {(zoom > MIN_ZOOM || rot !== 0 || pan.x !== 0 || pan.y !== 0) && (
              <button onClick={resetView} className="p-1.5 hover:bg-gray-800 rounded-full text-gray-300" aria-label="重設視圖" title="重設視圖">
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        </div>

        {/* 資料面板（手機下／電腦右） */}
        <div className="md:w-80 md:flex-shrink-0 bg-card border-t md:border-t-0 md:border-l border-gray-200 overflow-y-auto max-h-[38%] md:max-h-none">
          <div className="p-4">
            {info}
            <button
              onClick={downloadOriginal}
              disabled={downloading || !originalUrl}
              className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-brand text-white hover:opacity-90 disabled:opacity-50 text-sm font-medium"
            >
              {downloading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              下載原檔
            </button>
            {dlMsg && <div className="mt-2 text-xs text-red-600">{dlMsg}</div>}
          </div>
        </div>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] bg-gray-950 flex flex-col" role="dialog" aria-modal="true">
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-right break-all min-w-0">{value}</span>
    </div>
  )
}
