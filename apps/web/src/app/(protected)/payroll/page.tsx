'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { toHKDateStr, fmtDateTime } from '@/lib/hk-date'

type RunStatus = 'DRAFT' | 'FINALIZED' | 'EXPORTED'

interface PayrollRun {
  id: string
  clinicId: string | null
  periodMonth: string
  status: RunStatus
  generatedAt: string
  notes: string | null
  clinic: { id: string; name: string } | null
  _count: { items: number }
}

function fmtPeriodMonth(pm: string | Date): string {
  return toHKDateStr(new Date(pm)).slice(0, 7)
}

export default function PayrollListPage() {
  const [runs, setRuns] = useState<PayrollRun[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [periodFilter, setPeriodFilter] = useState<string>('')
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [userRole, setUserRole] = useState<string>('')

  const fetchRuns = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' })
      if (statusFilter) params.set('status', statusFilter)
      if (periodFilter) params.set('periodMonth', periodFilter)

      const res = await fetch(`/api/payroll-runs?${params}`)
      if (res.ok) {
        const data = await res.json()
        setRuns(data.runs)
        setTotalPages(data.totalPages)
      }
    } catch (err) {
      console.error('Failed to fetch payroll runs:', err)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, periodFilter])

  useEffect(() => {
    fetchRuns()
  }, [fetchRuns])

  useEffect(() => {
    fetch('/api/me').then(async r => {
      if (!r.ok) return { user: { role: '' } }
      const d = await r.json()
      setUserRole(d.user?.role || '')
    })
  }, [])

  const canGenerate = userRole === 'OWNER'

  const deleteRun = async (runId: string) => {
    if (!confirm('確定刪除這次計糧？此操作無法復原。')) return
    try {
      const res = await fetch('/api/payroll-runs/' + runId, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) {
        const d = await res.json()
        alert(d.error || '刪除失敗')
        return
      }
      fetchRuns()
    } catch (e) {
      alert('刪除失敗')
    }
  }

  const statusBadge = (status: RunStatus) => {
    const variantMap: Record<RunStatus, 'secondary' | 'default'> = {
      DRAFT: 'secondary',
      FINALIZED: 'default',
      EXPORTED: 'default',
    }
    const labels: Record<RunStatus, string> = {
      DRAFT: '草稿',
      FINALIZED: '已確認',
      EXPORTED: '已匯出',
    }
    return <Badge variant={variantMap[status]}>{labels[status]}</Badge>
  }

  return (
    <div className="p-6" style={{ maxWidth: '1200px' }}>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground tracking-tight" style={{ margin: 0 }}>💰 計糧管理</h1>
        {canGenerate && (
          <Link href="/payroll/new" className="px-4 py-2 rounded-md bg-brand text-white text-sm font-semibold hover:bg-brand-dark transition-colors inline-block" style={{ textDecoration: 'none' }}>
            + 生成計糧
          </Link>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3 mb-5 flex-wrap">
        <div className="flex flex-col md:flex-row gap-3 flex-wrap w-full md:w-auto">
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 w-full md:w-auto"
          >
            <option value="">全部狀態</option>
            <option value="DRAFT">草稿</option>
            <option value="FINALIZED">已確認</option>
            <option value="EXPORTED">已匯出</option>
          </select>

          <input
            type="month"
            value={periodFilter}
            onChange={e => { setPeriodFilter(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 w-full md:w-auto"
          />

          <button
            onClick={fetchRuns}
            className="px-3 py-2 rounded-md g border bg-slate-100 hover:bg-slate-200 text-sm transition-colors w-full md:w-auto"
          >
            查詢
          </button>

          {(statusFilter || periodFilter) && (
            <button
              onClick={() => { setStatusFilter(''); setPeriodFilter(''); setPage(1) }}
              className="px-3 py-2 rounded-md g border bg-white hover:bg-slate-50 text-sm transition-colors w-full md:w-auto"
            >
              清除篩選
            </button>
          )}
        </div>
      </div>

      {/* Table / Cards */}
      {loading ? (
        <div className="text-center py-10 g text-muted-foreground">載入中...</div>
      ) : runs.length === 0 ? (
        <div className="text-center py-10 g text-muted-foreground">
          尚無計糧記錄{canGenerate ? '。点击上方「生成計糧」開始。' : ''}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto rounded-xl g border shadow-card">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>月份</th>
                  <th>診所</th>
                  <th className="text-center">狀態</th>
                  <th className="text-right">員工數</th>
                  <th>生成時間</th>
                  <th>備註</th>
                  <th className="text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.id}>
                    <td>{fmtPeriodMonth(run.periodMonth)}</td>
                    <td>{run.clinic?.name || '全部診所'}</td>
                    <td className="text-center">{statusBadge(run.status)}</td>
                    <td className="text-right font-mono">{run._count.items}</td>
                    <td className="text-xs g text-muted-foreground">{fmtDateTime(run.generatedAt)}</td>
                    <td className="text-xs g text-muted-foreground max-w-[150px] truncate">{run.notes || '-'}</td>
                    <td className="text-center">
                      <Link href={`/payroll/${run.id}`} className="text-brand hover:underline text-sm">詳情</Link>
                      {run.status === 'DRAFT' && canGenerate && (
                        <button onClick={() => deleteRun(run.id)} className="ml-3 text-destructive hover:underline text-sm bg-none border-none cursor-pointer">刪除</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {runs.map(run => (
              <div key={run.id} className="rounded-xl border shadow-card p-3">
                <div className="flex justify-between items-center mb-1">
                  <span className="font-semibold">{fmtPeriodMonth(run.periodMonth)}</span>
                  {statusBadge(run.status)}
                </div>
                <div className="flex justify-between items-center text-sm mb-1">
                  <span className="text-muted-foreground">{run.clinic?.name || '全部診所'}</span>
                  <span className="font-mono">{run._count.items} 人</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">{fmtDateTime(run.generatedAt)}</span>
                  <div className="flex gap-2">
                    <Link href={`/payroll/${run.id}`} className="text-brand hover:underline text-xs">詳情</Link>
                    {run.status === 'DRAFT' && canGenerate && (
                      <button onClick={() => deleteRun(run.id)} className="text-destructive hover:underline text-xs bg-none border-none cursor-pointer">刪除</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-5">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className={`px-3 py-1 rounded-md g border text-sm transition-colors ${page <= 1 ? 'opacity-50 cursor-default' : 'hover:bg-slate-100 cursor-pointer'}`}
          >
            上一頁
          </button>
          <span className="px-3 py-1 text-sm">
            第 {page} / {totalPages} 頁
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className={`px-3 py-1 rounded-md g border text-sm transition-colors ${page >= totalPages ? 'opacity-50 cursor-default' : 'hover:bg-slate-100 cursor-pointer'}`}
          >
            下一頁
          </button>
        </div>
      )}
    </div>
  )
}
