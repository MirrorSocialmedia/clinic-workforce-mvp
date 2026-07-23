'use client'

import { useEffect, useState, useCallback } from 'react'
import { Fragment } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { hasPermission } from '@/lib/permissions'
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
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])

  // Expense card state (persistent card, not modal)
  const [addingExpense, setAddingExpense] = useState(false)
  const [expMonth, setExpMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [expenses, setExpenses] = useState<any[]>([])
  const [newEmpId, setNewEmpId] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [monthHasRun, setMonthHasRun] = useState(false)
  const [expEmployees, setExpEmployees] = useState<any[]>([])
  const [expLoading, setExpLoading] = useState(false)

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
      setGrant(Array.isArray(d.user?.grant) ? d.user.grant : [])
      setDeny(Array.isArray(d.user?.deny) ? d.user.deny : [])
    })
  }, [])

  const canGenerate = hasPermission(userRole, 'payroll_generate', grant, deny)
  const canView = hasPermission(userRole, 'payroll_view', grant, deny)
  const canDelete = userRole === 'OWNER' // DELETE /api/payroll-runs/:id is OWNER-only in RBAC

  /* ── Expense card (persistent, not modal) ── */

  const loadExpenses = useCallback(async () => {
    setExpLoading(true)
    try {
      const r = await fetch(`/api/expense-entries?periodMonth=${expMonth}`, { credentials: 'include', cache: 'no-store' })
      const data = await r.json()
      setExpenses(data.entries || [])
    } finally {
      setExpLoading(false)
    }
  }, [expMonth])

  const checkMonthHasRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/payroll-runs?periodMonth=${expMonth}&pageSize=1`, { credentials: 'include', cache: 'no-store' })
      const data = await r.json()
      setMonthHasRun((data.runs || []).length > 0)
    } catch {
      setMonthHasRun(false)
    }
  }, [expMonth])

  useEffect(() => {
    loadExpenses()
    checkMonthHasRun()
  }, [loadExpenses, checkMonthHasRun])

  // Load employees for expense card dropdown
  useEffect(() => {
    ;(async () => {
      try {
        const empsRes = await fetch('/api/employees', { credentials: 'include', cache: 'no-store' })
        const emps = await empsRes.json()
        setExpEmployees(Array.isArray(emps) ? emps : (emps.employees || []))
      } catch {}
    })()
  }, [])

  const addExpense = async () => {
    if (!newEmpId || !newAmount || !newDesc) return
    const r = await fetch('/api/expense-entries', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: newEmpId, periodMonth: expMonth, amount: parseFloat(newAmount), description: newDesc }),
    })
    if (r.ok) {
      setNewEmpId(''); setNewAmount(''); setNewDesc('')
      await loadExpenses()
      await checkMonthHasRun()
    } else {
      const err = await r.json().catch(() => ({}))
      alert(err.error || '新增失敗')
    }
  }

  const delExpense = async (id: string, empName?: string, amount?: number) => {
    if (!confirm(`確定取消 ${empName || '該員工'} 的雜項 $${amount || '?'}？`)) return
    const r = await fetch(`/api/expense-entries/${id}`, { method: 'DELETE', credentials: 'include' })
    if (r.ok) await loadExpenses()
    else alert('取消失敗')
  }

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
    <Fragment>
    <div className="p-6" style={{ maxWidth: '1200px' }}>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground tracking-tight" style={{ margin: 0 }}>💰 計糧管理</h1>
        {canGenerate && (
          <div className="flex gap-2">
            <button
              onClick={() => setAddingExpense(!addingExpense)}
              className="px-4 py-2 rounded-md border bg-white hover:bg-slate-50 text-sm font-semibold transition-colors inline-block"
            >
              💰 雜項費用
            </button>
            <Link href="/payroll/new" className="px-4 py-2 rounded-md bg-brand text-white text-sm font-semibold hover:bg-brand-dark transition-colors inline-block" style={{ textDecoration: 'none' }}>
              + 生成計糧
            </Link>
          </div>
        )}
      </div>

      {/* 雜項費用卡片 - 常駐在計糧記錄上方 */}
      <Card className="mb-5">
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-base">💰 雜項費用</CardTitle>
          <div className="flex items-center gap-2">
            <input type="month" value={expMonth} onChange={e => setExpMonth(e.target.value)}
              className="rounded border px-2 py-1 text-sm" />
            {canGenerate && (
              <button onClick={() => setAddingExpense(!addingExpense)}
                className="px-3 py-1 rounded bg-brand text-white text-sm">
                {addingExpense ? '取消' : '+ 新增'}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {/* 新增列（展開時） */}
          {addingExpense && (
            <div className="flex gap-2 items-end mb-3 pb-3 border-b flex-wrap">
              <select value={newEmpId} onChange={e => setNewEmpId(e.target.value)}
                className="flex-1 rounded border px-2 py-1.5 text-sm min-w-[150px]">
                <option value="">選擇員工</option>
                {expEmployees.map((emp: any) => <option key={emp.id} value={emp.id}>{emp.user?.name || emp.name || '未知'}</option>)}
              </select>
              <input type="number" placeholder="金額" value={newAmount}
                onChange={e => setNewAmount(e.target.value)}
                className="w-28 rounded border px-2 py-1.5 text-sm" />
              <input placeholder="說明（例：車費）" value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                className="flex-1 rounded border px-2 py-1.5 text-sm min-w-[120px]" />
              <button onClick={addExpense}
                className="px-3 py-1.5 rounded bg-brand text-white text-sm">確認</button>
            </div>
          )}

          {/* 該月已生成糧單提示 */}
          {monthHasRun && expenses.length > 0 && (
            <div className="text-xs rounded bg-amber-50 border border-amber-300 text-amber-800 px-3 py-2 mb-3">
              ⚠️ 該月計糧已生成，新增/取消雜項後需【重新生成】才會反映
            </div>
          )}

          {/* 記錄清單 */}
          {expLoading ? (
            <div className="text-sm text-muted-foreground text-center py-4">載入中...</div>
          ) : expenses.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">該月尚無雜項記錄</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b">
                      <th className="text-left py-1.5">員工</th>
                      <th className="text-right py-1.5">金額</th>
                      <th className="text-left py-1.5 pl-3">說明</th>
                      <th className="text-left py-1.5">記錄時間</th>
                      <th className="py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {expenses.map((e: any) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <td className="py-1.5">{e.employee?.user?.name || '未知'}</td>
                        <td className="py-1.5 text-right text-emerald-600">+{e.amount.toLocaleString()}</td>
                        <td className="py-1.5 pl-3">{e.description}</td>
                        <td className="py-1.5 text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString('zh-HK')}</td>
                        <td className="py-1.5 text-right">
                          {canGenerate && (
                            <button onClick={() => delExpense(e.id, e.employee?.user?.name, e.amount)}
                              className="text-destructive text-xs hover:underline">取消</button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-medium">
                      <td className="py-1.5">合計</td>
                      <td className="py-1.5 text-right text-emerald-600">
                        +{expenses.reduce((s: number, e: any) => s + e.amount, 0).toLocaleString()}
                      </td>
                      <td colSpan={3}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

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
                      {run.status === 'DRAFT' && canDelete && (
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
                    {run.status === 'DRAFT' && canDelete && (
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
    </Fragment>
  )
}
