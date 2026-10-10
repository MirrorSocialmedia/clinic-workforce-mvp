'use client'

/**
 * ★ cwm-labdoc P2 CHUNK 5：/lab-docs 待處理分頁（§9）
 *
 * - GET /api/lab-docs/pending（7 類別 badge；month 過濾）
 * - 類別 chips 過濾；表格顯示 items
 * - 動作（§9／§11）：
 *   AMOUNT_REVIEW →「已覆核」POST /api/lab-docs/:id/review-amount（optimistic lock version）
 *   NEW_PAYEE     →「記住」POST /api/lab-docs/:id/payee
 *   EXTRACT_FAILED→「再讀」POST /api/lab-docs/:id/retry
 *   其餘 → deep-link 去處理（到貨單對數流程／成本錄入）
 * - 匯出 CSV（§9：lab_statement；公式注入守門喺 API 層）
 */

import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import { PENDING_CATEGORY_LABELS, type PendingCategory, type PendingItem } from '@/lib/labdoc/pending'
import type { LabDocsMe } from './LabDocsTabs'

interface PendingData {
  categories: Array<{ key: PendingCategory; count: number; items: PendingItem[] }>
  total: number
}

interface Props {
  me: LabDocsMe
  clinicNames: Record<string, string>
}

const MONTH_RE = /^\d{4}-\d{2}$/

export default function PendingList({ me, clinicNames }: Props) {
  const [data, setData] = useState<PendingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [month, setMonth] = useState('')
  const [activeCat, setActiveCat] = useState<PendingCategory | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const canStatement = hasPermission(me.role, 'lab_statement', me.grant, me.deny)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/lab-docs/pending${month ? `?month=${month}` : ''}`
      const d = await apiFetch<PendingData>(url)
      setData(d)
    } catch (e: any) {
      setError(e?.message ?? '載入失敗')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [month])

  useEffect(() => {
    load()
  }, [load])

  const onMonthChange = (v: string) => {
    setMsg(null)
    if (v === '' || MONTH_RE.test(v)) {
      setMonth(v)
      setActiveCat(null)
    }
  }

  const doResolve = async (id: string, path: string, body: Record<string, unknown>, doneMsg: string) => {
    setBusyId(id)
    setMsg(null)
    try {
      await apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      setMsg(doneMsg)
      await load()
    } catch (e: any) {
      setMsg(`失敗：${e?.message ?? '未知錯誤'}`)
    } finally {
      setBusyId(null)
    }
  }

  const retry = async (id: string) => {
    setBusyId(id)
    setMsg(null)
    try {
      await apiFetch(`/api/lab-docs/${id}/retry`, { method: 'POST' })
      setMsg('已送再讀（背景處理中）')
      await load()
    } catch (e: any) {
      setMsg(`失敗：${e?.message ?? '未知錯誤'}`)
    } finally {
      setBusyId(null)
    }
  }

  const visible = (data?.categories ?? []).filter((c) => !activeCat || c.key === activeCat)

  // deep-link：按類別去處理（對數流程喺到貨單；已鎖調整喺成本錄入）
  const deepLink = (key: PendingCategory, it?: { docId: string | null; sectionId?: string | null }): { href: string; label: string } => {
    switch (key) {
      case 'LOCKED_ADJUST':
      case 'NOT_RECEIVED':
      case 'RECEIVED_NO_INVOICE':
        return { href: '/cost-entry', label: key === 'LOCKED_ADJUST' ? '去調整' : '去成本' }
      case 'STATEMENT_DIFF':
      case 'MISSING_IN_SYSTEM':
      case 'NOT_ON_STATEMENT':
        if (it?.docId && it.sectionId) return { href: `/lab-docs/statements/${it.docId}/sections/${it.sectionId}`, label: '去分段' }
        if (it?.docId) return { href: `/lab-docs/statements/${it.docId}`, label: '去月結單' }
        return { href: '/lab-docs?tab=statements', label: '去處理' }
      default:
        if (it?.docId) return { href: `/lab-docs/invoices/${it.docId}`, label: '去對數' }
        return { href: '/lab-docs', label: '去處理' }
    }
  }

  const btn =
    'px-2.5 py-1 rounded-md text-xs font-medium bg-brand text-white hover:opacity-90 disabled:opacity-40'

  return (
    <div className="space-y-3">
      {/* 工具列：month 過濾＋CSV */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="month"
          value={month}
          onChange={(e) => onMonthChange(e.target.value)}
          className="border rounded-md px-2 py-1.5 text-sm bg-card"
          aria-label="月份過濾"
        />
        {month && (
          <button className="text-xs text-muted-foreground underline" onClick={() => onMonthChange('')}>
            清除月份
          </button>
        )}
        <div className="flex-1" />
        {canStatement && (
          <a
            href={`/api/lab-docs/pending?format=csv${month ? `&month=${month}` : ''}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border bg-card hover:bg-accent"
          >
            <Download size={15} />
            匯出 CSV
          </a>
        )}
        <button
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border bg-card hover:bg-accent"
          onClick={() => load()}
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          重新載入
        </button>
      </div>

      {msg && <div className="text-sm px-3 py-2 rounded-md bg-accent text-accent-foreground">{msg}</div>}
      {error && (
        <div className="text-sm px-3 py-2 rounded-md bg-red-50 text-red-700 border border-red-200">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="text-sm text-muted-foreground py-10 text-center">載入中…</div>
      ) : (
        <>
          {/* 類別 chips（badge = count） */}
          <div className="flex flex-wrap gap-2">
            <button
              className={`px-3 py-1.5 rounded-full text-sm border ${
                activeCat === null ? 'bg-brand text-white border-brand' : 'bg-card text-muted-foreground hover:bg-accent'
              }`}
              onClick={() => setActiveCat(null)}
            >
              全部（{data?.total ?? 0}）
            </button>
            {((data?.categories ?? []) as Array<{ key: PendingCategory; count: number }>).map((c) => (
              <button
                key={c.key}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  activeCat === c.key ? 'bg-brand text-white border-brand' : 'bg-card text-muted-foreground hover:bg-accent'
                }`}
                onClick={() => setActiveCat(c.key)}
              >
                {PENDING_CATEGORY_LABELS[c.key]}（{c.count}）
              </button>
            ))}
          </div>

          {/* 表格 */}
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">類別</th>
                  <th className="px-3 py-2">Lab</th>
                  <th className="px-3 py-2">單號</th>
                  <th className="px-3 py-2">日期</th>
                  <th className="px-3 py-2">金額</th>
                  <th className="px-3 py-2">病人</th>
                  <th className="px-3 py-2">日齡</th>
                  <th className="px-3 py-2">備註</th>
                  <th className="px-3 py-2">診所</th>
                  <th className="px-3 py-2 text-right">動作</th>
                </tr>
              </thead>
              <tbody>
                {visible.flatMap((c) =>
                  c.items.map((it) => (
                    <tr key={`${c.key}:${it.id}`} className="border-t hover:bg-accent/40">
                      <td className="px-3 py-2 whitespace-nowrap">{PENDING_CATEGORY_LABELS[c.key]}</td>
                      <td className="px-3 py-2">{it.labName ?? '未識別'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{it.docNo ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{it.date ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{it.amount !== null ? it.amount.toFixed(2) : '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{it.patientCode ?? '—'}</td>
                      <td className="px-3 py-2">{it.days !== null ? `${it.days} 日` : '—'}</td>
                      <td className="px-3 py-2 max-w-[240px] truncate" title={it.extra ?? undefined}>
                        {it.extra ?? '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {it.clinicId ? clinicNames[it.clinicId] ?? it.clinicId : '—'}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {c.key === 'AMOUNT_REVIEW' && (
                          <button
                            className={btn}
                            disabled={busyId === it.id}
                            onClick={() =>
                              doResolve(it.id, `/api/lab-docs/${it.id}/review-amount`, { version: it.version ?? 0 }, '已標記覆核')
                            }
                          >
                            已覆核
                          </button>
                        )}
                        {c.key === 'NEW_PAYEE' && (
                          <button
                            className={btn}
                            disabled={busyId === it.id}
                            onClick={() =>
                              doResolve(it.id, `/api/lab-docs/${it.id}/payee`, { version: it.version ?? 0 }, '已記住收款人')
                            }
                          >
                            記住
                          </button>
                        )}
                        {c.key === 'EXTRACT_FAILED' && (
                          <button className={btn} disabled={busyId === it.id} onClick={() => retry(it.id)}>
                            再讀
                          </button>
                        )}
                        {c.key !== 'AMOUNT_REVIEW' && c.key !== 'NEW_PAYEE' && c.key !== 'EXTRACT_FAILED' && (
                          <a className={btn} href={deepLink(c.key, it).href}>
                            {deepLink(c.key, it).label}
                          </a>
                        )}
                      </td>
                    </tr>
                  )),
                )}
                {visible.every((c) => c.items.length === 0) && (
                  <tr>
                    <td colSpan={10} className="px-3 py-10 text-center text-muted-foreground">
                      冇待處理項 🎉
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">每類最多顯示 500 項；badge 數字係該類總數。</p>
        </>
      )}
    </div>
  )
}
