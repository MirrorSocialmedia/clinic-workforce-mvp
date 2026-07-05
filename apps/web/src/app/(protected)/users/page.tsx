'use client'

import { useEffect, useState } from 'react'

interface User {
  id: string
  name: string
  phone: string
  email: string | null
  role: string
  status: string
  clinics: Array<{ clinic: { id: string; name: string } }>
  createdAt: string
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [clinics, setClinics] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    name: '', phone: '', email: '', password: '', role: 'EMPLOYEE', clinicIds: [] as string[]
  })
  const [error, setError] = useState('')

  const fetchUsers = async () => {
    const res = await fetch('/api/users', { credentials: 'include' })
    const data = await res.json()
    setUsers(data.users || [])
  }

  const fetchClinics = async () => {
    const res = await fetch('/api/clinics', { credentials: 'include' })
    const data = await res.json()
    setClinics(data.clinics || [])
  }

  useEffect(() => {
    Promise.all([fetchUsers(), fetchClinics()]).then(() => setLoading(false))
  }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, assignEmployee: true }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error || '建立失敗')
      return
    }
    setForm({ name: '', phone: '', email: '', password: '', role: 'EMPLOYEE', clinicIds: [] })
    setShowForm(false)
    fetchUsers()
  }

  const badgeClass = (role: string) => `badge badge-${role.toLowerCase()}`

  if (loading) return <div>載入中...</div>

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h1 style={{ margin: 0 }}>用戶管理</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? '取消' : '+ 新增用戶'}
        </button>
      </div>

      {showForm && (
        <div className="card mb-4">
          <h2>新增用戶</h2>
          {error && <div style={{ color: 'red', marginBottom: 12 }}>{error}</div>}
          <form onSubmit={handleCreate}>
            <div className="grid-2">
              <div className="form-group">
                <label>姓名 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>手機號碼 *</label>
                <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="form-group">
                <label>密碼 *</label>
                <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>角色 *</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                  <option value="OWNER">創辦人</option>
                  <option value="MANAGER">經理</option>
                  <option value="ACCOUNTANT">會計</option>
                  <option value="EMPLOYEE">員工</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>分配診所</label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {clinics.map(clinic => (
                  <label key={clinic.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={form.clinicIds.includes(clinic.id)}
                      onChange={e => {
                        const ids = e.target.checked
                          ? [...form.clinicIds, clinic.id]
                          : form.clinicIds.filter(id => id !== clinic.id)
                        setForm({ ...form, clinicIds: ids })
                      }}
                    />
                    {clinic.name}
                  </label>
                ))}
              </div>
            </div>
            <button type="submit" className="btn btn-primary">建立用戶</button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>用戶列表 ({users.length})</h2>
        {users.length === 0 ? (
          <div className="text-muted">暫無用戶</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>姓名</th>
                <th>手機</th>
                <th>角色</th>
                <th>狀態</th>
                <th>診所</th>
                <th>建立時間</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id}>
                  <td style={{ fontWeight: 500 }}>{user.name}</td>
                  <td>{user.phone}</td>
                  <td><span className={badgeClass(user.role)}>{user.role}</span></td>
                  <td>{user.status}</td>
                  <td className="text-sm">
                    {user.clinics.map(uc => uc.clinic.name).join(', ') || '—'}
                  </td>
                  <td className="text-sm">{new Date(user.createdAt).toLocaleDateString('zh-HK')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
