'use client'

import { useEffect, useState } from 'react'
import { fmtDate } from '@/lib/hk-date'

interface Clinic {
  id: string
  name: string
  shortName: string | null
  address: string | null
  companyId: string | null
  company: { id: string; name: string } | null
  createdAt: string
}

interface Company {
  id: string
  name: string
  _count: { clinics: number }
  createdAt: string
}

export default function ClinicsPage() {
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', address: '', shortName: '', companyId: '' })
  const [error, setError] = useState('')
  const [editingClinicId, setEditingClinicId] = useState<string | null>(null)
  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null)
  const [newCompanyName, setNewCompanyName] = useState('')

  const fetchAll = async () => {
    const [clinicsRes, companiesRes] = await Promise.all([
      fetch('/api/clinics', { credentials: 'include' }),
      fetch('/api/companies', { credentials: 'include' }),
    ])
    const clinicsData = await clinicsRes.json()
    const companiesData = await companiesRes.json()
    setClinics(clinicsData.clinics || [])
    setCompanies(Array.isArray(companiesData) ? companiesData : [])
    setLoading(false)
  }

  useEffect(() => { fetchAll() }, [])

  // ── Company management ──

  const handleAddCompany = async () => {
    if (!newCompanyName.trim()) return
    const res = await fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newCompanyName.trim() }),
      credentials: 'include',
    })
    if (res.ok) {
      setNewCompanyName('')
      fetchAll()
    } else {
      const err = await res.json()
      alert(err.error || '建立失敗')
    }
  }

  const handleRenameCompany = async (id: string) => {
    const newName = prompt('修改公司名稱：', companies.find(c => c.id === id)?.name)
    if (!newName || newName.trim() === '') return
    const res = await fetch(`/api/companies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
      credentials: 'include',
    })
    if (res.ok) fetchAll()
    else alert('修改失敗')
  }

  const handleDeleteCompany = async (id: string) => {
    if (!confirm('確定要刪除此公司嗎？（診所會變為未分組）')) return
    const res = await fetch(`/api/companies/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (res.ok) fetchAll()
  }

  // ── Clinic CRUD ──

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.companyId) {
      setError('請選擇所屬公司')
      return
    }
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
    setForm({ name: '', address: '', shortName: '', companyId: '' })
    setShowForm(false)
    fetchAll()
  }

  const handleDeleteClinic = async (id: string) => {
    if (!confirm('確定要刪除此診所嗎？')) return
    const res = await fetch(`/api/clinics/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (res.ok) fetchAll()
  }

  const handleEditClinic = async (clinic: Clinic) => {
    const newName = prompt('修改診所名稱：', clinic.name)
    if (newName === null) return
    if (newName.trim() === '') return

    // Company selection via prompt (company IDs)
    const companyOptions = companies.map(c => `${c.id.slice(0, 6)}… ${c.name}`).join('\n')
    const companyChoice = prompt(
      `選擇公司（輸入索引或留空保持不變）：\n${companies.map((c, i) => `${i}: ${c.name}`).join('\n')}\n目前: ${clinic.company?.name || '無'}`,
      ''
    )
    let companyId = clinic.companyId
    if (companyChoice !== null && companyChoice.trim() !== '') {
      const idx = parseInt(companyChoice.trim())
      if (!isNaN(idx) && companies[idx]) companyId = companies[idx].id
    }

    const newShort = prompt('修改簡稱（1-2字，留空不修改）：', clinic.shortName || '')
    if (newShort === null) return
    const newAddress = prompt('修改地址（留空不修改）：', clinic.address || '')
    if (newAddress === null) return

    const body: Record<string, any> = { name: newName.trim() }
    if (newShort?.trim()) body.shortName = newShort.trim()
    else if (newShort === '') body.shortName = null
    if (newAddress?.trim()) body.address = newAddress.trim()
    if (companyId !== clinic.companyId) body.companyId = companyId || null

    const res = await fetch(`/api/clinics/${clinic.id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) fetchAll()
    else alert('修改失敗')
  }

  if (loading) return <div>載入中...</div>

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h1 style={{ margin: 0 }}>診所管理</h1>
      </div>

      {/* ── Company Management Card ── */}
      <div className="card mb-4">
        <h2>🏢 公司管理</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={newCompanyName}
            onChange={e => setNewCompanyName(e.target.value)}
            placeholder="新公司名稱"
            style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14 }}
            onKeyDown={e => e.key === 'Enter' && handleAddCompany()}
          />
          <button className="btn btn-primary" onClick={handleAddCompany}>+ 新增公司</button>
        </div>
        {companies.length === 0 ? (
          <div className="text-muted" style={{ fontSize: 13 }}>暫無公司</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>公司名稱</th>
                <th>診所數</th>
                <th>建立時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {companies.map(company => (
                <tr key={company.id}>
                  <td style={{ fontWeight: 500 }}>{company.name}</td>
                  <td className="num">{company._count?.clinics ?? 0}</td>
                  <td className="text-sm">{fmtDate(company.createdAt)}</td>
                  <td>
                    <button className="btn btn-sm" style={{ marginRight: 4 }} onClick={() => handleRenameCompany(company.id)}>改名</button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDeleteCompany(company.id)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Add Clinic Form ── */}
      {showForm && (
        <div className="card mb-4">
          <h2>新增診所</h2>
          {error && <div style={{ color: 'red', marginBottom: 12 }}>{error}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label>所屬公司 *</label>
              <select
                value={form.companyId}
                onChange={e => setForm({ ...form, companyId: e.target.value })}
                required
              >
                <option value="">選擇公司...</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
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
            <button type="button" className="btn" style={{ marginLeft: 8, background: '#f0f0f0' }} onClick={() => setShowForm(false)}>取消</button>
          </form>
        </div>
      )}

      {/* ── Clinics List ── */}
      <div className="card">
        <div className="flex justify-between items-center" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>診所列表 ({clinics.length})</h2>
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? '取消' : '+ 新增診所'}
          </button>
        </div>
        {clinics.length === 0 ? (
          <div className="text-muted">暫無診所</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>公司</th>
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
                  <td className="text-sm">{clinic.company?.name || '—'}</td>
                  <td style={{ fontWeight: 500 }}>{clinic.name}</td>
                  <td className="text-muted">{clinic.shortName || '—'}</td>
                  <td className="text-muted">{clinic.address || '—'}</td>
                  <td className="text-sm">{fmtDate(clinic.createdAt)}</td>
                  <td>
                    <button className="btn btn-sm" style={{ marginRight: 4 }} onClick={() => handleEditClinic(clinic)}>編輯</button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDeleteClinic(clinic.id)}>
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
