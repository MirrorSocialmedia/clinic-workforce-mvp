'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

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

  const statusBadge = (status: RunStatus) => {
    const colors: Record<RunStatus, string> = {
      DRAFT: '#ffc107',
      FINALIZED: '#0d6efd',
      EXPORTED: '#198754',
    }
    const labels: Record<RunStatus, string> = {
      DRAFT: '草稿',
      FINALIZED: '已確認',
      EXPORTED: '已匯出',
    }
    return (
      <span style={{
        background: colors[status],
        color: status === 'DRAFT' ? '#333' : '#fff',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 600,
      }}>
        {labels[status]}
      </span>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>💰 計糧管理</h1>
        {canGenerate && (
          <Link href="/payroll/new" style={{
            background: '#0d6efd',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 6,
            textDecoration: 'none',
            fontWeight: 600,
          }}>
            + 生成計糧
          </Link>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
          style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd' }}
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
          style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd' }}
        />

        <button
          onClick={fetchRuns}
          style={{ padding: '6px 16px', borderRadius: 4, border: '1px solid #ddd', background: '#f8f9fa', cursor: 'pointer' }}
        >
          查詢
        </button>

        {(statusFilter || periodFilter) && (
          <button
            onClick={() => { setStatusFilter(''); setPeriodFilter(''); setPage(1) }}
            style={{ padding: '6px 16px', borderRadius: 4, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }}
          >
            清除篩選
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>載入中...</div>
      ) : runs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>
          尚無計糧記錄{canGenerate ? '。点击上方「生成計糧」開始。' : ''}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #dee2e6' }}>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>月份</th>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>診所</th>
                <th style={{ textAlign: 'center', padding: '10px 8px' }}>狀態</th>
                <th style={{ textAlign: 'right', padding: '10px 8px' }}>員工數</th>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>生成時間</th>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>備註</th>
                <th style={{ textAlign: 'center', padding: '10px 8px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <tr key={run.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '10px 8px' }}>
                    {new Date(run.periodMonth).toISOString().slice(0, 7)}
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    {run.clinic?.name || '全部診所'}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                    {statusBadge(run.status)}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                    {run._count.items}
                  </td>
                  <td style={{ padding: '10px 8px', fontSize: 12, color: '#888' }}>
                    {new Date(run.generatedAt).toLocaleString('zh-HK')}
                  </td>
                  <td style={{ padding: '10px 8px', fontSize: 12, color: '#888', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {run.notes || '-'}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                    <Link href={`/payroll/${run.id}`} style={{
                      color: '#0d6efd',
                      textDecoration: 'none',
                      fontSize: 13,
                    }}>
                      詳情
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 20 }}>
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #ddd', cursor: page <= 1 ? 'default' : 'pointer', opacity: page <= 1 ? 0.5 : 1 }}
          >
            上一頁
          </button>
          <span style={{ padding: '4px 12px', lineHeight: '28px' }}>
            第 {page} / {totalPages} 頁
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #ddd', cursor: page >= totalPages ? 'default' : 'pointer', opacity: page >= totalPages ? 0.5 : 1 }}
          >
            下一頁
          </button>
        </div>
      )}
    </div>
  )
}
