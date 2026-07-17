'use client'
import { useEffect, useState } from 'react'
import { User } from 'lucide-react'

interface FailItem {
  id: string
  punchTime: string
  employeeName: string
  clinicName: string
  faceScore: number | null
  faceLiveness: number | null
}

interface PendingItem {
  id: string
  employeeId: string
  employeeName: string
  enrolledAt: string
  enrolledBy: string
  refFrameId: string | null
}

export default function FaceReviewPage() {
  const [tab, setTab] = useState<'pending' | 'fails'>('pending')
  const [failItems, setFailItems] = useState<FailItem[]>([])
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadFailItems()
    loadPending()
  }, [])

  const loadFailItems = () => {
    fetch('/api/face/review', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setFailItems(d); setLoading(false) })
      .catch(() => setLoading(false))
  }

  const loadPending = () => {
    fetch('/api/face/enroll-pending', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setPendingItems(Array.isArray(d) ? d : []))
      .catch(() => {})
  }

  const handleFailAction = async (id: string, action: 'confirm' | 'flag') => {
    await fetch(`/api/face/review/${id}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    setFailItems(failItems.filter(i => i.id !== id))
  }

  const handlePendingAction = async (id: string, action: 'approve' | 'reject') => {
    const res = await fetch(`/api/face/enroll-approve/${id}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (res.ok) {
      setPendingItems(pendingItems.filter(x => x.id !== id))
    } else {
      const data = await res.json().catch(() => ({}))
      alert(data.error || '操作失敗')
    }
  }

  if (loading) return <div className="p-4">載入中...</div>

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <h1 className="text-xl font-bold mb-4">臉部覆核</h1>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'pending' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          onClick={() => setTab('pending')}>
          登記待核准 {pendingItems.length > 0 && `(${pendingItems.length})`}
        </button>
        <button
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'fails' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          onClick={() => setTab('fails')}>
          驗證失敗覆核 {failItems.length > 0 && `(${failItems.length})`}
        </button>
      </div>

      {/* Pending tab */}
      {tab === 'pending' && (
        <div>
          {pendingItems.length === 0 && <div className="text-sm text-gray-500">暫無待核准登記</div>}
          <div className="space-y-3">
            {pendingItems.map(p => (
              <div key={p.id} className="border rounded-lg p-3 flex items-center gap-3">
                <img src={`/api/face/enroll-ref/${p.id}`} alt=""
                  style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8 }} />
                <div className="flex-1">
                  <div className="font-bold">{p.employeeName}</div>
                  <div className="text-xs text-gray-500">
                    登記時間：{new Date(p.enrolledAt).toLocaleString('zh-HK')}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700"
                    onClick={() => handlePendingAction(p.id, 'approve')}>核准</button>
                  <button className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
                    onClick={() => handlePendingAction(p.id, 'reject')}>拒絕</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fails tab */}
      {tab === 'fails' && (
        <div>
          {failItems.length === 0 && <p className="text-gray-500">沒有待覆核的紀錄</p>}
          <div className="space-y-3">
            {failItems.map(item => (
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
                    onClick={() => handleFailAction(item.id, 'confirm')}>確認本人</button>
                  <button className="px-3 py-1 bg-red-600 text-white text-sm rounded"
                    onClick={() => handleFailAction(item.id, 'flag')}>有疑點</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
