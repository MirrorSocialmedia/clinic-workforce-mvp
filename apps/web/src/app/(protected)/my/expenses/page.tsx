'use client'

import { useEffect, useState, useCallback } from 'react'
import { toHKDateStr } from '@/lib/hk-date'

const statusLabel: Record<string, string> = { PENDING: '待審批', APPROVED: '已批准', REJECTED: '已拒絕' }
const statusColor: Record<string, string> = { PENDING: 'text-amber-600 bg-amber-50', APPROVED: 'text-emerald-600 bg-emerald-50', REJECTED: 'text-gray-500 bg-gray-100' }

export default function MyExpensesPage() {
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // 表單 state
  const [periodMonth, setPeriodMonth] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // 月份選項：當月 / 上月
  const now = toHKDateStr(new Date()).slice(0, 7)
  const [y, m] = now.split('-').map(Number)
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
  const monthOptions = [
    { value: now, label: `當月 (${now})` },
    { value: prev, label: `上月 (${prev})` },
  ]

  const fetchEntries = useCallback(async () => {
    try {
      const res = await fetch('/api/my/expense-entries', { credentials: 'include', cache: 'no-store' })
      const data = await res.json()
      setEntries(data.entries || [])
    } catch {
      setError('載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  // 初始化月份為當月
  useEffect(() => {
    setPeriodMonth(now)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!periodMonth || !amount || !description) {
      setError('請填寫所有欄位')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/my/expense-entries', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodMonth, amount: parseFloat(amount), description }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '提交失敗')
        return
      }
      // 成功後清空表單
      setAmount('')
      setDescription('')
      setPeriodMonth(now)
      await fetchEntries()
    } catch {
      setError('提交失敗')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('確定刪除？已審批嘅記錄唔可以刪。')) return
    try {
      const res = await fetch(`/api/my/expense-entries/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '刪除失敗')
        return
      }
      await fetchEntries()
    } catch {
      setError('刪除失敗')
    }
  }

  const approvedTotal = entries
    .filter((e: any) => e.status === 'APPROVED')
    .reduce((s: number, e: any) => s + e.amount, 0)

  return (
    <div className="p-4 space-y-4" style={{ maxWidth: '800px' }}>
      <h1 className="text-lg font-semibold">雜項報銷申請</h1>

      {/* 申請表單 */}
      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-medium">新增申請</h2>
        {error && <div className="text-xs text-red-500 bg-red-50 rounded px-3 py-2">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">月份</label>
            <select
              value={periodMonth}
              onChange={e => setPeriodMonth(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm"
            >
              {monthOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">金額（HK$）</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="輸入金額"
              className="w-full rounded border px-3 py-2 text-sm"
              min="0"
              step="0.01"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">用途說明</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="例：車費、文具、跨店補貼"
              className="w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2 rounded bg-brand text-white text-sm font-medium disabled:opacity-50"
          >
            {submitting ? '提交中...' : '提交申請'}
          </button>
        </form>
      </div>

      {/* 申請清單 */}
      <div className="rounded-lg border">
        <div className="px-4 py-3 border-b flex justify-between items-center">
          <h2 className="text-sm font-medium">申請記錄</h2>
          <span className="text-xs text-emerald-600">
            已批准合計: ${approvedTotal.toLocaleString()}
          </span>
        </div>
        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-4">載入中...</div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-4">尚無申請記錄</div>
        ) : (
          <div className="divide-y">
            {entries.map((e: any) => {
              const sc = statusColor[e.status] || statusColor.PENDING
              return (
                <div key={e.id} className="px-4 py-3 flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${sc}`}>
                        {statusLabel[e.status] || e.status}
                      </span>
                      <span className="text-sm font-medium">${e.amount.toLocaleString()}</span>
                      <span className="text-xs text-muted-foreground">{e.periodMonth}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{e.description}</div>
                    {e.rejectReason && (
                      <div className="text-xs text-red-500 mt-0.5">拒絕原因：{e.rejectReason}</div>
                    )}
                    {e.reviewedAt && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        審批時間: {new Date(e.reviewedAt).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' })}
                      </div>
                    )}
                  </div>
                  {e.status === 'PENDING' && (
                    <button
                      onClick={() => handleDelete(e.id)}
                      className="text-xs text-red-500 hover:underline shrink-0"
                    >
                      刪除
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
