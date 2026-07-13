'use client'

import { useEffect, useState } from 'react'

interface Clinic {
  id: string
  name: string
  shortName: string | null
  address: string | null
  createdAt: string
}

export default function ClinicsPage() {
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', address: '', shortName: '' })
  const [error, setError] = useState('')

  const fetchClinics = async () => {
    const res = await fetch('/api/clinics', { credentials: 'include' })
    const data = await res.json()
    setClinics(data.clinics || [])
    setLoading(false)
  }

  useEffect(() => { fetchClinics() }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    const res = await fetch('/api/clinics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error || '建立失敗')
      return
    }
    setForm({ name: '', address: '', shortName: '' })
    setShowForm(false)
    fetchClinics()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('確定要刪除此診所嗎？')) return
    const res = await fetch(`/api/clinics/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (res.ok) fetchClinics()
  }

  if (loading) return <div>載入中...</div>

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h1 style={{ margin: 0 }}>診所管理</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? '取消' : '+ 新增診所'}
        </button>
      </div>

      {showForm && (
        <div className="card mb-4">
          <h2>新增診所</h2>
          {error && <div style={{ color: 'red', marginBottom: 12 }}>{error}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label>診所名稱 *</label>
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="例如: 銅鑼灣診所"
                required
              />
            </div>
            <div className="form-group">
              <label>簡稱（1-2字，總覽膠囊顯示）</label>
              <input
                value={form.shortName}
                onChange={e => setForm({ ...form, shortName: e.target.value })}
                placeholder="例如: 銅"
                maxLength={4}
              />
            </div>
            <div className="form-group">
              <label>地址</label>
              <input
                value={form.address}
                onChange={e => setForm({ ...form, address: e.target.value })}
                placeholder="例如: 香港銅鑼灣謝菲頓街22號"
              />
            </div>
            <button type="submit" className="btn btn-primary">建立診所</button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>診所列表 ({clinics.length})</h2>
        {clinics.length === 0 ? (
          <div className="text-muted">暫無診所</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>名稱</th>
                <th>簡稱</th>
                <th>地址</th>
                <th>建立時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {clinics.map(clinic => (
                <tr key={clinic.id}>
                  <td style={{ fontWeight: 500 }}>{clinic.name}</td>
                  <td className="text-muted">{clinic.shortName || '—'}</td>
                  <td className="text-muted">{clinic.address || '—'}</td>
                  <td className="text-sm">{new Date(clinic.createdAt).toLocaleDateString('zh-HK')}</td>
                  <td>
                    <button className="btn btn-sm" style={{ marginRight: 4 }} onClick={async () => {
                      const newShort = prompt('修改簡稱（1-2字）：', clinic.shortName || '')
                      if (newShort === null) return
                      try {
                        const res = await fetch(`/api/clinics/${clinic.id}`, {
                          method: 'PUT',
                          credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ shortName: newShort || null }),
                        })
                        if (res.ok) fetchClinics()
                        else alert('修改失敗')
                      } catch { alert('修改失敗') }
                    }}>簡稱</button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(clinic.id)}>
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
