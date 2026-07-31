'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MGMT_PERMS, hasPermission } from '@/lib/permissions'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    fetch('/api/me', { credentials: 'include', cache: 'no-store' })
      .then(async res => {
        if (!res.ok) { router.replace('/login'); return }
        const data = await res.json()
        const u = data.user
        const grant: string[] = u?.grant ?? []
        const deny: string[] = u?.deny ?? []

        if (u?.role === 'KIOSK') { router.replace('/clinic/qr'); return }

        const hasMgmt = MGMT_PERMS.some(p => hasPermission(u.role, p as any, grant, deny))
        if (u?.role === 'EMPLOYEE' && !hasMgmt) { router.replace('/my/dashboard'); return }

        router.replace('/dashboard')
      })
      .catch(() => router.replace('/login'))
  }, [router])

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      載入中…
    </div>
  )
}
