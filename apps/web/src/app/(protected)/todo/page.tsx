'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { toHKDateStr } from '@/lib/hk-date'
import { useTodoCount } from '@/lib/use-todo-count'

/* ── Types ── */

interface LeaveRequestItem {
  id: string
  employeeId: string
  leaveTypeId: string
  leaveType: { id: string; name: string; isPaid: boolean; color: string | null }
  startDate: string
  endDate: string
  days: number
  reason: string | null
  status: string
  employee?: {
    user: { id: string; name: string }
  }
}

interface EnrollPendingItem {
  id: string
  employeeId: string
  employeeName: string
  enrolledAt: string
  enrolledBy: string
  refFrameId: string | null
}

interface FaceReviewItem {
  id: string
  punchTime: string
  employeeName: string
  clinicName: string
  faceStatus: string
  faceScore: number | null
  faceLiveness: number | null
  faceFramePath: string | null
  faceReason: string | null
}

interface EmployeeItem {
  id: string
  user?: { name: string }
  name?: string
}

/* ── Helpers ── */

function formatDateRange(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  if (toHKDateStr(s).slice(0, 10) === toHKDateStr(e).slice(0, 10)) {
    return toHKDateStr(s).slice(0, 10)
  }
  return `${toHKDateStr(s).slice(5, 10)} – ${toHKDateStr(e).slice(5, 10)}`
}

/* ── Page ── */

export default function TodoPage() {
  const router = useRouter()
  const counts = useTodoCount()

  const [leaves, setLeaves] = useState<LeaveRequestItem[]>([])
  const [enrolls, setEnrolls] = useState<EnrollPendingItem[]>([])
  const [reviews, setReviews] = useState<FaceReviewItem[]>([])
  const [employees, setEmployees] = useState<EmployeeItem[]>([])
  const [loading, setLoading] = useState(true)

  // Enroll code shortcut
  const [codeEmployeeId, setCodeEmployeeId] = useState('')
  const [codeLoading, setCodeLoading] = useState(false)
  const [generatedCode, setGeneratedCode] = useState<string | null>(null)

  /* ── Data Loading ── */

  const loadData = useCallback(async () => {
    try {
      const [leavesRes, enrollsRes, reviewsRes, empsRes] = await Promise.all([
        fetch('/api/leave-requests?status=PENDING', { credentials: 'include', cache: 'no-store' }).then(r => r.json()).catch(() => ({})),
        fetch('/api/face/enroll-pending', { credentials: 'include', cache: 'no-store' }).then(r => r.json()).catch(() => []),
        fetch('/api/face/review', { credentials: 'include', cache: 'no-store' }).then(r => r.json()).catch(() => []),
        fetch('/api/employees', { credentials: 'include', cache: 'no-store' }).then(r => r.json()).catch(() => []),
      ])

      setLeaves(leavesRes.leaveRequests || leavesRes.items || [])
      setEnrolls(Array.isArray(enrollsRes) ? enrollsRes : [])
      setReviews(Array.isArray(reviewsRes) ? reviewsRes : [])
      const empArr = Array.isArray(empsRes) ? empsRes : (empsRes.employees || [])
      setEmployees(empArr)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  /* ── Actions: Leave ── */

  const handleLeaveAction = async (id: string, action: 'APPROVE' | 'REJECT') => {
    try {
      const res = await fetch(`/api/leave-requests/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action }),
      })
      if (res.ok) {
        setLeaves(prev => prev.filter(l => l.id !== id))
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error || '操作失敗')
      }
    } catch {
      alert('網絡錯誤')
    }
  }

  /* ── Actions: Enroll ── */

  const handleEnrollAction = async (id: string, action: 'approve' | 'reject') => {
    try {
      const res = await fetch(`/api/face/enroll-approve/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action }),
      })
      if (res.ok) {
        setEnrolls(prev => prev.filter(e => e.id !== id))
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error || '操作失敗')
      }
    } catch {
      alert('網絡錯誤')
    }
  }

  /* ── Actions: Face Review ── */

  const handleReviewAction = async (id: string, action: 'confirm' | 'flag') => {
    try {
      const res = await fetch(`/api/face/review/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action }),
      })
      if (res.ok) {
        setReviews(prev => prev.filter(r => r.id !== id))
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error || '操作失敗')
      }
    } catch {
      alert('網絡錯誤')
    }
  }

  /* ── Actions: Enroll Code ── */

  const handleGenerateCode = async () => {
    if (!codeEmployeeId) return
    setCodeLoading(true)
    try {
      const res = await fetch('/api/face/enroll-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ employeeId: codeEmployeeId }),
      })
      if (res.ok) {
        const data = await res.json()
        setGeneratedCode(data.code)
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error || '產生失敗')
      }
    } catch {
      alert('網絡錯誤')
    } finally {
      setCodeLoading(false)
    }
  }

  /* ── Loading ── */

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12 text-muted-foreground">
        載入中...
      </div>
    )
  }

  const hasItems = leaves.length > 0 || enrolls.length > 0 || reviews.length > 0

  /* ── Render ── */

  return (
    <div className="p-4 space-y-6 max-w-2xl mx-auto">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">待辦</h1>
          <p className="text-sm text-muted-foreground">
            共 {counts.total} 項待處理
            {counts.total > 0 && (
              <span className="ml-1">
                （假期 {counts.leaveN} · 登記 {counts.enrollN} · 覆核 {counts.reviewN}）
              </span>
            )}
          </p>
        </div>
      </div>

      {/* ── Empty State ── */}
      {!hasItems && (
        <div className="text-center py-16 text-muted-foreground text-lg">
          🎉 全部處理完畢
        </div>
      )}

      {/* ── A: Leave Requests ── */}
      {leaves.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            假期審批 ({leaves.length})
          </h2>
          <div className="space-y-3">
            {leaves.map(l => {
              const empName = l.employee?.user?.name || '未知員工'
              const leaveTypeName = l.leaveType?.name || '未知假別'
              const leaveColor = l.leaveType?.color || '#4CAF50'
              return (
                <Card key={l.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="font-semibold">{empName}</div>
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className="text-xs px-2 py-0.5 rounded-full text-white"
                            style={{ backgroundColor: leaveColor || '#666' }}
                          >
                            {leaveTypeName}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {formatDateRange(l.startDate, l.endDate)}
                          </span>
                          <span className="text-xs text-muted-foreground">({l.days} 天)</span>
                        </div>
                        {l.reason && (
                          <div className="text-xs text-muted-foreground mt-1 truncate">
                            原因: {l.reason}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2 ml-4">
                        <button
                          className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 min-h-[44px] min-w-[44px] flex items-center justify-center"
                          onClick={() => handleLeaveAction(l.id, 'APPROVE')}
                        >
                          核准
                        </button>
                        <button
                          className="px-4 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 min-h-[44px] min-w-[44px] flex items-center justify-center"
                          onClick={() => handleLeaveAction(l.id, 'REJECT')}
                        >
                          拒絕
                        </button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>
      )}

      {/* ── B: Enroll Pending ── */}
      {enrolls.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            臉部登記待核准 ({enrolls.length})
          </h2>
          <div className="space-y-3">
            {enrolls.map(e => (
              <Card key={e.id}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <img
                      src={`/api/face/enroll-ref/${e.id}`}
                      alt="參考照"
                      className="w-[72px] h-[72px] rounded-lg object-cover flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold">{e.employeeName}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        登記: {new Date(e.enrolledAt).toLocaleString('zh-HK')}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 min-h-[44px] min-w-[44px] flex items-center justify-center"
                        onClick={() => handleEnrollAction(e.id, 'approve')}
                      >
                        核准
                      </button>
                      <button
                        className="px-4 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 min-h-[44px] min-w-[44px] flex items-center justify-center"
                        onClick={() => handleEnrollAction(e.id, 'reject')}
                      >
                        拒絕
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ── C: Face Review ── */}
      {reviews.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            臉部驗證覆核 ({reviews.length})
          </h2>
          <div className="space-y-3">
            {reviews.map(r => (
              <Card
                key={r.id}
                className={r.faceStatus === 'NO_FACE' ? 'border-orange-300' : 'border-red-300'}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    {r.faceFramePath ? (
                      <img
                        src={`/api/face/review/${r.id}`}
                        alt="現場幀"
                        className="w-[72px] h-[72px] rounded-lg object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-[72px] h-[72px] rounded-lg bg-gray-100 flex items-center justify-center text-2xl flex-shrink-0">
                        📷
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{r.employeeName}</span>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${
                            r.faceStatus === 'NO_FACE'
                              ? 'bg-orange-100 text-orange-700'
                              : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {r.faceStatus === 'NO_FACE' ? '未拍攝' : '未通過'}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {r.clinicName} · {new Date(r.punchTime).toLocaleString('zh-HK')}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {r.faceScore != null && `分數: ${r.faceScore.toFixed(4)}`}
                        {r.faceLiveness != null && ` | 活體: ${r.faceLiveness.toFixed(4)}`}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 min-h-[44px] min-w-[44px] flex items-center justify-center"
                        onClick={() => handleReviewAction(r.id, 'confirm')}
                      >
                        確認本人
                      </button>
                      <button
                        className="px-4 py-2 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 min-h-[44px] min-w-[44px] flex items-center justify-center"
                        onClick={() => handleReviewAction(r.id, 'flag')}
                      >
                        有疑點
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ── Enroll Code Shortcut ── */}
      <section className="border rounded-xl p-4 bg-muted/30">
        <h2 className="text-sm font-semibold mb-3">為員工發臉部登記碼</h2>
        <div className="flex gap-2">
          <select
            value={codeEmployeeId}
            onChange={e => setCodeEmployeeId(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg text-sm min-h-[44px] bg-background"
          >
            <option value="">選擇員工...</option>
            {employees.map(emp => {
              const name = emp.user?.name || emp.name || '未知'
              return (
                <option key={emp.id} value={emp.id}>
                  {name}
                </option>
              )
            })}
          </select>
          <button
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 min-h-[44px] disabled:opacity-50"
            onClick={handleGenerateCode}
            disabled={!codeEmployeeId || codeLoading}
          >
            {codeLoading ? '產生中...' : '產生'}
          </button>
        </div>
      </section>

      {/* ── Generated Code Modal ── */}
      {generatedCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center space-y-4">
            <h3 className="text-lg font-semibold">臉部登記碼</h3>
            <div className="text-6xl font-mono text-center py-6 tracking-widest select-all">
              {generatedCode}
            </div>
            <p className="text-sm text-muted-foreground">
              10 分鐘內有效，請讓員工輸入此碼完成登記
            </p>
            <button
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 min-h-[44px]"
              onClick={() => setGeneratedCode(null)}
            >
              關閉
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
