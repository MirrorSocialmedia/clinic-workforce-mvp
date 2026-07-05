'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

interface PayrollItemData {
  id: string
  runId: string
  employeeId: string
  workedHours: number
  otHours: number
  leaveDays: number
  absentDays: number
  basePay: number
  otPay: number
  splitPay: number | null
  deduction: number
  totalPayable: number
  detailJson: string | null
  run: {
    periodMonth: string
    clinic: { id: string; name: string } | null
  }
  employee: {
    user: { id: string; name: string; phone: string }
    clinics: { clinicId: string; clinic: { name: string } }[]
    payRules: Array<{ payType: string; configJson: string | null }>
  }
}

export default function EmployeePayrollDetailPage() {
  const params = useParams()
  const router = useRouter()
  const runId = params.id as string
  const empId = params.empId as string

  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/payroll-runs/${runId}/employee/${empId}`)
      if (!res.ok) {
        if (res.status === 404) router.push(`/payroll/${runId}`)
        return
      }
      setData(await res.json())
    } catch (err) {
      console.error('Failed to fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [runId, empId, router])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>載入中...</div>
  }

  if (!data) {
    return <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>找不到明細</div>
  }

  const item = data.item as PayrollItemData
  const detail = data.detail || {}
  const punches = data.punches || []
  const leaves = data.leaves || []
  const corrections = data.corrections || []

  const fmtCurrency = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtTime = (d: Date | string) => new Date(d).toLocaleString('zh-HK')
  const payType = item.employee.payRules[0]?.payType || '-'

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Link href={`/payroll/${runId}`} style={{ color: '#0d6efd', textDecoration: 'none', fontSize: 14 }}>
            ← 返回計糧
          </Link>
        </div>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {item.employee.user.name} 的薪資明細
        </h1>
        <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
          期間: {data.periodMonth} | 診所: {item.employee.clinics.map(c => c.clinic.name).join(', ')} | 薪酬: {payType} | 電話: {item.employee.user.phone}
        </div>
      </div>

      {/* Salary Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div style={{ padding: 20, border: '1px solid #dee2e6', borderRadius: 8 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16, color: '#495057' }}>📊 工時統計</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              ['工作時數', `${item.workedHours.toFixed(2)}h`],
              ['加班時數', `${item.otHours.toFixed(2)}h`],
              ['請假日數', `${item.leaveDays.toFixed(2)} 天`],
              ['缺勤日數', `${item.absentDays.toFixed(2)} 天`],
            ].map(([label, value]) => (
              <div key={label as string} style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ fontSize: 12, color: '#888' }}>{label}</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: 20, border: '1px solid #dee2e6', borderRadius: 8 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16, color: '#495057' }}>💰 薪資拆解</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              ['基本薪資', fmtCurrency(item.basePay), '#0d6efd'],
              ['加班費', fmtCurrency(item.otPay), '#198754'],
              ['拆帳', item.splitPay ? fmtCurrency(item.splitPay) : '-', '#8B5CF6'],
              ['扣款', fmtCurrency(item.deduction), '#dc3545'],
              ['應付總額', fmtCurrency(item.totalPayable), '#0d6efd'],
            ].map(([label, value, color]) => (
              <div key={label as string} style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ fontSize: 12, color: '#888' }}>{label}</div>
                <div style={{ fontSize: 16, fontWeight: label === '應付總額' ? 700 : 600, color: (color as string) }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Calculation Detail */}
      {Object.keys(detail).length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 16, color: '#495057', marginBottom: 8 }}>📐 計算參數</h3>
          <div style={{
            padding: 16,
            background: '#f8f9fa',
            borderRadius: 6,
            fontSize: 13,
            fontFamily: 'monospace',
            overflowX: 'auto',
          }}>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(detail, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Punch Records */}
      {punches.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 16, color: '#495057', marginBottom: 8 }}>📋 打卡記錄 ({punches.length} 筆)</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #dee2e6' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>日期</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>診所</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>時間</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>類型</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>來源</th>
                </tr>
              </thead>
              <tbody>
                {punches.map((p: any) => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '6px 8px' }}>{new Date(p.punchTime).toLocaleDateString('zh-HK')}</td>
                    <td style={{ padding: '6px 8px' }}>{p.clinicId}</td>
                    <td style={{ padding: '6px 8px' }}>{fmtTime(p.punchTime)}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{
                        color: p.punchType === 'CLOCK_IN' ? '#198754' : '#dc3545',
                        fontWeight: 600,
                      }}>
                        {p.punchType === 'CLOCK_IN' ? '上班' : '下班'}
                      </span>
                    </td>
                    <td style={{ padding: '6px 8px', fontSize: 12 }}>{p.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Leave Records */}
      {leaves.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 16, color: '#495057', marginBottom: 8 }}>🏖️ 已批假期 ({leaves.length} 筆)</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #dee2e6' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>假期類型</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>開始</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>結束</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>天數</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>有薪</th>
                </tr>
              </thead>
              <tbody>
                {leaves.map((l: any) => (
                  <tr key={l.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '6px 8px' }}>{l.leaveType.name}</td>
                    <td style={{ padding: '6px 8px' }}>{new Date(l.startDate).toLocaleDateString('zh-HK')}</td>
                    <td style={{ padding: '6px 8px' }}>{new Date(l.endDate).toLocaleDateString('zh-HK')}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{l.days}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{ color: l.leaveType.isPaid ? '#198754' : '#dc3545' }}>
                        {l.leaveType.isPaid ? '有薪' : '無薪'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Corrections */}
      {corrections.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 16, color: '#495057', marginBottom: 8 }}>✏️ 考勤補登 ({corrections.length} 筆)</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #dee2e6' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>補登時間</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>診所</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>類型</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>原因</th>
                </tr>
              </thead>
              <tbody>
                {corrections.map((c: any) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '6px 8px' }}>{fmtTime(c.correctedTime)}</td>
                    <td style={{ padding: '6px 8px' }}>{c.clinicId}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {c.punchType === 'CLOCK_IN' ? '上班' : '下班'}
                    </td>
                    <td style={{ padding: '6px 8px', fontSize: 12, color: '#888' }}>{c.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
