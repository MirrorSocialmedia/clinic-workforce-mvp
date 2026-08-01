'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ChangePasswordPage() {
  const router = useRouter()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setErr('')
    if (next !== confirm) { setErr('兩次輸入嘅新密碼唔一致'); return }
    if (next.length < 6) { setErr('新密碼至少 6 個字元'); return }

    setBusy(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      const data = await res.json()
      if (!res.ok) { setErr(data.error || '修改失敗'); return }

      // ★ tokenVersion 已 bump，呢個 session 已經失效 —— 要登出再登入
      alert('密碼已更新，請用新密碼重新登入')
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
      router.replace('/login')
    } catch {
      setErr('網絡錯誤，請重試')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 420 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>修改密碼</h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, color: '#666' }}>目前密碼</label>
          <input type="password" value={current} onChange={e => setCurrent(e.target.value)}
            autoComplete="current-password"
            style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ddd' }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#666' }}>新密碼（至少 6 個字元）</label>
          <input type="password" value={next} onChange={e => setNext(e.target.value)}
            autoComplete="new-password"
            style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ddd' }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#666' }}>確認新密碼</label>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
            style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ddd' }} />
        </div>

        {err && (
          <div style={{ background: '#fee2e2', color: '#b91c1c', padding: 10, borderRadius: 8, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ fontSize: 12, color: '#6b7280' }}>
          ⚠️ 修改後所有已登入嘅裝置（包括呢一部）都要重新登入。
        </div>

        <button onClick={submit} disabled={busy || !current || !next || !confirm}
          style={{
            padding: 12, borderRadius: 8, border: 'none', fontSize: 15, fontWeight: 600,
            background: busy ? '#9ca3af' : '#2563eb', color: '#fff',
          }}>
          {busy ? '處理中…' : '更新密碼'}
        </button>
      </div>
    </div>
  )
}
