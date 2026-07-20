'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtDateTime } from '@/lib/hk-date'
import { punchLabel, punchBg, punchTextColor } from '@/lib/punch-label'

export default function MyPunchesPage() {
  const [punches, setPunches] = useState<any[]>([])
  const [corrections, setCorrections] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`  // tz-ok: client-side browser
  })

  // Correction request form state
  const [showCorrectionForm, setShowCorrectionForm] = useState(false)
  const [correctionReqForm, setCorrectionReqForm] = useState({
    date: '', time: '09:00', punchType: 'CLOCK_IN', clinicId: '', reason: '',
  })
  const [submittingCorrection, setSubmittingCorrection] = useState(false)
  const [clinics, setClinics] = useState<any[]>([])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const monthStart = new Date(`${month}-01`)
      const monthEnd = new Date(monthStart)
      monthEnd.setMonth(monthEnd.getMonth() + 1)  // tz-ok: client-side browser
      const res = await fetch(
        `/api/my/punches?from=${monthStart.toISOString()}&to=${monthEnd.toISOString()}`,
        { credentials: 'include' }
      )
      const data = await res.json()
      setPunches(data.punches || [])
      setCorrections(data.corrections || [])
    } catch (err) {
      console.error('Fetch punches error:', err)
    } finally {
      setLoading(false)
    }
  }, [month])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Fetch clinics for correction form
  useEffect(() => {
    fetch('/api/clinics', { credentials: 'include' }).then(async r => {
      if (!r.ok) return
      const d = await r.json()
      setClinics(d.clinics || [])
    })
  }, [])

  const goToMonth = (delta: number) => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)  // tz-ok: client-side browser
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)  // tz-ok: client-side browser
  }

  if (loading) return <div style={{ padding: 24 }}>載入中...</div>

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', margin: 0 }}>📋 我的考勤</h1>
        <button
          onClick={() => {
            setCorrectionReqForm({ date: '', time: '09:00', punchType: 'CLOCK_IN', clinicId: '', reason: '' })
            setShowCorrectionForm(true)
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '10px 20px', borderRadius: 6, border: 'none',
            background: '#0d6efd', color: '#fff', fontSize: 14,
            fontWeight: 600, cursor: 'pointer',
          }}
        >
          ➕ 申請補打卡
        </button>
      </div>

      {/* Punch Records */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>打卡記錄 ({month})</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => goToMonth(-1)}>◀</button>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{month}</span>
            <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => goToMonth(1)}>▶</button>
          </div>
        </div>

        {punches.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>本月尚無打卡記錄</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>時間</th>
                <th>類型</th>
                <th>診所</th>
                <th>來源</th>
              </tr>
            </thead>
            <tbody>
              {punches.map(p => (
                <tr key={p.id}>
                  <td>{fmtDateTime(p.punchTime)}</td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      background: punchBg(p.punchType),
                      color: punchTextColor(p.punchType),
                    }}>
                      {punchLabel(p.punchType)}
                    </span>
                  </td>
                  <td>{p.clinic?.name || '-'}</td>
                  <td style={{ fontSize: 12, color: '#888' }}>{p.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Corrections */}
      <div className="card">
        <h2>補打卡記錄 ({corrections.length})</h2>
        {corrections.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 20 }}>尚無補打卡記錄</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>申請時間</th>
                <th>補登時間</th>
                <th>類型</th>
                <th>診所</th>
                <th>原因</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map(c => {
                const statusMap: Record<string, { label: string; color: string; bg: string }> = {
                  PENDING: { label: '待審批', color: '#e65100', bg: '#fff3e0' },
                  APPROVED: { label: '已批準', color: '#2e7d32', bg: '#e8f5e9' },
                  REJECTED: { label: '已拒絕', color: '#dc3545', bg: '#fdecea' },
                }
                const s = statusMap[c.status] || { label: c.status, color: '#888', bg: '#f0f0f0' }
                return (
                  <tr key={c.id}>
                    <td>{fmtDateTime(c.createdAt)}</td>
                    <td>{fmtDateTime(c.correctedTime)}</td>
                    <td>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        background: punchBg(c.punchType),
                        color: punchTextColor(c.punchType),
                      }}>
                        {punchLabel(c.punchType)}
                      </span>
                    </td>
                    <td>{c.clinicId ? `Clinic: ${c.clinicId.substring(0, 8)}` : '-'}</td>
                    <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.reason || '-'}
                    </td>
                    <td>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        background: s.bg,
                        color: s.color,
                      }}>
                        {s.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Correction Request Modal */}
      {showCorrectionForm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}
          onClick={() => setShowCorrectionForm(false)}
        >
          <div
            className="card"
            style={{ width: 420, maxWidth: '90vw', position: 'relative', padding: 24 }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setShowCorrectionForm(false)}
              style={{
                position: 'absolute', top: 12, right: 12,
                background: 'none', border: 'none', fontSize: 18,
                cursor: 'pointer', color: '#888',
              }}
            >
              ✕
            </button>
            <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 16 }}>
              ➕ 申請補打卡
            </h2>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
                日期 *
              </label>
              <input
                type="date"
                value={correctionReqForm.date}
                onChange={e => setCorrectionReqForm({ ...correctionReqForm, date: e.target.value })}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6,
                  border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
                  上工 / 落班 *
                </label>
                <select
                  value={correctionReqForm.punchType}
                  onChange={e => setCorrectionReqForm({ ...correctionReqForm, punchType: e.target.value })}
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: 6,
                    border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
                  }}
                >
                  <option value="CLOCK_IN">上工</option>
                  <option value="CLOCK_OUT">落班</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
                  正確時間 *
                </label>
                <input
                  type="time"
                  value={correctionReqForm.time}
                  onChange={e => setCorrectionReqForm({ ...correctionReqForm, time: e.target.value })}
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: 6,
                    border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
                診所 *
              </label>
              <select
                value={correctionReqForm.clinicId}
                onChange={e => setCorrectionReqForm({ ...correctionReqForm, clinicId: e.target.value })}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6,
                  border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
                }}
              >
                <option value="">選擇診所</option>
                {clinics.map((cl) => (
                  <option key={cl.id} value={cl.id}>{cl.name}</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
                原因
              </label>
              <textarea
                value={correctionReqForm.reason}
                onChange={e => setCorrectionReqForm({ ...correctionReqForm, reason: e.target.value })}
                placeholder="請說明補打卡原因"
                rows={3}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6,
                  border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
                  resize: 'vertical',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowCorrectionForm(false)}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: '1px solid #ddd',
                  background: '#f5f5f5', cursor: 'pointer', fontSize: 13,
                }}
              >
                取消
              </button>
              <button
                onClick={async () => {
                  const { date, time, punchType, clinicId, reason } = correctionReqForm
                  if (!date || !clinicId) {
                    alert('請填寫日期和診所')
                    return
                  }
                  setSubmittingCorrection(true)
                  try {
                    const datetime = `${date}T${time}:00+08:00`
                    const res = await fetch('/api/punch-corrections', {
                      method: 'POST',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ date: datetime, punchType, reason, clinicId }),
                    })
                    if (res.ok) {
                      alert('補打卡申請已提交')
                      setShowCorrectionForm(false)
                      fetchData()
                    } else {
                      const err = await res.json()
                      alert(err.error || '提交失敗')
                    }
                  } catch (err) {
                    alert('網路錯誤')
                  } finally {
                    setSubmittingCorrection(false)
                  }
                }}
                disabled={submittingCorrection}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  background: submittingCorrection ? '#ccc' : '#0d6efd',
                  color: '#fff', cursor: submittingCorrection ? 'default' : 'pointer',
                  fontSize: 13, fontWeight: 600,
                }}
              >
                {submittingCorrection ? '提交中...' : '提交申請'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
