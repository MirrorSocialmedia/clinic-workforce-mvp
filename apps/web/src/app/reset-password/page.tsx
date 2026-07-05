'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function ForgotPasswordPage() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resetToken, setResetToken] = useState('')

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage('')
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || '請求失敗')
        return
      }

      setMessage(data.message)
      if (data.resetToken) {
        setResetToken(data.resetToken)
      }
    } catch {
      setError('網絡錯誤')
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)

    const newPassword = (document.getElementById('newPassword') as HTMLInputElement)?.value

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || '重置失敗')
        return
      }

      setMessage(data.message)
      setTimeout(() => router.push('/login'), 2000)
    } catch {
      setError('網絡錯誤')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>🔑 重置密碼</h1>
        <p>輸入手機號碼取得重置令牌</p>

        <Link href="/login" style={{ fontSize: 13, color: '#1a1a2e', textDecoration: 'underline' }}>
          ← 返回登入
        </Link>

        {message && (
          <div style={{ background: '#e8f5e9', color: '#2e7d32', padding: '10px 14px', borderRadius: 6, marginTop: 16, fontSize: 14 }}>
            {message}
          </div>
        )}

        {error && (
          <div style={{ background: '#fee', color: '#c00', padding: '10px 14px', borderRadius: 6, marginTop: 16, fontSize: 14 }}>
            {error}
          </div>
        )}

        {/* Step 1: Request reset token */}
        {!resetToken ? (
          <form onSubmit={handleForgot} style={{ marginTop: 20 }}>
            <div className="form-group">
              <label>手機號碼</label>
              <input
                type="text"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="91000001"
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} disabled={loading}>
              {loading ? '發送中...' : '取得重置令牌'}
            </button>
          </form>
        ) : (
          /* Step 2: Set new password */
          <form onSubmit={handleReset} style={{ marginTop: 20 }}>
            <div className="form-group">
              <label>新密碼</label>
              <input
                id="newPassword"
                type="password"
                placeholder="至少 6 個字元"
                minLength={6}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} disabled={loading}>
              {loading ? '重置中...' : '重置密碼'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
