'use client'

import { useEffect, useState } from 'react'

interface TodoCounts {
  total: number
  leaveN: number
  enrollN: number
  reviewN: number
  failN: number
  noFaceN: number
}

export function useTodoCount(): TodoCounts {
  const [counts, setCounts] = useState<TodoCounts>({
    total: 0,
    leaveN: 0,
    enrollN: 0,
    reviewN: 0,
    failN: 0,
    noFaceN: 0,
  })

  useEffect(() => {
    const load = () =>
      Promise.all([
        fetch('/api/leave-requests?status=PENDING', {
          credentials: 'include',
          cache: 'no-store',
        })
          .then((r) => r.json())
          .catch(() => ({})),
        fetch('/api/face/enroll-pending', {
          credentials: 'include',
          cache: 'no-store',
        })
          .then((r) => r.json())
          .catch(() => []),
        fetch('/api/face/review', {
          credentials: 'include',
          cache: 'no-store',
        })
          .then((r) => r.json())
          .catch(() => []),
      ]).then(([lv, en, rv]) => {
        const leaveN = lv.leaveRequests?.length || lv.length || 0
        const enrollN = Array.isArray(en) ? en.length : en.items?.length || 0
        const reviewArr = Array.isArray(rv) ? rv : rv.items || []
        const reviewN = reviewArr.length
        const failN = reviewArr.filter(
          (item: any) => item.faceStatus === 'FAIL'
        ).length
        const noFaceN = reviewArr.filter(
          (item: any) => item.faceStatus === 'NO_FACE'
        ).length
        setCounts({
          total: leaveN + enrollN + reviewN,
          leaveN,
          enrollN,
          reviewN,
          failN,
          noFaceN,
        })
      })

    load()
    const timer = setInterval(load, 60000)
    return () => clearInterval(timer)
  }, [])

  return counts
}
