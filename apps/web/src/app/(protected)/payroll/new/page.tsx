'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { BackButton } from '@/components/BackButton'
import { toHKDateStr } from '@/lib/hk-date'

interface Clinic {
  id: string
  name: string
}

export default function NewPayrollPage() {
  const router = useRouter()
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [selectedClinic, setSelectedClinic] = useState<string>('')
  const [periodMonth, setPeriodMonth] = useState(() => {
    const ym = toHKDateStr(new Date()).slice(0, 7)
    const [y, m] = ym.split('-').map(Number)
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
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

  // Store bonus states
  const [storeBonuses, setStoreBonuses] = useState<Record<string, number>>({})
  const [fillAll, setFillAll] = useState('')

  // Split pay states
  const [splitPays, setSplitPays] = useState<Record<string, number>>({})
  const [bulkSplit, setBulkSplit] = useState('')

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

  const runPreview = useCallback(async () => {
    if (!selectedClinic || !periodMonth) return
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
  }, [selectedClinic, periodMonth, selectedEmployee])

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

  // Auto-run preview when clinic + month are both selected
  useEffect(() => {
    if (selectedClinic && periodMonth) runPreview()
  }, [selectedClinic, periodMonth, runPreview])

  const handleGenerate = async () => {
    if (!periodMonth) {
      setError('請選擇計糧月份')
      return
    }
    if (!selectedClinic) {
      setError('請指定店鋪')
      return
    }

    // Pre-check: use existing preview to detect issues
    if (previewResult) {
      const warnings = (previewResult.items || []).filter((item: any) => item.error)
      if (warnings.length > 0) {
        setPrecheckWarnings(warnings.map(w => ({
          employeeId: w.employeeId,
          employeeName: w.employeeName,
          error: w.error || '計算錯誤',
        })))
        setShowPrecheckModal(true)
        return
      }
    }

    await doGenerate()
  }

  const doGenerate = async () => {
    if (!selectedClinic) {
      setError('請指定店鋪')
      return
    }
    setGenerating(true)
    setError(null)

    try {
      const res = await fetch('/api/payroll-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          periodMonth,
          clinicId: selectedClinic,
          storeBonuses: Object.keys(storeBonuses).length > 0 ? storeBonuses : undefined,
          splitPays: Object.keys(splitPays).length > 0 ? splitPays : undefined,
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

  if (userRole && userRole !== 'OWNER') return null

  return (
    <div className="p-6" style={{ maxWidth: '1800px' }}>
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
            店鋪（必選）
          </label>
          <select
            value={selectedClinic}
            onChange={e => setSelectedClinic(e.target.value)}
            className="w-full px-3 py-2.5 rounded-md g border text-base focus:outline-none focus:ring-2 focus:ring-brand/30"
          >
            <option value="">選擇店鋪...</option>
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

        <button
          onClick={handleGenerate}
          disabled={generating || !periodMonth || !selectedClinic}
          className={`w-full py-3 rounded-md border-none text-base font-semibold text-white transition-colors ${generating || !periodMonth || !selectedClinic ? 'bg-gray-400 cursor-default' : 'bg-brand hover:bg-brand-dark cursor-pointer'}`}
        >
          {generating ? '計算中...' : '生成計糧'}
        </button>

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

        {/* Preview Results — auto-shown when clinic + month selected */}
        {previewResult && (
          <Card className="mt-4" style={{ width: '100vw', marginLeft: 'calc(-50vw + 50%)', maxWidth: '100vw', paddingLeft: '24px', paddingRight: '24px', }}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-center flex items-center justify-center gap-2">
                {previewing ? '⏳ 試算中...' : '試算結果'}（未儲存）
              </CardTitle>
            </CardHeader>
            <CardContent>
            <div className="mb-2 text-sm g text-muted-foreground text-center">
              員工數: {previewResult.itemCount} | 應付總額: HK${previewResult.totalPayable.toLocaleString()}
            </div>

            {/* Store bonus fill-all control — only for specific clinic */}
            {selectedClinic && (
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">店舖獎金：</span>
                <input
                  type="number"
                  min={0}
                  value={fillAll}
                  onChange={e => setFillAll(e.target.value)}
                  placeholder="金額"
                  className="w-24 px-2 py-1 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = parseFloat(fillAll)
                    if (!isFinite(v) || v < 0) return
                    setStoreBonuses(Object.fromEntries(
                      previewResult?.items.filter(i => i.payType === 'MONTHLY').map(i => [i.employeeId, v]) || []
                    ))
                  }}
                  className="px-3 py-1 text-xs rounded-md bg-brand text-white hover:bg-brand-dark transition-colors"
                >
                  全部填入同額
                </button>
                <span className="text-xs text-muted-foreground">（重新生成需重新輸入店舖獎金）</span>
              </div>
            )}

            {/* Split pay fill-all control */}
            {selectedClinic && (
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">拆帳：</span>
                <input
                  type="number"
                  min={0}
                  value={bulkSplit}
                  onChange={e => setBulkSplit(e.target.value)}
                  placeholder="金額"
                  className="w-24 px-2 py-1 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = parseFloat(bulkSplit)
                    if (!isFinite(v) || v < 0) return
                    const next: Record<string, number> = {}
                    previewResult?.items.forEach((it: any) => { if (!it.error) next[it.employeeId] = v })
                    setSplitPays(next)
                  }}
                  className="px-3 py-1 text-xs rounded-md bg-brand text-white hover:bg-brand-dark transition-colors"
                >
                  全部填入同額
                </button>
                <span className="text-xs text-muted-foreground">（重新生成需重新輸入拆帳金額）</span>
              </div>
            )}

            <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto mt-3">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b-2 border-blue-200">
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">員工</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">薪資類型</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">工時</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">底薪</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">MPF</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">勤工獎</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">扣款</th>
                    {selectedClinic && (
                      <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">店舖獎金</th>
                    )}
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">拆帳</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase g text-muted-foreground bg-slate-50">總額</th>
                  </tr>
                </thead>
                <tbody>
                  {previewResult.items.map((item: any, i: number) => (
                    <tr key={item.employeeId || i} className="border-b border-blue-100 hover:bg-blue-50/30 transition-colors">
                      {item.error ? (
                        <td colSpan={selectedClinic ? 10 : 9} className="px-2 py-1.5 text-destructive">
                          {item.employeeName}: {item.error}
                        </td>
                      ) : (
                        <>
                          <td className="px-2 py-1.5 text-center">{item.employeeName}</td>
                          <td className="px-2 py-1.5 text-center">{item.payType === 'HOURLY' ? '時薪' : '月薪'}</td>
                          <td className="px-2 py-1.5 text-center font-mono whitespace-nowrap">{item.workedHours}</td>
                          <td className="px-2 py-1.5 text-center font-mono whitespace-nowrap">HK${(item.basePay || 0).toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-center font-mono whitespace-nowrap text-red-600">-HK${((item.detail as any)?.mpf || 0).toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-center font-mono whitespace-nowrap">
                            {(item.detail as any)?.attendanceBonusCancelled ? (
                              <span className="text-muted-foreground">$0（已取消）</span>
                            ) : (
                              <span className="text-green-600">+HK${((item.detail as any)?.attendanceBonus || 0).toLocaleString()}</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono whitespace-nowrap">-HK${(item.deduction || 0).toLocaleString()}</td>
                          {selectedClinic && (
                            <td className="px-2 py-1.5 text-center">
                              {item.payType === 'MONTHLY' ? (
                                <input
                                  type="number"
                                  min={0}
                                  value={storeBonuses[item.employeeId] ?? ''}
                                  onChange={e => setStoreBonuses(s => ({ ...s, [item.employeeId]: parseFloat(e.target.value) || 0 }))}
                                  className="w-20 text-center px-1 py-0.5 rounded g border text-xs focus:outline-none focus:ring-1 focus:ring-brand/30"
                                />
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          )}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="number" min={0}
                              value={splitPays[item.employeeId] ?? ''}
                              onChange={e => setSplitPays(s => ({ ...s, [item.employeeId]: parseFloat(e.target.value) || 0 }))}
                              className="w-20 text-center px-1 py-0.5 rounded border text-xs focus:outline-none focus:ring-1 focus:ring-brand/30"
                              placeholder="金額" />
                          </td>
                          <td className="px-2 py-1.5 text-center font-semibold font-mono whitespace-nowrap">
                            HK${(item.totalPayable || 0).toLocaleString()}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2 mt-3">
              {previewResult.items.map((item: any, i: number) => (
                <div key={item.employeeId || i} className="rounded-xl border shadow-card p-3">
                  {item.error ? (
                    <div className="text-destructive text-sm">{item.employeeName}: {item.error}</div>
                  ) : (
                    <>
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-semibold">{item.employeeName}</span>
                        <span className="text-xs text-muted-foreground">{item.payType === 'HOURLY' ? '時薪' : '月薪'}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-xs mb-2">
                        <div>工時: {item.workedHours}</div>
                        <div>底薪: HK${(item.basePay || 0).toLocaleString()}</div>
                      </div>
                      {selectedClinic && item.payType === 'MONTHLY' && (
                        <div className="flex items-center gap-2 mb-2">
                          <label className="text-xs">店舖獎金:</label>
                          <input
                            type="number"
                            min={0}
                            value={storeBonuses[item.employeeId] ?? ''}
                            onChange={e => setStoreBonuses(s => ({ ...s, [item.employeeId]: parseFloat(e.target.value) || 0 }))}
                            className="w-24 text-right px-2 py-1 rounded border text-sm focus:outline-none focus:ring-1 focus:ring-brand/30"
                          />
                        </div>
                      )}
                      <div className="text-right font-semibold text-sm font-mono border-t pt-2">
                        HK${(item.totalPayable || 0).toLocaleString()}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            </>
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
