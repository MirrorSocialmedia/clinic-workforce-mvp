'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { BackButton } from '@/components/BackButton'

interface Clinic {
  id: string
  name: string
}

export default function NewPayrollPage() {
  const router = useRouter()
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [selectedClinic, setSelectedClinic] = useState<string>('')
  const [periodMonth, setPeriodMonth] = useState(() => {
    const now = new Date()
    // Default to previous month
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`
  })
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ runId: string; itemCount: number; totalPayable: number } | null>(null)
  const [userRole, setUserRole] = useState<string>('')

  // Preview + employee states
  const [previewing, setPreviewing] = useState(false)
  const [previewResult, setPreviewResult] = useState<{
    items: Array<{
      employeeId: string; employeeName: string; payType: string;
      workedHours: number; otHours: number; leaveDays: number; absentDays: number;
      basePay: number; otPay: number; splitPay: number | null; deduction: number;
      totalPayable: number; error?: string;
    }>;
    itemCount: number; totalPayable: number;
  } | null>(null)
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([])
  const [selectedEmployee, setSelectedEmployee] = useState<string>('')

  // Pre-check modal state
  const [showPrecheckModal, setShowPrecheckModal] = useState(false)
  const [precheckWarnings, setPrecheckWarnings] = useState<Array<{ employeeId: string; employeeName: string; error: string }>>([])

  const fetchClinics = useCallback(async () => {
    try {
      const res = await fetch('/api/clinics')
      if (res.ok) {
        const data = await res.json()
        setClinics(data.clinics || data || [])
      }
    } catch (err) {
      console.error('Failed to fetch clinics:', err)
    }
  }, [])

  useEffect(() => {
    fetchClinics()
    fetch('/api/me').then(async r => {
      if (!r.ok) return { user: { role: '' } }
      const d = await r.json()
      setUserRole(d.user?.role || '')
    })
    fetch('/api/employees?pageSize=200').then(async r => {
      if (!r.ok) return
      const d = await r.json()
      setEmployees((d.employees || []).map((e: any) => ({
        id: e.id,
        name: e.user?.name || e.id,
      })))
    })
  }, [fetchClinics])

  // Redirect if not OWNER
  useEffect(() => {
    if (userRole && userRole !== 'OWNER') {
      router.push('/payroll')
    }
  }, [userRole, router])

  const handleGenerate = async () => {
    if (!periodMonth) {
      setError('請選擇計糧月份')
      return
    }

    // Pre-check: run preview first to detect issues
    try {
      const previewRes = await fetch('/api/payroll-runs/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          periodMonth,
          clinicId: selectedClinic || null,
        }),
      })

      if (previewRes.ok) {
        const previewData = await previewRes.json()
        const warnings = (previewData.items || []).filter((item: any) => item.error)
        const skipped = previewData.skipped || []
        const allWarnings = [...warnings, ...skipped.map((s: any) => ({
          employeeId: s.employeeId,
          employeeName: s.name,
          error: s.reason,
        }))]
        if (allWarnings.length > 0) {
          setPrecheckWarnings(allWarnings)
          setShowPrecheckModal(true)
          return
        }
      }
    } catch {
      // Preview failed — proceed anyway (non-blocking)
    }

    // No warnings or preview unavailable: proceed directly
    await doGenerate()
  }

  const doGenerate = async () => {
    setGenerating(true)
    setError(null)

    try {
      const res = await fetch('/api/payroll-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          periodMonth,
          clinicId: selectedClinic || null,
        }),
      })

      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || '生成失敗')
      }

      const data = await res.json()
      if (data.skipped && data.skipped.length > 0) {
        setPrecheckWarnings(data.skipped.map((s: any) => ({
          employeeId: s.employeeId,
          employeeName: s.name,
          error: s.reason,
        })))
        setShowPrecheckModal(true)
      }
      setResult(data)
    } catch (err: any) {
      setError(err.message || '生成失敗')
    } finally {
      setGenerating(false)
    }
  }

  const confirmAndGenerate = async () => {
    setShowPrecheckModal(false)
    await doGenerate()
  }

  const handlePreview = async () => {
    if (!periodMonth) {
      setError('請選擇計糧月份')
      return
    }
    setPreviewing(true)
    setError(null)
    setPreviewResult(null)
    try {
      const res = await fetch('/api/payroll-runs/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          periodMonth,
          clinicId: selectedClinic || null,
          employeeId: selectedEmployee || null,
        }),
      })
      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || '試算失敗')
      }
      const data = await res.json()
      setPreviewResult(data)
    } catch (err: any) {
      setError(err.message || '試算失敗')
    } finally {
      setPreviewing(false)
    }
  }

  if (userRole && userRole !== 'OWNER') return null

  return (
    <div className="p-6" style={{ maxWidth: '800px' }}>
      <BackButton to="/payroll" label="返回計糧" />
      <h1 className="text-2xl font-bold text-foreground tracking-tight" style={{ margin: '0 0 24px' }}>+ 生成計糧</h1>

      <div style={{ maxWidth: 500 }}>
        <div style={{ marginBottom: 20 }}>
          <label className="block mb-1.5 font-semibold text-sm text-foreground">
            計糧月份
          </label>
          <input
            type="month"
            value={periodMonth}
            onChange={e => setPeriodMonth(e.target.value)}
            className="w-full px-3 py-2.5 rounded-md g border text-base focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label className="block mb-1.5 font-semibold text-sm text-foreground">
            診所（留空 = 全部診所）
          </label>
          <select
            value={selectedClinic}
            onChange={e => setSelectedClinic(e.target.value)}
            className="w-full px-3 py-2.5 rounded-md g border text-base focus:outline-none focus:ring-2 focus:ring-brand/30"
          >
            <option value="">全部診所</option>
            {clinics.map(clinic => (
              <option key={clinic.id} value={clinic.id}>
                {clinic.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label className="block mb-1.5 font-semibold text-sm text-foreground">
            員工（留空 = 全部員工）
          </label>
          <select
            value={selectedEmployee}
            onChange={e => setSelectedEmployee(e.target.value)}
            className="w-full px-3 py-2.5 rounded-md g border text-base focus:outline-none focus:ring-2 focus:ring-brand/30"
          >
            <option value="">全部員工</option>
            {employees.map(emp => (
              <option key={emp.id} value={emp.id}>{emp.name}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handlePreview}
            disabled={previewing || !periodMonth}
            className={`flex-1 py-3 rounded-md border-none text-base font-semibold text-white transition-colors ${previewing || !periodMonth ? 'bg-gray-400 cursor-default' : 'bg-emerald-600 hover:bg-emerald-700 cursor-pointer'}`}
          >
            {previewing ? '試算中...' : <span className="flex items-center gap-1"><Search size={16} /> 試算預覽</span>}
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating || !periodMonth}
            className={`flex-1 py-3 rounded-md border-none text-base font-semibold text-white transition-colors ${generating || !periodMonth ? 'bg-gray-400 cursor-default' : 'bg-brand hover:bg-brand-dark cursor-pointer'}`}
          >
            {generating ? '計算中...' : '生成計糧'}
          </button>
        </div>

        {error && (
          <div className="mt-4 p-4 rounded-lg bg-destructive/10 text-destructive text-sm">
            ⚠️ {error}
          </div>
        )}

        {result && (
          <div className="mt-4 p-4 rounded-lg bg-emerald-50 text-emerald-700 text-sm border border-emerald-200">
            <div className="mb-2 font-semibold">✅ 計糧生成成功！</div>
            <div>員工數: {result.itemCount}</div>
            <div>應付總額: HK${result.totalPayable.toLocaleString()}</div>
            <div style={{ marginTop: 12 }}>
              <a
                href={`/payroll/${result.runId}`}
                style={{ color: '#0f5132', fontWeight: 600 }}
              >
                查看詳情 →
              </a>
            </div>
          </div>
        )}

        {/* Preview Results */}
        {previewResult && (
          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">試算結果（未儲存）</CardTitle>
            </CardHeader>
            <CardContent>
            <div className="mb-2 text-sm g text-muted-foreground">
              員工數: {previewResult.itemCount} | 應付總額: HK${previewResult.totalPayable.toLocaleString()}
            </div>
            <div className="overflow-x-auto mt-3">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b-2 border-blue-200">
                    <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">員工</th>
                    <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">薪資類型</th>
                    <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">工時</th>
                    <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">加班</th>
                    <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">底薪</th>
                    <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">加班費</th>
                    <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">扣款</th>
                    <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">總額</th>
                  </tr>
                </thead>
                <tbody>
                  {previewResult.items.map((item: any, i: number) => (
                    <tr key={item.employeeId || i} className="border-b border-blue-100 hover:bg-blue-50/30 transition-colors">
                      {item.error ? (
                        <td colSpan={8} className="px-2 py-1.5 text-destructive">
                          {item.employeeName}: {item.error}
                        </td>
                      ) : (
                        <>
                          <td className="px-2 py-1.5">{item.employeeName}</td>
                          <td className="px-2 py-1.5">{item.payType}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{item.workedHours}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{item.otHours}</td>
                          <td className="px-2 py-1.5 text-right font-mono">HK${(item.basePay || 0).toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right font-mono">HK${(item.otPay || 0).toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right font-mono">-HK${(item.deduction || 0).toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right font-semibold font-mono">
                            HK${(item.totalPayable || 0).toLocaleString()}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Pre-check Warning Modal */}
      {showPrecheckModal && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setShowPrecheckModal(false)}
        >
          <div
            className="g bg-card g border rounded-xl shadow-lg mx-4 p-6 relative"
            style={{ width: '520px', maxWidth: '90vw', maxHeight: '80vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 12, color: '#d97706' }}>
              ⚠️ 計糧前檢查警告
            </h2>
            <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
              以下員工在計糧時發現問題，是否仍然繼續生成？
            </p>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {precheckWarnings.map((w, i) => (
                <div
                  key={w.employeeId || i}
                  style={{
                    padding: '8px 12px', marginBottom: 6,
                    background: '#fef2f2', border: '1px solid #fecaca',
                    borderRadius: 6, fontSize: 13,
                  }}
                >
                  <strong>{w.employeeName}</strong>：{w.error}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                onClick={() => setShowPrecheckModal(false)}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: '1px solid #ddd',
                  background: '#f5f5f5', cursor: 'pointer', fontSize: 13,
                }}
              >
                取消
              </button>
              <button
                onClick={confirmAndGenerate}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  background: '#d97706', color: '#fff',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >
                仍要繼續生成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
