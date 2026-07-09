'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
export default function LeaveTypesRedirect() {
 const router = useRouter()
 useEffect(() => router.replace('/leave'), [router])
 return null
}
