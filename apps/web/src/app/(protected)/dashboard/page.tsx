'use client'

import { useEffect, useState } from 'react'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

interface TodayStats {
  clinicId: string
  clinicName: string
  scheduled: number
  clockedIn: number
  late: number
  notArrived: number
}

interface ClinicData {
  id: string
  name: string
  address: string | null
  _count: {
    users: number
    employees: number
    shifts: number
    punches?: number
  }
  todayStats: TodayStats | null
}

interface AuditLogData {
  id: string
  action: string
  entity: string
  notes: string | null
  createdAt: string
  actor: {
    name: string
    role: string
  }
}

export default function DashboardPage() {
  const [data, setData] = useState<{
    role: Role
    clinics: ClinicData[]
    recentAuditLogs: AuditLogData[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/dashboard', { credentials: 'include' })
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `伺服器錯誤 (${res.status})`)
        }
        return res.json()
      })
      .then(setData)
      .catch(err => setError(err.message || '載入失敗'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: 24 }}>載入中...</div>
  if (error) return <div style={{ padding: 24, color: '#c00' }}>⚠️ {error}</div>
  if (!data) return <div style={{ padding: 24 }}>沒有資料</div>

  const roleLabels: Record<Role, string> = {
    OWNER: '創辦人 / 總管理',
    MANAGER: '診所經理',
    ACCOUNTANT: '會計',
    EMPLOYEE: '員工',
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>儀表板</h1>
          <p className="text-muted">角色: {roleLabels[data.role]}</p>
        </div>
      </div>

      {/* Stats overview */}
      <div className="grid-4 mb-4">
        <div className="stat-card">
          <div className="stat-value">{data.clinics?.length ?? 0}</div>
          <div className="stat-label">可見診所</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {(data.clinics ?? []).reduce((sum, c) => sum + (c._count?.employees ?? 0), 0)}
          </div>
          <div className="stat-label">總員工數</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {(data.clinics ?? []).reduce((sum, c) => sum + (c._count?.shifts ?? 0), 0)}
          </div>
          <div className="stat-label">總班數</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.recentAuditLogs?.length ?? 0}</div>
          <div className="stat-label">最近審計記錄</div>
        </div>
      </div>

      {/* ── Today's Daily Operations (multi-clinic) ── */}
      <div className="card mb-4">
        <h2>📅 今日各店營運</h2>
        <div className="grid-2">
          {(data.clinics ?? []).map(clinic => {
            const stats = clinic.todayStats
            return (
              <div
                key={clinic.id}
                style={{
                  border: '1px solid #eee',
                  borderRadius: 8,
                  padding: 16,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 12 }}>
                  {clinic.name}
                </div>

                {stats ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>📋 排班</span>
                      <span style={{ fontWeight: 600 }}>{stats.scheduled} 人</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>✅ 已到</span>
                      <span style={{ fontWeight: 600, color: '#27ae60' }}>{stats.clockedIn} 人</span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        color: stats.late > 0 ? '#c0392b' : 'inherit',
                      }}
                    >
                      <span>⚠️ 遲到</span>
                      <span style={{ fontWeight: 600 }}>{stats.late} 人</span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        color: stats.notArrived > 0 ? '#e67e22' : 'inherit',
                      }}
                    >
                      <span>⏳ 未到</span>
                      <span style={{ fontWeight: 600 }}>{stats.notArrived} 人</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-muted text-sm">今日無排班資料</div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Clinics overview (legacy) */}
      <div className="card">
        <h2>診所概要</h2>
        <div className="grid-2">
          {(data.clinics ?? []).map(clinic => (
            <div key={clinic.id} style={{
              border: '1px solid #eee',
              borderRadius: 8,
              padding: 16,
              transition: 'box-shadow 0.2s',
            }}>
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>{clinic.name}</div>
              {clinic.address && <div className="text-muted text-sm mb-4">{clinic.address}</div>}
              <div className="flex gap-4" style={{ fontSize: 13 }}>
                <span>👥 {clinic._count?.users || 0} 用戶</span>
                <span>👤 {clinic._count?.employees || 0} 員工</span>
                <span>📋 {clinic._count?.shifts || 0} 班</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent audit logs (OWNER/MANAGER/ACCOUNTANT only) */}
      {(data.recentAuditLogs?.length ?? 0) > 0 && (
        <div className="card">
          <h2>最近審計日誌</h2>
          <table>
            <thead>
              <tr>
                <th>時間</th>
                <th>操作者</th>
                <th>操作</th>
                <th>實體</th>
                <th>備註</th>
              </tr>
            </thead>
            <tbody>
              {(data.recentAuditLogs ?? []).map(log => (
                <tr key={log.id}>
                  <td>{new Date(log.createdAt).toLocaleString('zh-HK')}</td>
                  <td>
                    <span>{log.actor.name}</span>
                    <span className={`badge badge-${log.actor.role.toLowerCase()}`} style={{ marginLeft: 6 }}>
                      {log.actor.role}
                    </span>
                  </td>
                  <td><code style={{ fontSize: 12 }}>{log.action}</code></td>
                  <td>{log.entity}</td>
                  <td className="text-muted text-sm">{log.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
