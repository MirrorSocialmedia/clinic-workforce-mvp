'use client'

import { useState, useEffect } from 'react'

export default function PWAPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [showPrompt, setShowPrompt] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e)
      setShowPrompt(true)
    }

    window.addEventListener('beforeinstallprompt', handler)

    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = async () => {
    if (!deferredPrompt) return

    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice

    if (outcome === 'accepted') {
      setShowPrompt(false)
    }

    setDeferredPrompt(null)
  }

  const handleDismiss = () => {
    setShowPrompt(false)
  }

  if (!showPrompt) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 20,
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#1a1a2e',
      color: 'white',
      padding: '16px 24px',
      borderRadius: 12,
      boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      maxWidth: 'calc(100% - 32px)',
    }}>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>📱 加到主畫面</div>
        <div style={{ fontSize: 12, color: '#ccc' }}>安裝為 PWA，隨時使用</div>
      </div>
      <button
        onClick={handleInstall}
        style={{
          padding: '8px 16px',
          background: 'white',
          color: '#1a1a2e',
          border: 'none',
          borderRadius: 6,
          fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          fontSize: 13,
        }}
      >
        安裝
      </button>
      <button
        onClick={handleDismiss}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#999',
          cursor: 'pointer',
          fontSize: 18,
          padding: '0 4px',
        }}
      >
        ✕
      </button>
    </div>
  )
}
