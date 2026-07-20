'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { BackButton } from '@/components/BackButton'
import { Wallet, Trash2 } from 'lucide-react'
import { toHKDateStr } from '@/lib/hk-date'

type RunStatus = 'DRAFT' | 'FINALIZED' | 'EXPORTED'

interface PayrollItem {
  id: string
  employeeId: string
  workedHours: number
  otHours: number
  leaveDays: number
  absentDays: number
  basePay: number | null
  otPay: number | null
  splitPay: number | null
  deduction: number | null
  totalPayable: number | null
  detailJson: string | null
  confidential?: boolean
  employee: {
    user: { name: string; phone: string }
    clinics: { clinicId: string; clinic: { name: string } }[]
    payRules: Array<{ payType: string }>
  }
}

interface PayrollRun {
  id: string
  clinicId: string | null
  periodMonth: string
  status: RunStatus
  generatedAt: string
  notes: string | null
  clinic: { id: string; name: string } | null
  items: PayrollItem[]
}

interface Summary {
  totalEmployees: number
  totalBasePay: number | null
  totalOTPay: number | null
  totalSplitPay: number | null
  totalDeduction: number | null
  totalPayable: number | null
  totalWorkedHours: number
  totalOTHours: number
  totalLeaveDays: number
  totalAbsentDays: number
  confidential?: boolean
}

export default function PayrollDetailPage() {
  const params = useParams()
  const router = useRouter()
  const runId = (params?.id || '') as string

  const [run, setRun] = useState<PayrollRun | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState<string>('')
  const [exporting, setExporting] = useState<string | null>(null)
  const [updateNote, setUpdateNote] = useState('')
  const [statusAction, setStatusAction] = useState<string | null>(null)

  const fetchRun = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/payroll-runs/${runId}`)
      if (!res.ok) {
        if (res.status === 404) router.push('/payroll')
        return
      }
      const data = await res.json()
      setRun(data.run)
      setSummary(data.summary)
    } catch (err) {
      console.error('Failed to fetch payroll run:', err)
    } finally {
      setLoading(false)
    }
  }, [runId, router])

  useEffect(() => {
    fetchRun()
    fetch('/api/me').then(async r => {
      if (!r.ok) return { user: { role: '' } }
      const d = await r.json()
      setUserRole(d.user?.role || '')
    })
  }, [fetchRun])

  const isOwner = userRole === 'OWNER'

  const handleStatusChange = async (newStatus: string) => {
    try {
      const res = await fetch(`/api/payroll-runs/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        fetchRun()
      } else {
        const err = await res.json()
        alert(err.error || '更新失敗')
      }
    } catch (err) {
      console.error('Failed to update status:', err)
    } finally {
      setStatusAction(null)
    }
  }

  const handleDelete = async () => {
    if (!confirm('確定刪除？此操作不可復原。')) return
    try {
      const res = await fetch(`/api/payroll-runs/${runId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        router.push('/payroll')
      } else {
        const err = await res.json()
        alert(err.error || '刪除失敗')
      }
    } catch (err) {
      console.error('Failed to delete:', err)
    }
  }

  const handleExport = async (format: 'xlsx' | 'pdf') => {
    setExporting(format)
    try {
      const res = await fetch(`/api/payroll-runs/${runId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ format }),
      })
      if (!res.ok) throw new Error('匯出失敗')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `payroll_${toHKDateStr(new Date(run?.periodMonth || '')).slice(0, 7)}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export failed:', err)
      alert('匯出失敗')
    } finally {
      setExporting(null)
    }
  }

  const handleUpdateNotes = async () => {
    try {
      const res = await fetch(`/api/payroll-runs/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ notes: updateNote }),
      })
      if (res.ok) fetchRun()
    } catch (err) {
      console.error('Failed to update notes:', err)
    }
  }

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
        padding: '4px 10px',
        borderRadius: 4,
        fontSize: 13,
        fontWeight: 600,
      }}>
        {labels[status]}
      </span>
    )
  }

  const fmtCurrency = (v: number | null) => {
    if (v == null) return '🔒 保密'
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const fmtPM = () => toHKDateStr(new Date(run!.periodMonth)).slice(0, 7)

  const parseAttendanceBonus = (item: PayrollItem) => {
    if (!item.detailJson) return { amount: 0, cancelled: false, reason: '' }
    try {
      const detail = JSON.parse(item.detailJson)
      const bonus = (detail as any)?.attendanceBonus
      if (bonus && typeof bonus === 'object') {
        return {
          amount: bonus.amount ?? 0,
          cancelled: !!bonus.cancelled,
          reason: bonus.reason || '',
        }
      }
    } catch {}
    return { amount: 0, cancelled: false, reason: '' }
  }

  const renderAttendanceBonus = (item: PayrollItem) => {
    if (item.confidential) {
      return (
        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: '#888', fontSize: 12 }}>
          🔒 保密
        </td>
      )
    }
    const { amount, cancelled, reason } = parseAttendanceBonus(item)
    if (cancelled) {
      return (
        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: '#dc3545', fontSize: 12 }}>
          {fmtCurrency(0)}<br />
          <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>⚠️ {reason || '遲到超30分取消'}</span>
        </td>
      )
    }
    return (
      <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: amount > 0 ? '#198754' : 'inherit' }}>
        {amount > 0 ? fmtCurrency(amount) : '-'}
      </td>
    )
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>載入中...</div>
  }

  if (!run) {
    return <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>找不到計糧記錄</div>
  }

  const periodMonth = fmtPM()

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <BackButton to="/payroll" label="返回計糧列表" />
          <h1 style={{ margin: 0, fontSize: 24 }}>
            <span className="flex items-center gap-2"><Wallet size={20} /> 計糧詳情 — {periodMonth}</span>
          </h1>
          <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
            {run.clinic?.name || '全部診所'} | {statusBadge(run.status)}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {run.status === 'DRAFT' && isOwner && (
            <button onClick={() => handleStatusChange('FINALIZED')} disabled={statusAction !== null}
              style={{ padding: '8px 16px', background: '#0d6efd', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
              確認計糧
            </button>
          )}
          {run.status === 'FINALIZED' && isOwner && (
            <button onClick={() => handleStatusChange('EXPORTED')} disabled={statusAction !== null}
              style={{ padding: '8px 16px', background: '#198754', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
              標記已匯出
            </button>
          )}
          <button onClick={() => handleExport('xlsx')} disabled={exporting !== null}
            style={{ padding: '8px 16px', background: '#198754', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            {exporting === 'xlsx' ? '匯出中...' : '📊 Excel'}
          </button>
          <button onClick={() => handleExport('pdf')} disabled={exporting !== null}
            style={{ padding: '8px 16px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            {exporting === 'pdf' ? '匯出中...' : '📄 PDF'}
          </button>
          {run.status === 'DRAFT' && isOwner && (
            <button onClick={handleDelete}
              style={{ padding: '8px 16px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              <span className="flex items-center gap-1"><Trash2 size={16} /> 刪除</span>
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div>
          {summary.confidential && (
            <div style={{
              padding: '10px 16px', marginBottom: 16,
              background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6,
              fontSize: 13, color: '#856404',
            }}>
              ⚠️ 含保密員工，總額僅老闆可見
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
            {[
              { label: '員工數', value: summary.totalEmployees, color: '#0d6efd' },
              { label: '總基本薪資', value: summary.confidential ? '🔒 保密' : fmtCurrency(summary.totalBasePay), color: '#6c757d' },
              { label: '總加班費', value: summary.confidential ? '🔒 保密' : fmtCurrency(summary.totalOTPay), color: '#198754' },
              { label: '總扣款', value: summary.confidential ? '🔒 保密' : fmtCurrency(summary.totalDeduction), color: '#dc3545' },
              { label: '應付總額', value: summary.confidential ? '🔒 保密' : fmtCurrency(summary.totalPayable), color: '#0d6efd', bold: true },
              { label: '總工時', value: `${summary.totalWorkedHours.toFixed(1)}h`, color: '#6c757d' },
              { label: '總加班時數', value: `${(summary.totalOTHours || 0).toFixed(1)}h`, color: '#6c757d' },
              { label: '總請假/缺勤', value: `${summary.totalLeaveDays.toFixed(1)} / ${summary.totalAbsentDays.toFixed(1)} 天`, color: '#6c757d' },
            ].map(card => (
              <div key={card.label} style={{
                padding: '12px 16px',
                background: card.color + '10',
                borderLeft: `3px solid ${card.color}`,
                borderRadius: 4,
              }}>
                <div style={{ fontSize: 12, color: '#888' }}>{card.label}</div>
                <div style={{ fontSize: 20, fontWeight: card.bold ? 700 : 600, color: card.color }}>
                  {card.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', marginBottom: 4, fontSize: 13, color: '#888' }}>備註</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={updateNote || run.notes || ''}
            onChange={e => setUpdateNote(e.target.value)}
            placeholder="添加備註..."
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 4,
              border: '1px solid #ddd',
              fontSize: 14,
            }}
          />
          {isOwner && (
            <button onClick={handleUpdateNotes}
              style={{ padding: '8px 16px', background: '#f8f9fa', border: '1px solid #ddd', borderRadius: 4, cursor: 'pointer' }}>
              儲存
            </button>
          )}
        </div>
      </div>

      {/* Employee Table — Desktop */}
      <div className="hidden md:block" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #dee2e6' }}>
              <th style={{ textAlign: 'left', padding: '8px 6px' }}>員工</th>
              <th style={{ textAlign: 'left', padding: '8px 6px' }}>診所</th>
              <th style={{ textAlign: 'left', padding: '8px 6px' }}>薪酬類型</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>工時</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>加班</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>請假</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>缺勤</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>基本薪資</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>勤工獎</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>加班費</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>拆帳</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>扣款</th>
              <th style={{ textAlign: 'right', padding: '8px 6px' }}>應付總額</th>
              <th style={{ textAlign: 'center', padding: '8px 6px' }}>明細</th>
            </tr>
          </thead>
          <tbody>
            {run.items.map(item => {
              const confidential = item.confidential
              return (
                <tr key={item.id} style={{
                  borderBottom: '1px solid #f0f0f0',
                  background: confidential ? '#fff9f0' : 'transparent',
                }}>
                  <td style={{ padding: '8px 6px' }}>
                    <div style={{ fontWeight: 600 }}>
                      {confidential && <span title="薪資保密">🔒 </span>}
                      {item.employee.user.name}
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>{item.employee.user.phone}</div>
                  </td>
                  <td style={{ padding: '8px 6px', fontSize: 12 }}>
                    {item.employee.clinics.map(c => c.clinic.name).join(', ')}
                  </td>
                  <td style={{ padding: '8px 6px', fontSize: 12 }}>
                    {item.employee.payRules[0]?.payType || '-'}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right' }}>{item.workedHours.toFixed(1)}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                    {confidential ? '🔒' : (() => { try { const d = JSON.parse(item.detailJson || '{}'); return ((d?.timebank?.otMinutes ?? 0) / 60).toFixed(1) } catch { return item.otHours.toFixed(1) } })()}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right' }}>{item.leaveDays.toFixed(1)}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', color: item.absentDays > 0 ? '#dc3545' : 'inherit' }}>
                    {item.absentDays.toFixed(1)}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                    {fmtCurrency(item.basePay)}
                  </td>
                  {renderAttendanceBonus(item)}
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                    {fmtCurrency(item.otPay)}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                    {fmtCurrency(item.splitPay)}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: (item.deduction ?? 0) > 0 ? '#dc3545' : 'inherit' }}>
                    {fmtCurrency(item.deduction)}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>
                    {fmtCurrency(item.totalPayable)}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                    {confidential ? (
                      <span style={{ color: '#888', fontSize: 12, cursor: 'not-allowed' }} title="此員工薪資已設保密">🔒 保密</span>
                    ) : (
                      <Link href={`/payroll/${runId}/employee/${item.employeeId}`}
                        style={{ color: '#0d6efd', textDecoration: 'none', fontSize: 12 }}>
                        查看
                      </Link>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Employee Cards — Mobile */}
      <div className="md:hidden space-y-3" style={{ marginTop: 16 }}>
        {run.items.map(item => {
          const confidential = item.confidential
          return (
            <div key={item.id} style={{
              background: confidential ? '#fff9f0' : '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '12px 14px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}>
              {/* Employee name + clinic */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>
                    {confidential && <span title="薪資保密">🔒 </span>}
                    {item.employee.user.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                    {item.employee.clinics.map(c => c.clinic.name).join(', ')} · {item.employee.payRules[0]?.payType || '-'}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>{item.employee.user.phone}</div>
              </div>

              {/* Hours row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#888' }}>工時</div>
                  <div style={{ fontSize: 14, fontFamily: 'monospace' }}>{item.workedHours.toFixed(1)}h</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#888' }}>加班</div>
                  <div style={{ fontSize: 14, fontFamily: 'monospace' }}>
                    {confidential ? '🔒' : (() => { try { const d = JSON.parse(item.detailJson || '{}'); return ((d?.timebank?.otMinutes ?? 0) / 60).toFixed(1) + 'h' } catch { return item.otHours.toFixed(1) + 'h' } })()}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#888' }}>請假</div>
                  <div style={{ fontSize: 14, fontFamily: 'monospace' }}>{item.leaveDays.toFixed(1)}d</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#888' }}>缺勤</div>
                  <div style={{ fontSize: 14, fontFamily: 'monospace', color: item.absentDays > 0 ? '#dc3545' : 'inherit' }}>{item.absentDays.toFixed(1)}d</div>
                </div>
              </div>

              {/* Salary row */}
              <div style={{ borderTop: '1px dashed #e5e7eb', paddingTop: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#888' }}>基本薪資</span>
                  <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{fmtCurrency(item.basePay)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#888' }}>加班費</span>
                  <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{fmtCurrency(item.otPay)}</span>
                </div>
                {item.deduction && item.deduction > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: '#dc3545' }}>扣款</span>
                    <span style={{ fontSize: 13, fontFamily: 'monospace', color: '#dc3545' }}>-{fmtCurrency(item.deduction)}</span>
                  </div>
                )}
              </div>

              {/* Net pay + action */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace' }}>
                  {fmtCurrency(item.totalPayable)}
                </span>
                <div>
                  {confidential ? (
                    <span style={{ color: '#888', fontSize: 12, cursor: 'not-allowed' }} title="此員工薪資已設保密">🔒 保密</span>
                  ) : (
                    <Link href={`/payroll/${runId}/employee/${item.employeeId}`}
                      style={{ color: '#0d6efd', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>
                      明細 →
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
