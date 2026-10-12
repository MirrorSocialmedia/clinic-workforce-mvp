'use client'

/**
 * ★ cwm-labdoc P1（CHUNK 6）：到貨單分頁（§12.1 P1 子集）
 *
 * - 「影 invoice」（相機、多張；前端 canvas 轉 JPEG：長邊 ≤2400、q0.85、重畫去 EXIF — §4.2）
 * - 「上傳 PDF」（原檔直傳）
 * - 前端預檢：≤20 檔、單檔 ≤15MB、總數 ≤60MB（超過先唔好發）
 * - idempotencyKey = UUID（B15）；409 重複 → 顯示 API 訊息＋直接開原本嗰張（duplicateOf）
 * - 列表：GET /api/lab-docs?kind=INVOICE（20/頁，新到舊）；手機卡片／電腦表格
 *   卡片：Lab、單號、診所、醫生、總數、狀態 chip、上傳人/時間（§12.1；P1 未讀單 →
 *   診所/醫生/病人數未識別就顯示「未識別」）
 * - 2026-10-10：kind='STATEMENT' 共用做月結單分頁（多張相／多個 PDF＝一份）；
 *   撳單據 → 對數頁（/lab-docs/invoices/[id]｜/lab-docs/statements/[id]）
 * - 2026-10-11：篩診所／月份；預設唔顯示已作廢（剔「顯示已作廢」先見）；
 *   月結單嘅診所／醫生／總數／確認進度由分段計（sectionSummary）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, ChevronLeft, ChevronRight, FileText, ImagePlus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api-client'
import { fmtMoney, hkDate, hkDateTime, statusMeta } from './status-meta'
import LabDocViewer from './LabDocViewer'
import StatementProgressCards from './StatementProgressCards'
import { todayHK } from '@/lib/hk-date'
import { lastMonthOf } from '@/lib/labdoc/statement-progress'

export interface ListDoc {
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
  pageCount: number
  firstFileId: string | null
  firstPageNo: number | null
  uploadedBy: string
  uploadedByName: string | null
  uploadedAt: string
  duplicateOfId: string | null
  /** 排隊中（UPLOADED）第幾位 */
  queuePosition?: number | null
  sectionSummary?: {
    clinicIds: string[]
    providerIds: string[]
    sectionCount: number
    confirmedCount: number
    unassignedCount: number
    total: number | null
  } | null
}

/** 排隊中 → 「排隊中 · 第 N 位」；其他照 statusMeta */
function queueMeta(d: ListDoc) {
  const sm = statusMeta(d.status)
  if (d.status === 'UPLOADED' && d.queuePosition) return { ...sm, label: `排隊中 · 第 ${d.queuePosition} 位`, cls: 'bg-teal-50 text-teal-700' }
  return sm
}

/** 名單：兩個以內寫名，多過兩個寫「N 間／N 位醫生」 */
function nameList(ids: string[], names: Record<string, string>, unit: string): string {
  if (ids.length === 0) return ''
  if (ids.length > 2) return `${ids.length} ${unit}`
  return ids.map((x) => names[x] ?? '未識別').join('、')
}

interface ListResp {
  items: ListDoc[]
  total: number
  page: number
  pageSize: number
}

const MAX_FILES = 20
const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_TOTAL_BYTES = 60 * 1024 * 1024
const MAX_EDGE = 2400
const JPEG_QUALITY = 0.85

/** §4.2 相片處理：canvas 重畫 → JPEG（長邊 ≤2400、q0.85、天然去 EXIF） */
async function imageToJpeg(file: File): Promise<File> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('圖片讀取失敗'))
      el.src = url
    })
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 唔支援')
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG 轉碼失敗'))), 'image/jpeg', JPEG_QUALITY)
    })
    const name = (file.name.replace(/\.[^.]+$/, '') || 'invoice') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export default function InvoiceList({ clinicNames, providerNames, kind = 'INVOICE' }: {
  clinicNames: Record<string, string>
  providerNames: Record<string, string>
  kind?: 'INVOICE' | 'STATEMENT'
}) {
  const router = useRouter()
  const isStmt = kind === 'STATEMENT'
  const open = (id: string) => router.push(isStmt ? `/lab-docs/statements/${id}` : `/lab-docs/invoices/${id}`)
  const [items, setItems] = useState<ListDoc[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  // ★ 2026-10-11：KIOSK（店舖機）上傳 → 默認嗰間店；幾間店先要揀
  const [kioskShops, setKioskShops] = useState<Array<{ id: string; name: string }> | null>(null)
  const [kioskShop, setKioskShop] = useState('')
  useEffect(() => {
    apiFetch<{ user: { role: string; clinics?: Array<{ clinicId: string; clinic?: { name?: string; shortName?: string } }> } }>('/api/me')
      .then((d) => {
        if (d.user.role !== 'KIOSK') return
        const shops = (d.user.clinics ?? []).map((c) => ({ id: c.clinicId, name: c.clinic?.name ?? c.clinic?.shortName ?? c.clinicId }))
        setKioskShops(shops)
        if (shops.length === 1) setKioskShop(shops[0].id)
      })
      .catch(() => {})
  }, [])
  const [viewDoc, setViewDoc] = useState<{ id: string; name?: string } | null>(null)
  // 篩選：診所、月份（月結單 = 月結單月份；到貨單 = 單據日期月份）、顯示已作廢
  const [fClinic, setFClinic] = useState('')
  // ★ cwm-labstmtprog-20261012：月結單預設上個月（9 月結單通常 10 月先到）；到貨單照舊全部
  const [fMonth, setFMonth] = useState(() => (kind === 'STATEMENT' ? lastMonthOf(todayHK()) : ''))
  const [showVoid, setShowVoid] = useState(false)
  const [openOnly, setOpenOnly] = useState(false) // ★ 只睇未對（月結單）

  const photoRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const sp = new URLSearchParams({ kind, page: String(p) })
      if (!showVoid) sp.set('hideVoid', '1')
      if (fClinic) sp.set('clinicId', fClinic)
      if (/^\d{4}-\d{2}$/.test(fMonth)) sp.set('month', fMonth)
      if (isStmt && openOnly) sp.set('notReconciled', '1')
      const data = await apiFetch<ListResp>(`/api/lab-docs?${sp.toString()}`)
      setItems(data.items)
      setTotal(data.total)
      setPage(data.page)
      setPageSize(data.pageSize || 20)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [kind, showVoid, fClinic, fMonth, isStmt, openOnly])

  useEffect(() => {
    load(1)
  }, [load])

  // ★ 2026-10-11：有單排緊隊／讀緊 → 每 5 秒刷新（位置會自己減）
  const busyIds = items.filter((d) => d.status === 'UPLOADED' || d.status === 'EXTRACTING').map((d) => d.id).join(',')
  useEffect(() => {
    if (!busyIds) return
    const t = setTimeout(async () => {
      try {
        const sp = new URLSearchParams({ kind, page: String(page) })
        if (!showVoid) sp.set('hideVoid', '1')
        if (fClinic) sp.set('clinicId', fClinic)
        if (/^\d{4}-\d{2}$/.test(fMonth)) sp.set('month', fMonth)
        if (isStmt && openOnly) sp.set('notReconciled', '1')
        const data = await apiFetch<ListResp>(`/api/lab-docs?${sp.toString()}`)
        setItems(data.items)
        setTotal(data.total)
      } catch { /* 下次再試 */ }
    }, 5000)
    return () => clearTimeout(t)
  }, [busyIds, items, kind, page, showVoid, fClinic, fMonth, isStmt, openOnly])

  const handleFiles = async (files: FileList | null, isPhoto: boolean) => {
    if (!files || files.length === 0) return
    if (uploading) return
    const list = Array.from(files)
    if (list.length > MAX_FILES) {
      toast.error(`一次最多上傳 ${MAX_FILES} 個檔`)
      return
    }
    setUploading(true)
    try {
      // 相片先轉 JPEG（去 EXIF）；PDF 原檔
      const processed: File[] = []
      for (const f of list) {
        if (isPhoto) processed.push(await imageToJpeg(f))
        else processed.push(f)
      }
      const totalBytes = processed.reduce((a, f) => a + f.size, 0)
      if (totalBytes > MAX_TOTAL_BYTES) {
        toast.error('全部檔案合共超過 60MB 上限')
        return
      }
      for (let i = 0; i < processed.length; i++) {
        if (processed[i].size > MAX_FILE_BYTES) {
          toast.error(`第 ${i + 1} 個檔超過 15MB 上限`)
          return
        }
      }

      const form = new FormData()
      for (const f of processed) form.append('files', f, f.name)
      form.append('kind', kind)
      if (kioskShop) form.append('clinicId', kioskShop)
      form.append('idempotencyKey', crypto.randomUUID())

      const res = await fetch('/api/lab-docs/upload', { method: 'POST', body: form, credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      if (res.status === 201) {
        const n = (body.documents || []).length
        toast.success(isStmt ? '上傳成功：1 份月結單（讀緊）' : `上傳成功：${n} 單到貨單`)
        load(page)
      } else if (res.status === 409 && body.duplicateOf) {
        // §4.2：呢個檔已經喺 {日期} 由 {人} 上傳過 → 「去睇」= 直接開原本嗰張
        toast.warning(body.message || '重複檔案')
        setViewDoc({ id: body.duplicateOf })
      } else {
        toast.error(body.error || `上傳失敗（${res.status}）`)
      }
    } catch (e) {
      toast.error((e as Error).message || '上傳失敗（網絡錯誤）')
    } finally {
      setUploading(false)
      if (photoRef.current) photoRef.current.value = ''
      if (pdfRef.current) pdfRef.current.value = ''
    }
  }

  const thumb = (d: ListDoc) =>
    d.firstFileId && d.firstPageNo
      ? `/api/lab-docs/files/${d.firstFileId}/pages/${d.firstPageNo}?v=thumb`
      : null

  const meta = (d: ListDoc) => {
    const ss = d.sectionSummary
    // 月結單：由分段計（單頭通常冇，或者只係其中一段）
    if (isStmt && ss && ss.sectionCount > 0) {
      const clinic = nameList(ss.clinicIds, clinicNames, '間診所') || '未揀'
      const docs = nameList(ss.providerIds, providerNames, '位醫生')
      const doctor = docs ? (ss.unassignedCount > 0 ? `${docs}（${ss.unassignedCount} 段未揀）` : docs) : '未揀'
      return {
        lab: d.labName ?? d.labNameRaw ?? '未識別',
        docNo: `${d.statementMonth ?? '月份未識別'} 月結單`,
        clinic,
        doctor,
        sections: ss.sectionCount,
        progress: ss.sectionCount > 1 && ss.confirmedCount < ss.sectionCount && !['VOID', 'SUPERSEDED', 'DUPLICATE'].includes(d.status)
          ? `${ss.confirmedCount} / ${ss.sectionCount} 段確認`
          : null,
        date: hkDate(d.docDate ?? d.deliveryDate) || hkDateTime(d.uploadedAt),
        total: fmtMoney(ss.total),
      }
    }
    return {
      lab: d.labName ?? d.labNameRaw ?? '未識別',
      docNo: isStmt ? `${d.statementMonth ?? '月份未識別'} 月結單` : d.docNo ?? '未識別',
      clinic: d.clinicId ? clinicNames[d.clinicId] ?? '未識別' : '未識別',
      doctor: d.providerId ? providerNames[d.providerId] ?? '未識別' : '未識別',
      sections: 0,
      progress: null as string | null,
      date: hkDate(d.docDate ?? d.deliveryDate) || hkDateTime(d.uploadedAt),
      total: fmtMoney(d.total),
    }
  }
  const clinicOptions = Object.entries(clinicNames).sort((a, b) => a[1].localeCompare(b[1]))

  return (
    <div className="space-y-3">
      {/* 上傳區（§12.1：影 invoice／上傳 PDF） */}
      {kioskShops && (
        <div className="flex flex-wrap items-center gap-2 text-sm rounded-xl border bg-card px-3 py-2">
          <span className="text-muted-foreground">上傳店</span>
          {kioskShops.length === 1 ? (
            <><span className="font-medium">{kioskShops[0].name}</span><span className="text-xs text-muted-foreground">由呢部 KIOSK 上傳 · 自動</span></>
          ) : kioskShops.length === 0 ? (
            <span className="text-red-600">呢部 KIOSK 未設定店舖，唔可以上傳</span>
          ) : (
            <select id="kiosk-shop" className="border rounded px-2 py-1" value={kioskShop} onChange={(e) => setKioskShop(e.target.value)}>
              <option value="">— 揀店舖 —</option>
              {kioskShops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => photoRef.current?.click()}
          disabled={uploading || (!!kioskShops && !kioskShop)}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-brand text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
          {isStmt ? '影月結單' : '影 invoice'}
        </button>
        <button
          onClick={() => pdfRef.current?.click()}
          disabled={uploading || (!!kioskShops && !kioskShop)}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border bg-card text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
          上傳 PDF
        </button>
        <input
          ref={photoRef}
          type="file"
          accept="image/jpeg,image/png"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files, true)}
        />
        <input
          ref={pdfRef}
          type="file"
          accept="application/pdf"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files, false)}
        />
      </div>
      <p className="text-xs text-muted-foreground -mt-1">
        {isStmt ? '一份月結單多頁：一次過揀晒全部相（會合成一份）' : '提示：唔好影到支票'}
      </p>

      {/* 隱藏保留：thumb 預取（避免卡片 hover 閃） — 用 list 首項 key 掛住 */}
      {items.slice(0, 3).map((d) => thumb(d) && (
        <img key={`pf-${d.id}`} src={thumb(d)!} alt="" className="hidden" aria-hidden />
      ))}

      {/* 篩選 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="診所" className="border rounded-lg px-2 py-1.5 bg-card" value={fClinic} onChange={(e) => setFClinic(e.target.value)}>
          <option value="">全部診所</option>
          {clinicOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <input aria-label="月份" type="month" className="border rounded-lg px-2 py-1 bg-card" value={fMonth} onChange={(e) => setFMonth(e.target.value)} />
        {(fClinic || fMonth) && (
          <button className="underline text-muted-foreground" onClick={() => { setFClinic(''); setFMonth('') }}>清除</button>
        )}
        {isStmt && (
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
            只睇未對
          </label>
        )}
        <label className="flex items-center gap-1.5 ml-auto text-muted-foreground">
          <input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} />
          顯示已作廢
        </label>
      </div>

      {/* ★ cwm-labstmtprog-20261012：月結單逐間診所已對／未對（撳卡 = 只睇嗰間） */}
      {isStmt && (
        <StatementProgressCards month={fMonth} clinicNames={clinicNames} selected={fClinic} onPick={setFClinic} reloadKey={items.length + total} />
      )}

      {/* 手機：卡片 */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
            <Loader2 size={16} className="animate-spin mr-2" /> 載入中…
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm">
            <FileText size={32} className="mx-auto mb-2 opacity-40" />
            {isStmt ? '暫未月結單' : '暫未到貨單'}
          </div>
        ) : (
          items.map((d) => {
            const m = meta(d)
            const sm = queueMeta(d)
            return (
              <button
                key={d.id}
                onClick={() => open(d.id)}
                className={`w-full text-left rounded-xl border bg-card p-3 active:bg-accent ${sm.dimmed ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium truncate">{m.docNo}</div>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium flex-shrink-0 ${sm.cls}`}>{m.progress ?? sm.label}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 truncate">
                  {m.lab} · {m.clinic}
                  {m.doctor !== '未識別' ? ` · ${m.doctor}` : ''}
                  {m.sections > 1 ? ` · ${m.sections} 段` : ''}
                </div>
                <div className="flex items-center justify-between mt-1.5 text-xs">
                  <span>{m.date}</span>
                  <span className="font-medium">{m.total}</span>
                </div>
                <div className="text-[11px] text-muted-foreground mt-1 truncate">
                  上傳：{d.uploadedByName ?? '—'} {hkDateTime(d.uploadedAt)}
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* 電腦：表格 */}
      <div className="hidden md:block rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">單號</th>
              <th className="px-3 py-2 font-medium">Lab</th>
              <th className="px-3 py-2 font-medium">診所</th>
              <th className="px-3 py-2 font-medium">醫生</th>
              <th className="px-3 py-2 font-medium">日期</th>
              <th className="px-3 py-2 font-medium text-right">總數</th>
              <th className="px-3 py-2 font-medium">狀態</th>
              <th className="px-3 py-2 font-medium">上傳</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  <Loader2 size={16} className="animate-spin inline mr-2" /> 載入中…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  {isStmt ? '暫未月結單' : '暫未到貨單'}
                </td>
              </tr>
            ) : (
              items.map((d) => {
                const m = meta(d)
                const sm = queueMeta(d)
                return (
                  <tr
                    key={d.id}
                    onClick={() => open(d.id)}
                    className={`border-b last:border-0 hover:bg-accent/50 cursor-pointer ${sm.dimmed ? 'opacity-60' : ''}`}
                  >
                    <td className="px-3 py-2.5 font-medium">{m.docNo}</td>
                    <td className="px-3 py-2.5">{m.lab}</td>
                    <td className="px-3 py-2.5">{m.clinic}</td>
                    <td className="px-3 py-2.5">
                      {m.doctor}
                      {m.sections > 1 && <span className="ml-1.5 px-1.5 rounded bg-blue-50 text-blue-700 text-[11px]">{m.sections} 段</span>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{m.date}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{m.total}</td>
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${sm.cls}`}>{m.progress ?? sm.label}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {d.uploadedByName ?? '—'} {hkDate(d.uploadedAt)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 分頁 */}
      {total > pageSize && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button
            onClick={() => load(page - 1)}
            disabled={loading || page <= 1}
            className="p-2 rounded-lg border bg-card disabled:opacity-40"
            aria-label="上一頁"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-muted-foreground">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 頁（共 {total}）
          </span>
          <button
            onClick={() => load(page + 1)}
            disabled={loading || page * pageSize >= total}
            className="p-2 rounded-lg border bg-card disabled:opacity-40"
            aria-label="下一頁"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {viewDoc && (
        <LabDocViewer docId={viewDoc.id} meta={{ uploadedByName: viewDoc.name ?? null }} onClose={() => setViewDoc(null)} />
      )}
    </div>
  )
}
