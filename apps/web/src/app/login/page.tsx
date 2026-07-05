'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password }),
        credentials: 'include',
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || '登入失敗')
        return
      }

      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('網絡錯誤')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>🏥 診所系統</h1>
        <p>勞動力管理系統 — 登入</p>

        {error && (
          <div style={{ background: '#fee', color: '#c00', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>手機號碼</label>
            <input
              type="text"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="91000001"
              autoFocus
              required
            />
          </div>

          <div className="form-group">
            <label>密碼</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="輸入密碼"
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} disabled={loading}>
            {loading ? '登入中...' : '登入'}
          </button>
        </form>

        <div style={{ marginTop: 20, padding: '12px', background: '#f9f9f9', borderRadius: 6, fontSize: 12, color: '#888' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>測試帳號（密碼: demo1234）</div>
          <div>👑 Owner: 91000001</div>
          <div>📋 Manager: 91000002</div>
          <div>💰 Accountant: 91000003</div>
          <div>👤 Employee: 91000004</div>
        </div>
      </div>
    </div>
  )
}
