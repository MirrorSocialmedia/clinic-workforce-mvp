'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

export default function EmployeesOverviewPage() {
  const [employees, setEmployees] = useState<any[]>([])
  const [userRole, setUserRole] = useState('')
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [clinicFilter, setClinicFilter] = useState('all')

  useEffect(() => {
    Promise.all([
      fetch('/api/me', { credentials: 'include', cache: 'no-store' }).then(r => r.json()),
      fetch('/api/employees?status=ACTIVE&all=1&excludeConfidential=1', { credentials: 'include', cache: 'no-store' }).then(r => r.json()),
    ])
      .then(([me, emp]) => {
        setUserRole(me.user?.role || '')
        setEmployees(emp.employees || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const isOwner = userRole === 'OWNER' // ROLE-OK: 前端提示保密員工過濾，同 API 層一致

  const visible = employees
    .filter(e => clinicFilter === 'all' || (e.homeClinic && e.homeClinic.id === clinicFilter))
    .filter(e => !q || (e.user?.name || '').includes(q) || (e.user?.phone || '').includes(q))

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>載入中…</div>

  // 診所列表
  const clinics = [...new Map(
    employees.filter(e => e.homeClinic)
      .map(e => [e.homeClinic.id, e.homeClinic])
  ).values()] as any[]

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>員工總覽</h1>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
        撳員工查看完整資料：薪酬、假期、時間帳戶、考勤、計糧記錄
        {!isOwner && <span style={{ color: '#b45309' }}> · 薪酬保密員工唔會顯示</span>}
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          placeholder="搜尋姓名 / 電話"
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', minWidth: 200 }}
        />
        <select value={clinicFilter} onChange={e => setClinicFilter(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd' }}>
          <option value="all">全部診所</option>
          {clinics.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span style={{ alignSelf: 'center', fontSize: 12, color: '#6b7280' }}>
          共 {visible.length} 人
        </span>
      </div>

      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {visible.map(e => (
          <Link
            key={e.id}
            href={`/employees/${e.id}/overview`}
            style={{
              display: 'block', padding: 14, borderRadius: 10,
              border: '1px solid #e5e7eb', background: '#fff', textDecoration: 'none', color: 'inherit',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              {e.user?.name}
              {e.user?.fullName && (
                <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>{e.user.fullName}</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
              {e.homeClinic?.name || '未設長駐店'} ·
              {e.payRules?.[0]?.payType === 'HOURLY' ? '時薪' : '月薪'}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
              入職 {e.joinDate ? String(e.joinDate).slice(0, 10) : '未設定'}
            </div>
          </Link>
        ))}
      </div>

      {visible.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          冇符合條件嘅員工
        </div>
      )}
    </div>
  )
}
