'use client'

import { useEffect, useState, useCallback } from 'react'
import { Fragment } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
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

  // Expense modal state
  const [expenseModalOpen, setExpenseModalOpen] = useState(false)
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
  const [selectedClinicId, setSelectedClinicId] = useState<string>('')
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

  /* ── Expense modal ── */

  const loadExpenses = useCallback(async () => {
    setExpLoading(true)
    try {
      const params = new URLSearchParams({ periodMonth: expMonth })
      if (selectedClinicId) params.set('clinicId', selectedClinicId)
      const r = await fetch(`/api/expense-entries?${params}`, { credentials: 'include', cache: 'no-store' })
      const data = await r.json()
      setExpenses(data.entries || [])
    } finally {
      setExpLoading(false)
    }
  }, [expMonth, selectedClinicId])

  const checkMonthHasRun = useCallback(async () => {
    try {
      const params = new URLSearchParams({ periodMonth: expMonth })
      if (selectedClinicId) params.set('clinicId', selectedClinicId)
      const r = await fetch(`/api/payroll-runs?${params}&pageSize=1`, { credentials: 'include', cache: 'no-store' })
      const data = await r.json()
      setMonthHasRun((data.runs || []).length > 0)
    } catch {
      setMonthHasRun(false)
    }
  }, [expMonth, selectedClinicId])

  useEffect(() => {
    if (expenseModalOpen) {
      loadExpenses()
      checkMonthHasRun()
    }
  }, [expenseModalOpen, loadExpenses, checkMonthHasRun])

  // Load employees + clinics for expense modal dropdown
  useEffect(() => {
    if (!expenseModalOpen) return
    ;(async () => {
      try {
        const [empsRes, clsRes] = await Promise.all([
          fetch('/api/employees', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/clinics', { credentials: 'include', cache: 'no-store' }),
        ])
        const emps = await empsRes.json()
        const cls = await clsRes.json()
        setExpEmployees(Array.isArray(emps) ? emps : (emps.employees || []))
        const clinicList = cls.clinics || cls || []
        if (clinicList.length > 0 && !selectedClinicId) {
          setSelectedClinicId(clinicList[0].id)
        }
      } catch {}
    })()
  }, [expenseModalOpen])

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

  const delExpense = async (id: string) => {
    if (!confirm('刪除這筆記錄？')) return
    const r = await fetch(`/api/expense-entries/${id}`, { method: 'DELETE', credentials: 'include' })
    if (r.ok) await loadExpenses()
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
              onClick={() => setExpenseModalOpen(true)}
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

    {/* ── Expense Modal ── */}
    {expenseModalOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={() => setExpenseModalOpen(false)}
      >
        <div
          className="bg-card rounded-lg p-5 w-[560px] max-w-[92vw] max-h-[85vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">雜項費用</h2>
            <button onClick={() => setExpenseModalOpen(false)} className="text-muted-foreground hover:text-foreground text-xl leading-none">✕</button>
          </div>

          <div className="flex gap-2 mb-3">
            <input
              type="month"
              value={expMonth}
              onChange={e => setExpMonth(e.target.value)}
              className="rounded border px-3 py-2 flex-1"
            />
            <select
              value={selectedClinicId}
              onChange={e => setSelectedClinicId(e.target.value)}
              className="rounded border px-3 py-2 w-32"
            >
              {(() => {
                const clinicOptions = runs.reduce((acc: any[], r) => {
                  if (r.clinic?.id && !acc.includes(r.clinic.id)) acc.push(r.clinic)
                  return acc
                }, [])
                if (!clinicOptions.length) return <option value="">診所</option>
                return clinicOptions.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)
              })()}
            </select>
          </div>

          {monthHasRun && (
            <div className="text-xs rounded bg-amber-50 border border-amber-300 text-amber-800 px-3 py-2 mb-3">
              ⚠️ 該月計糧已生成，新增後需【重新生成】才會計入
            </div>
          )}

          <table className="w-full text-sm mb-4">
            <thead><tr className="text-xs text-muted-foreground">
              <th className="text-left">員工</th><th className="text-right">金額</th>
              <th className="text-left">說明</th><th></th>
            </tr></thead>
            <tbody>
              {expLoading ? (
                <tr><td colSpan={4} className="text-center text-muted-foreground py-3">載入中...</td></tr>
              ) : expenses.length === 0 ? (
                <tr><td colSpan={4} className="text-center text-muted-foreground py-3">該月尚無雜項</td></tr>
              ) : (
                expenses.map((e: any) => (
                  <tr key={e.id} className="border-t">
                    <td>{e.employee?.user?.name || '未知'}</td>
                    <td className="text-right">${e.amount.toLocaleString()}</td>
                    <td>{e.description}</td>
                    <td><button onClick={() => delExpense(e.id)} className="text-destructive text-xs">刪除</button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className="flex gap-2 items-end border-t pt-3">
            <select value={newEmpId} onChange={e => setNewEmpId(e.target.value)} className="flex-1 rounded border px-2 py-1.5">
              <option value="">選擇員工</option>
              {expEmployees.map((emp: any) => <option key={emp.id} value={emp.id}>{emp.user?.name || emp.name || '未知'}</option>)}
            </select>
            <input type="number" placeholder="金額" value={newAmount} onChange={e => setNewAmount(e.target.value)} className="w-24 rounded border px-2 py-1.5" />
            <input placeholder="說明（例：車費）" value={newDesc} onChange={e => setNewDesc(e.target.value)} className="flex-1 rounded border px-2 py-1.5" />
            <button onClick={addExpense} className="px-3 py-1.5 rounded bg-brand text-white">新增</button>
          </div>
        </div>
      </div>
    )}
    </Fragment>
  )
}
