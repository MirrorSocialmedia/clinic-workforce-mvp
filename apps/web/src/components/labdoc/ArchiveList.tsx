'use client'

/**
 * ★ cwm-labdoc P1（CHUNK 6）：檔案庫 /lab-docs/archive（§4.3 檔案庫畫面）
 *
 * - 篩選：類型（invoice／月結單）、診所、醫生、月份（docDate 或 statementMonth）、狀態
 *   ＋搜尋（單號／Lab 編號／病人編號 — API `q` 比 docNo/labNameRaw/customerNoRaw）
 *   （Lab／上傳人 篩選 = P4 lab-profiles API＋用戶清單先開，P1 以 q 搜尋覆蓋 Lab）
 * - 結果：電腦表格（縮圖 48px）／手機卡片；每頁 = API pageSize；按日期新到舊（API 排序）
 * - 已作廢、DUPLICATE、SUPERSEDED 都顯示（灰色＋狀態原因）— 存底唔刪（B7）
 * - 撳行 → LabDocViewer（共用檢視器）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileText, Loader2, RotateCcw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api-client'
import { DOC_STATUS_META, fmtMoney, hkDate, hkDateTime, kindLabel, statusMeta } from './status-meta'
import type { ListDoc } from './InvoiceList'
import LabDocViewer from './LabDocViewer'

interface ListResp {
  items: ListDoc[]
  total: number
  page: number
  pageSize: number
}

interface Filters {
  q: string
  kind: '' | 'INVOICE' | 'STATEMENT'
  status: string
  month: string
  clinicId: string
  providerId: string
}

const EMPTY: Filters = { q: '', kind: '', status: '', month: '', clinicId: '', providerId: '' }

const STATUS_OPTIONS = Object.entries(DOC_STATUS_META)
  // 檔案庫常用狀態排前
  .sort((a, b) => a[0].localeCompare(b[0]))

export default function ArchiveList({ clinicNames, providerNames }: {
  clinicNames: Record<string, string>
  providerNames: Record<string, string>
}) {
  const [f, setF] = useState<Filters>(EMPTY)
  const [items, setItems] = useState<ListDoc[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [viewDoc, setViewDoc] = useState<{ id: string; name?: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 篩選 300ms debounce（打字唔使每字發 request）；mount 首次由入面個 effect 一次性 load(1)
  const firstFilterRef = useRef(true)
  useEffect(() => {
    if (firstFilterRef.current) {
      firstFilterRef.current = false
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => load(1), 300)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f])

  const load = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const sp = new URLSearchParams()
      if (f.q) sp.set('q', f.q)
      if (f.kind) sp.set('kind', f.kind)
      if (f.status) sp.set('status', f.status)
      if (f.month) sp.set('month', f.month)
      if (f.clinicId) sp.set('clinicId', f.clinicId)
      if (f.providerId) sp.set('providerId', f.providerId)
      sp.set('page', String(p))
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
  }, [f])

  // 首次載入
  useEffect(() => {
    load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasFilter = f.q || f.kind || f.status || f.month || f.clinicId || f.providerId

  const rowDate = (d: ListDoc) =>
    d.kind === 'STATEMENT' ? d.statementMonth || '—' : hkDate(d.docDate ?? d.deliveryDate) || hkDate(d.uploadedAt)

  const thumbSrc = (d: ListDoc) =>
    d.firstFileId && d.firstPageNo
      ? `/api/lab-docs/files/${d.firstFileId}/pages/${d.firstPageNo}?v=thumb`
      : null

  return (
    <div className="space-y-3">
      {/* 搜尋 */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={f.q}
          onChange={(e) => setF({ ...f, q: e.target.value })}
          placeholder="搜尋單號／Lab 編號／病人編號"
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
      </div>

      {/* 篩選 */}
      <div className="flex flex-wrap gap-2">
        <select
          value={f.kind}
          onChange={(e) => setF({ ...f, kind: e.target.value as Filters['kind'] })}
          className="px-2.5 py-2 rounded-lg border bg-card text-sm"
          aria-label="類型"
        >
          <option value="">全部類型</option>
          <option value="INVOICE">到貨單</option>
          <option value="STATEMENT">月結單</option>
        </select>
        <select
          value={f.status}
          onChange={(e) => setF({ ...f, status: e.target.value })}
          className="px-2.5 py-2 rounded-lg border bg-card text-sm"
          aria-label="狀態"
        >
          <option value="">全部狀態</option>
          {STATUS_OPTIONS.map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <input
          type="month"
          value={f.month}
          onChange={(e) => setF({ ...f, month: e.target.value })}
          className="px-2.5 py-2 rounded-lg border bg-card text-sm"
          aria-label="月份"
        />
        <select
          value={f.clinicId}
          onChange={(e) => setF({ ...f, clinicId: e.target.value })}
          className="px-2.5 py-2 rounded-lg border bg-card text-sm max-w-[140px]"
          aria-label="診所"
          disabled={Object.keys(clinicNames).length === 0}
        >
          <option value="">全部診所</option>
          {Object.entries(clinicNames).map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <select
          value={f.providerId}
          onChange={(e) => setF({ ...f, providerId: e.target.value })}
          className="px-2.5 py-2 rounded-lg border bg-card text-sm max-w-[140px]"
          aria-label="醫生"
          disabled={Object.keys(providerNames).length === 0}
        >
          <option value="">全部醫生</option>
          {Object.entries(providerNames).map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        {hasFilter && (
          <button
            onClick={() => setF(EMPTY)}
            className="px-2.5 py-2 rounded-lg border text-sm text-muted-foreground hover:bg-accent flex items-center gap-1"
          >
            <RotateCcw size={13} /> 重設
          </button>
        )}
      </div>

      {/* 手機：卡片 */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
            <Loader2 size={16} className="animate-spin mr-2" /> 載入中…
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm">
            <FileText size={32} className="mx-auto mb-2 opacity-40" />
            冇符合嘅檔案
          </div>
        ) : (
          items.map((d) => {
            const sm = statusMeta(d.status)
            return (
              <button
                key={d.id}
                onClick={() => setViewDoc({ id: d.id, name: d.uploadedByName ?? undefined })}
                className={`w-full text-left rounded-xl border bg-card p-3 flex gap-3 active:bg-accent ${sm.dimmed ? 'opacity-60' : ''}`}
              >
                <Thumb src={thumbSrc(d)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium truncate text-sm">
                      {d.docNo ?? '未識別'}
                      <span className="text-xs text-muted-foreground font-normal ml-1.5">{kindLabel(d.kind)}</span>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium flex-shrink-0 ${sm.cls}`}>{sm.label}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    {d.labName ?? d.labNameRaw ?? 'Lab 未識別'}
                    {d.clinicId && clinicNames[d.clinicId] ? ` · ${clinicNames[d.clinicId]}` : ''}
                    {d.providerId && providerNames[d.providerId] ? ` · ${providerNames[d.providerId]}` : ''}
                  </div>
                  <div className="flex items-center justify-between mt-1.5 text-xs">
                    <span>{rowDate(d)}</span>
                    <span className="font-medium">{fmtMoney(d.total)}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1 truncate">
                    上傳：{d.uploadedByName ?? '—'} {hkDateTime(d.uploadedAt)}
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* 電腦：表格（§4.3：縮圖 48px） */}
      <div className="hidden md:block rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium"></th>
              <th className="px-3 py-2 font-medium">類型</th>
              <th className="px-3 py-2 font-medium">Lab</th>
              <th className="px-3 py-2 font-medium">診所</th>
              <th className="px-3 py-2 font-medium">醫生</th>
              <th className="px-3 py-2 font-medium">單號</th>
              <th className="px-3 py-2 font-medium">日期</th>
              <th className="px-3 py-2 font-medium text-right">總數</th>
              <th className="px-3 py-2 font-medium">狀態</th>
              <th className="px-3 py-2 font-medium">上傳人</th>
              <th className="px-3 py-2 font-medium">上傳時間</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">
                  <Loader2 size={16} className="animate-spin inline mr-2" /> 載入中…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">
                  冇符合嘅檔案
                </td>
              </tr>
            ) : (
              items.map((d) => {
                const sm = statusMeta(d.status)
                return (
                  <tr
                    key={d.id}
                    onClick={() => setViewDoc({ id: d.id, name: d.uploadedByName ?? undefined })}
                    className={`border-b last:border-0 hover:bg-accent/50 cursor-pointer ${sm.dimmed ? 'opacity-60' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <Thumb src={thumbSrc(d)} size={48} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{kindLabel(d.kind)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{d.labName ?? d.labNameRaw ?? '未識別'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{d.clinicId ? clinicNames[d.clinicId] ?? '未識別' : '未識別'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{d.providerId ? providerNames[d.providerId] ?? '未識別' : '未識別'}</td>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{d.docNo ?? '未識別'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{rowDate(d)}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{fmtMoney(d.total)}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sm.cls}`}>{sm.label}</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{d.uploadedByName ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{hkDateTime(d.uploadedAt)}</td>
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

function Thumb({ src, size = 48 }: { src: string | null; size?: number }) {
  const [err, setErr] = useState(false)
  if (!src || err) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-md bg-muted flex items-center justify-center flex-shrink-0"
      >
        <FileText size={size / 2.5} className="text-muted-foreground opacity-50" />
      </div>
    )
  }
  return (
    <img
      src={src}
      alt=""
      style={{ width: size, height: size }}
      className="rounded-md object-cover border bg-white flex-shrink-0"
      loading="lazy"
      onError={() => setErr(true)}
    />
  )
}
