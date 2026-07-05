import Link from 'next/link'

export default function NotFound() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: '#f5f5f5',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      padding: 24,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 72, marginBottom: 16 }}>🏥</div>
      <h1 style={{ fontSize: 48, fontWeight: 700, color: '#1a1a2e', margin: '0 0 8px' }}>404</h1>
      <p style={{ fontSize: 18, color: '#666', margin: '0 0 24px' }}>找不到該頁面</p>
      <p style={{ color: '#888', marginBottom: 32 }}>你尋找的頁面不存在或已被移動。</p>
      <Link
        href="/dashboard"
        style={{
          display: 'inline-block',
          padding: '12px 24px',
          background: '#1a1a2e',
          color: 'white',
          borderRadius: 6,
          textDecoration: 'none',
          fontWeight: 500,
        }}
      >
        返回儀表板
      </Link>
    </div>
  )
}
