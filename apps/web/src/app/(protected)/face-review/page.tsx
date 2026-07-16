'use client'
import { useEffect, useState } from 'react'

interface Item {
  id: string
  punchTime: string
  employeeName: string
  clinicName: string
  faceScore: number | null
  faceLiveness: number | null
}

export default function FaceReviewPage() {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/face/review', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setItems(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const handleAction = async (id: string, action: 'confirm' | 'flag') => {
    await fetch(`/api/face/review/${id}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    setItems(items.filter(i => i.id !== id))
  }

  if (loading) return <div className="p-4">載入中...</div>

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <h1 className="text-xl font-bold mb-4">臉部驗證覆核</h1>
      {items.length === 0 && <p className="text-gray-500">沒有待覆核的紀錄</p>}
      <div className="space-y-3">
        {items.map(item => (
          <div key={item.id} className="border rounded-lg p-3 flex items-center gap-4">
            <img src={`/api/face/review/${item.id}`} alt="frame" className="w-16 h-16 object-cover rounded" />
            <div className="flex-1">
              <div className="font-bold">{item.employeeName}</div>
              <div className="text-sm text-gray-500">{item.clinicName} · {new Date(item.punchTime).toLocaleString('zh-HK')}</div>
              <div className="text-sm">
                分數: {item.faceScore != null ? item.faceScore.toFixed(4) : 'N/A'}
                {item.faceLiveness != null && ` | 活體: ${item.faceLiveness.toFixed(4)}`}
              </div>
            </div>
            <div className="flex gap-2">
              <button className="px-3 py-1 bg-green-600 text-white text-sm rounded"
                onClick={() => handleAction(item.id, 'confirm')}>確認本人</button>
              <button className="px-3 py-1 bg-red-600 text-white text-sm rounded"
                onClick={() => handleAction(item.id, 'flag')}>有疑點</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
