'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log error to monitoring service in production
    console.error('Application error:', error)
  }, [error])

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
      <div style={{ fontSize: 72, marginBottom: 16 }}>⚠️</div>
      <h1 style={{ fontSize: 36, fontWeight: 700, color: '#dc3545', margin: '0 0 8px' }}>
        發生錯誤
      </h1>
      <p style={{ fontSize: 16, color: '#666', margin: '0 0 8px' }}>
        系統遇到意外錯誤
      </p>
      {error.message && (
        <p style={{ fontSize: 13, color: '#888', margin: '0 0 24px', fontStyle: 'italic' }}>
          {error.message}
        </p>
      )}
      <div style={{ display: 'flex', gap: 12 }}>
        <button
          onClick={reset}
          style={{
            padding: '12px 24px',
            background: '#1a1a2e',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: 14,
          }}
        >
          重試
        </button>
        <button
          onClick={() => window.location.href = '/dashboard'}
          style={{
            padding: '12px 24px',
            background: 'transparent',
            color: '#1a1a2e',
            border: '1px solid #1a1a2e',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: 14,
          }}
        >
          返回首頁
        </button>
      </div>
    </div>
  )
}
