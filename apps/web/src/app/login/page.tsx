'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
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
        body: JSON.stringify({ phone, password, rememberMe }),
        credentials: 'include',
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || '登入失敗')
        return
      }

      const redirectUrl = data.user?.role === 'EMPLOYEE' ? '/my/dashboard' : '/dashboard'
      router.push(redirectUrl)
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

          <div style={{ display: 'flex', alignItems: 'center', marginTop: 12, gap: 6 }}>
            <input
              type="checkbox"
              id="rememberMe"
              checked={rememberMe}
              onChange={e => setRememberMe(e.target.checked)}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <label htmlFor="rememberMe" style={{ fontSize: 13, color: '#1a1a2e', cursor: 'pointer' }}>
              記住我
            </label>
          </div>
        </form>
      </div>
    </div>
  )
}
