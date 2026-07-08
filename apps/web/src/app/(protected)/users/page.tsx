'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function UsersRedirect() {
  const router = useRouter()
  useEffect(() => router.replace('/accounts'), [router])
  return null
}
