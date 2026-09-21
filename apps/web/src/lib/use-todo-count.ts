'use client'

import { useEffect, useState } from 'react'

interface TodoCounts {
  total: number
  leaveN: number
  correctionN: number
  enrollN: number
  reviewN: number
  failN: number
  noFaceN: number
  faceReviewAllowed: boolean
}

export function useTodoCount(): TodoCounts {
  const [counts, setCounts] = useState<TodoCounts>({
    total: 0,
    leaveN: 0,
    correctionN: 0,
    enrollN: 0,
    reviewN: 0,
    failN: 0,
    noFaceN: 0,
    faceReviewAllowed: true,
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
        fetch('/api/punch-corrections?status=PENDING', {
          credentials: 'include',
          cache: 'no-store',
        })
          .then((r) => r.json())
          .catch(() => []),
        fetch('/api/face/enroll-pending', {
          credentials: 'include',
          cache: 'no-store',
        })
          .then((r) => {
            if (r.status === 403) return []
            return r.json()
          })
          .catch((e) => { console.warn('[todo] /api/face/enroll-pending failed', e); return [] }),
        fetch('/api/face/review', {
          credentials: 'include',
          cache: 'no-store',
        })
          .then((r) => {
            // ★ cwm-acct-20260917 A10：403 = 冇權睇人臉覆核 → null（儀表板唔渲染假卡，唔係假 0）
            if (r.status === 403) return null
            return r.json()
          })
          .catch((e) => { console.warn('[todo] /api/face/review failed', e); return [] }),
      ]).then(([lv, corr, en, rv]) => {
        const leaveN = lv.leaveRequests?.length || lv.length || 0
        const correctionArr = Array.isArray(corr) ? corr : corr.corrections || corr.punchCorrections || corr.items || []
        const correctionN = correctionArr.length
        const enrollN = Array.isArray(en) ? en.length : en.items?.length || 0
        // ★ cwm-acct-20260917 A10：rv === null = 403（無權限），唔好計 0 當「無異常」
        const faceReviewAllowed = rv !== null
        const reviewArr = rv === null ? [] : (Array.isArray(rv) ? rv : rv.items || [])
        const reviewN = reviewArr.length
        const failN = reviewArr.filter(
          (item: any) => item.faceStatus === 'FAIL'
        ).length
        const noFaceN = reviewArr.filter(
          (item: any) => item.faceStatus === 'NO_FACE'
        ).length
        setCounts({
          total: leaveN + correctionN + enrollN + reviewN,
          leaveN,
          correctionN,
          enrollN,
          reviewN,
          failN,
          noFaceN,
          faceReviewAllowed,
        })
      })

    load()
    const timer = setInterval(load, 60000)
    return () => clearInterval(timer)
  }, [])

  return counts
}
