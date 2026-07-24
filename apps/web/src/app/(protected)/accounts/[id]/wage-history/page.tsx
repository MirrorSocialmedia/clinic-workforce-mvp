'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

/** Wage history row */
interface WageRow {
  id: string
  periodMonth: string
  wage: number
  excludedDays: number
  excludedWage: number
  calendarDays: number
  source: 'PayrollItem' | 'WageHistory'
  note?: string | null
}

/** ADW preview result */
interface ADWData {
  adw: number
  totalWage: number
  totalDays: number
  isShortPeriod: boolean
  periodStart: string
  periodEnd: string
  sources: any[]
  warnings: string[]
}

/** Employee info */
interface EmployeeInfo {
  id: string
  name: string
  joinDate: string
}

export default function WageHistoryPage({ params }: { params: { id: string } }) {
  const employeeId = params.id
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<WageRow[]>([])
  const [adwPreview, setAdwPreview] = useState<ADWData | null>(null)
  const [employee, setEmployee] = useState<EmployeeInfo | null>(null)
  const [userRole, setUserRole] = useState<string>('')
  const [saving, setSaving] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Batch fill state
  const [batchSalary, setBatchSalary] = useState('')
  const [batchStart, setBatchStart] = useState('')
  const [batchEnd, setBatchEnd] = useState('')
  const [batching, setBatching] = useState(false)

  // Inline edit state: periodMonth → { wage, excludedDays, excludedWage }
  const [edits, setEdits] = useState<Record<string, { wage: number; excludedDays: number; excludedWage: number }>>({})

  const canWrite = userRole === 'OWNER'

  // ---- Load data ----
  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [roleRes, wageRes, empRes, adwRes] = await Promise.all([
        fetch('/api/me', { credentials: 'include', cache: 'no-store' }).then(r => r.ok ? r.json() : null),
        fetch(`/api/wage-history?employeeId=${employeeId}`, { credentials: 'include', cache: 'no-store' }).then(r => {
          if (!r.ok) throw new Error('無權查看歷史工資')
          return r.json()
        }).catch(() => null),
        fetch(`/api/employees/${employeeId}`, { credentials: 'include', cache: 'no-store' }).then(r => {
          if (!r.ok) return null
          return r.json()
        }).catch(() => null),
        fetch(`/api/adw/preview?employeeId=${employeeId}&date=${new Date().toISOString().slice(0, 10)}`, {
          credentials: 'include', cache: 'no-store',
        }).then(r => r.ok ? r.json() : null).catch(() => null),
      ])

      setUserRole(roleRes?.role ?? '')
      if (wageRes?.rows) {
        setRows(wageRes.rows)
      }
      if (empRes) {
        setEmployee({
          id: empRes.id,
          name: empRes.user?.name ?? empRes.name ?? '未知員工',
          joinDate: empRes.joinDate,
        })
      }
      if (adwRes) {
        setAdwPreview(adwRes)
      }
    } catch (err: any) {
      setError(err.message || '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [employeeId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // ---- Save single row (WageHistory only) ----
  const handleSave = async (row: WageRow) => {
    if (!canWrite || row.source !== 'WageHistory') return
    const edit = edits[row.periodMonth]
    if (!edit) return

    setSaving(row.periodMonth)
    try {
      const res = await fetch(`/api/wage-history/${row.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edit),
      })
      if (!res.ok) throw new Error('更新失敗')
      setRows(prev =>
        prev.map(r =>
          r.id === row.id
            ? { ...r, wage: edit.wage, excludedDays: edit.excludedDays, excludedWage: edit.excludedWage }
            : r,
        ),
      )
      delete edits[row.periodMonth]
      setEdits({ ...edits })
      // Refresh ADW preview
      const adwRes = await fetch(`/api/adw/preview?employeeId=${employeeId}&date=${new Date().toISOString().slice(0, 10)}`, {
        credentials: 'include', cache: 'no-store',
      })
      if (adwRes.ok) setAdwPreview(await adwRes.json())
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(null)
    }
  }

  // ---- Cancel edit ----
  const handleCancel = (periodMonth: string) => {
    const row = rows.find(r => r.periodMonth === periodMonth)
    if (!row) return
    setEdits(prev => {
      const next = { ...prev }
      next[periodMonth] = { wage: row.wage, excludedDays: row.excludedDays, excludedWage: row.excludedWage }
      return next
    })
  }

  // ---- Start editing ----
  const handleEdit = (row: WageRow) => {
    if (!canWrite || row.source !== 'WageHistory') return
    setEdits(prev => ({
      ...prev,
      [row.periodMonth]: { wage: row.wage, excludedDays: row.excludedDays, excludedWage: row.excludedWage },
    }))
  }

  // ---- Delete (WageHistory only) ----
  const handleDelete = async (row: WageRow) => {
    if (!canWrite || row.source !== 'WageHistory') return
    if (!confirm(`確定刪除 ${row.periodMonth} 的歷史工資記錄？`)) return

    setDeleting(row.id)
    try {
      const res = await fetch(`/api/wage-history/${row.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('刪除失敗')
      setRows(prev => prev.filter(r => r.id !== row.id))
      // Refresh ADW
      const adwRes = await fetch(`/api/adw/preview?employeeId=${employeeId}&date=${new Date().toISOString().slice(0, 10)}`, {
        credentials: 'include', cache: 'no-store',
      })
      if (adwRes.ok) setAdwPreview(await adwRes.json())
    } catch (err: any) {
      setError(err.message)
    } finally {
      setDeleting(null)
    }
  }

  // ---- Batch fill ----
  const handleBatchFill = async () => {
    if (!canWrite || !batchSalary || !batchStart || !batchEnd) return
    if (batchStart > batchEnd) {
      setError('起始月不能晚於結束月')
      return
    }

    setBatching(true)
    try {
      const salary = parseFloat(batchSalary)
      const months: string[] = []
      let current = batchStart
      while (current <= batchEnd) {
        months.push(current)
        const [y, m] = current.split('-').map(Number)
        current = m >= 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
      }

      const results = await Promise.all(
        months.map(async (pm) => {
          // Check if already exists
          const existing = rows.find(r => r.periodMonth === pm)
          if (existing && existing.source === 'PayrollItem') return null // Skip PayrollItem months

          const [y, m] = pm.split('-').map(Number)
          const calendarDays = new Date(Date.UTC(y, m, 0)).getUTCDate()

          if (existing && existing.source === 'WageHistory') {
            // Update existing
            await fetch(`/api/wage-history/${existing.id}`, {
              method: 'PUT',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ totalWage: salary, excludedDays: 0, excludedWage: 0 }),
            })
            return { ...existing, wage: salary, excludedDays: 0, excludedWage: 0 }
          }

          // Create new
          const res = await fetch('/api/wage-history', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              employeeId,
              periodMonth: pm,
              totalWage: salary,
              excludedDays: 0,
              excludedWage: 0,
            }),
          })
          if (!res.ok) throw new Error(`Failed to create ${pm}`)
          const data = await res.json()
          return {
            id: data.id,
            periodMonth: pm,
            wage: salary,
            excludedDays: 0,
            excludedWage: 0,
            calendarDays,
            source: 'WageHistory',
          }
        }),
      )

      const newRows = results.filter(Boolean) as WageRow[]
      // Merge: replace existing WageHistory, add new ones, keep PayrollItem
      setRows(prev => {
        const updated = prev.map(r => {
          const match = newRows.find(nr => nr.periodMonth === r.periodMonth)
          return match ? { ...match } : r
        })
        // Add rows that aren't in prev
        const prevMonths = new Set(prev.map(r => r.periodMonth))
        for (const nr of newRows) {
          if (!prevMonths.has(nr.periodMonth)) updated.push(nr)
        }
        return updated.sort((a, b) => a.periodMonth.localeCompare(b.periodMonth))
      })

      // Refresh ADW
      const adwRes = await fetch(`/api/adw/preview?employeeId=${employeeId}&date=${new Date().toISOString().slice(0, 10)}`, {
        credentials: 'include', cache: 'no-store',
      })
      if (adwRes.ok) setAdwPreview(await adwRes.json())

      setBatchSalary('')
      setBatchStart('')
      setBatchEnd('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBatching(false)
    }
  }

  if (loading) return <div className="p-6 text-muted-foreground">載入中…</div>
  if (error && !rows.length) return <div className="p-6 text-destructive">錯誤：{error}</div>

  return (
    <div className="p-6 max-w-5xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">歷史工資</h1>
          <p className="text-sm text-muted-foreground">
            {employee?.name ?? '員工'} · 入職日 {employee?.joinDate ? new Date(employee.joinDate).toISOString().slice(0, 10) : '—'}
          </p>
        </div>
        <button onClick={() => router.back()} className="text-sm text-brand hover:underline">
          ← 返回
        </button>
      </div>

      {error && (
        <div className="text-sm text-destructive bg-destructive/5 rounded px-3 py-2">{error}</div>
      )}

      {/* Info banner */}
      <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm space-y-1">
        <div>
          <strong>用途：</strong>系統啟用前的歷史工資，供計算「12個月平均工資」(ADW)。
          ADW 影響年假、法定假日、病假、產假薪酬。
        </div>
        <div>
          <strong>只需填系統啟用前的月份</strong>；啟用後由計糧記錄自動提供。
        </div>
        <div className="text-xs text-muted-foreground">
          法例依據：《僱傭條例》第 713 條——每日平均工資 = 過去 12 個月工資總額 ÷ 日數（扣除非全薪期間）
        </div>
      </div>

      {/* ADW Preview Card */}
      {adwPreview && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">12個月平均工資 (ADW)</span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                《僱傭條例》713
              </span>
            </div>
          </div>

          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold font-mono">${adwPreview.adw.toFixed(2)}</span>
            <span className="text-sm text-muted-foreground">/ 天</span>
            {adwPreview.isShortPeriod && (
              <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                受僱不足12個月
              </span>
            )}
          </div>

          <div className="text-xs text-muted-foreground">
            ${adwPreview.totalWage.toLocaleString()} ÷ {adwPreview.totalDays} 天
            <span className="mx-2">·</span>
            期間 {adwPreview.periodStart} ~ {adwPreview.periodEnd}
          </div>

          {/* Holiday pay breakdown */}
          <div className="grid grid-cols-2 gap-2 text-sm border-t pt-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">法定假日 / 年假</span>
              <span className="font-mono">${adwPreview.adw.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">病假 (4/5)</span>
              <span className="font-mono">${(adwPreview.adw * 0.8).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">產假 (4/5)</span>
              <span className="font-mono">${(adwPreview.adw * 0.8).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">侍產假 (4/5)</span>
              <span className="font-mono">${(adwPreview.adw * 0.8).toFixed(2)}</span>
            </div>
          </div>

          {adwPreview.warnings?.length > 0 && (
            <div className="space-y-1">
              {adwPreview.warnings.map((w, i) => (
                <div key={i} className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                  ⚠️ {w}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Monthly Table */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b bg-muted/30">
              <th className="text-left py-2 px-3">月份</th>
              <th className="text-right py-2 px-2">工資總額</th>
              <th className="text-right py-2 px-2">剔除天數</th>
              <th className="text-right py-2 px-2">剔除款額</th>
              <th className="text-left py-2 px-3">來源</th>
              <th className="text-right py-2 px-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-muted-foreground">
                  暫無記錄。可使用「快速填入」批量建立。
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const isEditing = !!edits[row.periodMonth]
              const edit = edits[row.periodMonth]
              const isWageHistory = row.source === 'WageHistory'
              return (
                <tr key={row.periodMonth} className="border-b hover:bg-muted/20">
                  <td className="py-2 px-3 font-medium">{row.periodMonth}</td>

                  <td className="text-right px-2 py-1">
                    {isWageHistory && canWrite && isEditing ? (
                      <input
                        type="number"
                        value={edit.wage}
                        onChange={e =>
                          setEdits(prev => ({
                            ...prev,
                            [row.periodMonth]: { ...edit, wage: parseFloat(e.target.value) || 0 },
                          }))
                        }
                        className="w-28 text-right rounded border px-2 py-1 text-sm"
                      />
                    ) : (
                      <span className={isWageHistory ? '' : 'text-muted-foreground'}>
                        ${row.wage.toFixed(2)}
                      </span>
                    )}
                  </td>

                  <td className="text-right px-2 py-1">
                    {isWageHistory && canWrite && isEditing ? (
                      <input
                        type="number"
                        value={edit.excludedDays}
                        onChange={e =>
                          setEdits(prev => ({
                            ...prev,
                            [row.periodMonth]: { ...edit, excludedDays: parseInt(e.target.value) || 0 },
                          }))
                        }
                        className="w-16 text-right rounded border px-2 py-1 text-sm"
                      />
                    ) : (
                      <span className={isWageHistory ? '' : 'text-muted-foreground'}>
                        {row.excludedDays}
                      </span>
                    )}
                  </td>

                  <td className="text-right px-2 py-1">
                    {isWageHistory && canWrite && isEditing ? (
                      <input
                        type="number"
                        value={edit.excludedWage}
                        onChange={e =>
                          setEdits(prev => ({
                            ...prev,
                            [row.periodMonth]: { ...edit, excludedWage: parseFloat(e.target.value) || 0 },
                          }))
                        }
                        className="w-24 text-right rounded border px-2 py-1 text-sm"
                      />
                    ) : (
                      <span className={isWageHistory ? '' : 'text-muted-foreground'}>
                        ${row.excludedWage.toFixed(2)}
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-1">
                    {row.source === 'PayrollItem' ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                        系統計糧
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                        人手補錄
                      </span>
                    )}
                  </td>

                  <td className="text-right px-3 py-1">
                    {isWageHistory && canWrite ? (
                      isEditing ? (
                        <div className="flex gap-1 justify-end">
                          <button
                            onClick={() => handleSave(row)}
                            disabled={saving === row.periodMonth}
                            className="text-xs px-2 py-1 rounded bg-brand text-white hover:opacity-90"
                          >
                            {saving === row.periodMonth ? '保存中…' : '保存'}
                          </button>
                          <button
                            onClick={() => handleCancel(row.periodMonth)}
                            className="text-xs px-2 py-1 rounded border"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-1 justify-end">
                          <button
                            onClick={() => handleEdit(row)}
                            className="text-xs text-brand hover:underline"
                          >
                            編輯
                          </button>
                          <button
                            onClick={() => handleDelete(row)}
                            disabled={deleting === row.id}
                            className="text-xs text-destructive hover:underline"
                          >
                            {deleting === row.id ? '刪除中…' : '刪除'}
                          </button>
                        </div>
                      )
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Batch fill */}
      {canWrite && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="font-medium text-sm">快速填入</div>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="text-xs text-muted-foreground">月薪</label>
              <input
                type="number"
                value={batchSalary}
                onChange={e => setBatchSalary(e.target.value)}
                placeholder="如 20000"
                className="w-32 rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">起始月</label>
              <input
                type="month"
                value={batchStart}
                onChange={e => setBatchStart(e.target.value)}
                className="rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">結束月</label>
              <input
                type="month"
                value={batchEnd}
                onChange={e => setBatchEnd(e.target.value)}
                className="rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <button
              onClick={handleBatchFill}
              disabled={batching || !batchSalary || !batchStart || !batchEnd}
              className="px-4 py-1.5 rounded bg-brand text-white text-sm hover:opacity-90 disabled:opacity-50"
            >
              {batching ? '填入中…' : '填入'}
            </button>
          </div>
          <div className="text-xs text-muted-foreground">
            ⚠️ 該員工已有系統計糧的月份會跳過。若有病假/年假月份，需逐月調整「剔除天數」與「剔除款額」
          </div>
        </div>
      )}

      {/* Footer note */}
      <div className="text-xs text-muted-foreground pt-2">
        「系統計糧」＝已確認計糧自動記錄（唯讀） | 「人手補錄」＝系統啟用前人手輸入（可編輯/刪除）
      </div>
    </div>
  )
}
