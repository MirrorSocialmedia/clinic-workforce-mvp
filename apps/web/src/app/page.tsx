'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    // Check if user is logged in
    fetch('/api/me', { credentials: 'include' })
      .then(res => {
        if (res.ok) {
          router.replace('/dashboard')
        } else {
          router.replace('/login')
        }
      })
      .catch(() => router.replace('/login'))
  }, [router])

  return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>載入中...</div>
}
