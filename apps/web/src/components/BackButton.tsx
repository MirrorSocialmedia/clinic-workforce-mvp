'use client'
import { ArrowLeft } from 'lucide-react'
import { useRouter } from 'next/navigation'

export function BackButton({ label = '返回', to }: { label?: string; to?: string }) {
 const router = useRouter()
 return (
 <button
 onClick={() => (to ? router.push(to) : router.back())}
 className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4 transition-colors"
 style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
 >
 <ArrowLeft size={16} /> {label}
 </button>
 )
}
