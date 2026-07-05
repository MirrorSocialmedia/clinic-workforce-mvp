'use client'

import { useEffect, useState, useCallback } from 'react'

export default function MyPunchesPage() {
  const [punches, setPunches] = useState<any[]>([])
  const [corrections, setCorrections] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const monthStart = new Date(`${month}-01`)
      const monthEnd = new Date(monthStart)
      monthEnd.setMonth(monthEnd.getMonth() + 1)
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

  const goToMonth = (delta: number) => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  if (loading) return <div style={{ padding: 24 }}>載入中...</div>

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', marginBottom: 24 }}>📋 我的考勤</h1>

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
                  <td>{new Date(p.punchTime).toLocaleString('zh-HK')}</td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      background: p.punchType === 'CLOCK_IN' ? '#e8f5e9' : '#fff3e0',
                      color: p.punchType === 'CLOCK_IN' ? '#2e7d32' : '#e65100',
                    }}>
                      {p.punchType === 'CLOCK_IN' ? '上班' : '下班'}
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
                  APPROVED: { label: '已批准', color: '#2e7d32', bg: '#e8f5e9' },
                  REJECTED: { label: '已拒絕', color: '#dc3545', bg: '#fdecea' },
                }
                const s = statusMap[c.status] || { label: c.status, color: '#888', bg: '#f0f0f0' }
                return (
                  <tr key={c.id}>
                    <td>{new Date(c.createdAt).toLocaleString('zh-HK')}</td>
                    <td>{new Date(c.correctedTime).toLocaleString('zh-HK')}</td>
                    <td>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        background: c.punchType === 'CLOCK_IN' ? '#e8f5e9' : '#fff3e0',
                        color: c.punchType === 'CLOCK_IN' ? '#2e7d32' : '#e65100',
                      }}>
                        {c.punchType === 'CLOCK_IN' ? '上班' : '下班'}
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
    </div>
  )
}
