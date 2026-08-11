'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { apiFetch } from '@/lib/api-client'
import { todayHK, addDays, fmtTime, hkDayOfWeek } from '@/lib/hk-date'
import { hasPermission } from '@/lib/permissions'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

export default function ProviderSchedulePage() {
  const [weekStart, setWeekStart] = useState(() => {
    const t = todayHK()
    return addDays(t, -hkDayOfWeek(t))
  })
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<any[]>([])
  const [selectedClinicId, setSelectedClinicId] = useState<string | null>(null)
  const [shifts, setShifts] = useState<any[]>([])
  const [employees, setEmployees] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState<string>('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])

  const canSchedule = userRole
    ? hasPermission(userRole, 'scheduling' as any, grant, deny)
    : false

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [modalCell, setModalCell] = useState<{ date: string; providerId: string } | null>(null)
  const [modalEntries, setModalEntries] = useState<Array<{
    providerId: string; clinicId: string; start: string; end: string; note: string
  }>>([])
  const [modalRepeatWeeks, setModalRepeatWeeks] = useState(1)
  const [modalConflict, setModalConflict] = useState<'skip' | 'overwrite'>('skip')
  const [saving, setSaving] = useState(false)

  // Prevent double-click race (250ms window)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDoubleClickRef = useRef(false)

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const weekEnd = weekDays[6]

  // Load providers, clinics, and user role
  useEffect(() => {
    Promise.all([
      apiFetch<any>('/api/providers').catch(() => ({ providers: [] })),
      apiFetch<any>('/api/clinics').catch(() => ({ clinics: [] })),
      apiFetch<any>('/api/me').catch(() => ({ user: { role: '', grant: [], deny: [] } })),
    ]).then(([provRes, clinicRes, meRes]) => {
      const provs = (provRes.providers || []).filter((p: any) => p.isActive)
      setProviders(provs)
      const cls = clinicRes.clinics || []
      setClinics(cls)
      if (cls.length && !selectedClinicId) setSelectedClinicId(cls[0].id)
      setUserRole(meRes.user?.role ?? '')
      setGrant(meRes.user?.grant ?? [])
      setDeny(meRes.user?.deny ?? [])
    }).finally(() => setLoading(false))
  }, [])

  // Load shifts + employees when date range changes
  useEffect(() => {
    loadShifts()
    if (selectedClinicId) loadEmployees()
  }, [weekStart, weekEnd, selectedClinicId])

  async function loadShifts() {
    try {
      const params = new URLSearchParams({
        startDate: weekStart, endDate: weekEnd,
        ...(selectedClinicId ? { clinicId: selectedClinicId } : {}),
      })
      const res = await apiFetch<any>(`/api/provider-shifts?${params}`)
      setShifts(res.shifts || [])
    } catch (e) { console.error('[provider-schedule] load shifts failed', e) }
  }

  async function loadEmployees() {
    try {
      const res = await apiFetch<any>(`/api/employees?active=1${selectedClinicId ? `&clinicId=${selectedClinicId}` : ''}`)
      setEmployees(res.employees || [])
    } catch (e) { console.error('[provider-schedule] load employees failed', e) }
  }

  // Build shift lookup: key = "date|providerId"
  const shiftMap = useCallback(() => {
    const m = new Map<string, any>()
    for (const s of shifts) {
      const key = `${s.date}|${s.providerId}`
      m.set(key, s)
    }
    return m
  }, [shifts])

  // Cell handlers
  function handleCellClick(e: React.MouseEvent, date: string, providerId: string) {
    if (isDoubleClickRef.current) { isDoubleClickRef.current = false; return }
    e.preventDefault()
    // Single click: quick set for today
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      setModalCell({ date, providerId })
      const existing = shifts.find(s => s.date === date && s.providerId === providerId)
      setModalEntries([{
        providerId,
        clinicId: selectedClinicId || '',
        start: existing?.startTime ? new Date(existing.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '09:00',
        end: existing?.endTime ? new Date(existing.endTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '17:00',
        note: existing?.note || '',
      }])
      setModalRepeatWeeks(1)
      setModalOpen(true)
    }, 250)
  }

  function handleCellDoubleClick(e: React.MouseEvent, date: string, providerId: string) {
    isDoubleClickRef.current = true
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    e.preventDefault()
    // Double click: open modal for batch
    setModalCell({ date, providerId })
    setModalEntries([{
      providerId,
      clinicId: selectedClinicId || '',
      start: '09:00',
      end: '17:00',
      note: '',
    }])
    setModalRepeatWeeks(4)
    setModalOpen(true)
  }

  async function handleSaveModal() {
    setSaving(true)
    try {
      const entries = modalEntries
        .filter(en => en.providerId && en.clinicId && selectedClinicId)
        .map(en => ({
          ...en,
          date: modalCell!.date,
          clinicId: en.clinicId,
        }))
      if (!entries.length) { alert('缺少必要資訊'); setSaving(false); return }
      const res = await apiFetch<any>('/api/provider-shifts/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, repeatWeeks: modalRepeatWeeks, onConflict: modalConflict }),
      })
      alert(`完成：新增 ${res.created} / 更新 ${res.updated} / 略過 ${res.skipped}`)
      setModalOpen(false)
      await loadShifts()
    } catch (e: any) {
      alert(e?.message || '儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteShift(shiftId: string) {
    if (!confirm('確定刪除呢個當值？')) return
    try {
      await apiFetch<any>(`/api/provider-shifts/${shiftId}`, { method: 'DELETE' })
      await loadShifts()
    } catch (e: any) { alert(e?.message || '刪除失敗') }
  }

  function handleCellContextMenu(e: React.MouseEvent, shift: any) {
    e.preventDefault()
    if (confirm('刪除呢個當值？')) handleDeleteShift(shift.id)
  }

  // Prev/Next week
  function prevWeek() { setWeekStart(addDays(weekStart, -7)) }
  function nextWeek() { setWeekStart(addDays(weekStart, 7)) }
  function goToday() { const t = todayHK(); setWeekStart(addDays(t, -hkDayOfWeek(t))) }

  if (loading) return <div className="p-8 text-center text-muted-foreground">載入中...</div>

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">醫生當值表</h1>
        <div className="flex items-center gap-2">
          <select value={selectedClinicId || ''} onChange={e => setSelectedClinicId(e.target.value)} className="border rounded px-2 py-1 text-sm">
            {clinics.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={prevWeek} className="p-1 hover:bg-muted rounded"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={goToday} className="text-xs px-2 py-1 hover:bg-muted rounded">今日</button>
          <button onClick={nextWeek} className="p-1 hover:bg-muted rounded"><ChevronRight className="w-4 h-4" /></button>
          <span className="text-sm font-medium">{weekDays[0]} ~ {weekDays[6]}</span>
        </div>
      </div>

      {/* Schedule Grid */}
      <Card className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-muted/50">
              <th className="sticky left-0 z-10 bg-muted p-2 text-left min-w-[120px]" style={{ position: 'sticky', left: 0 }}>醫生</th>
              {weekDays.map(d => (
                <th key={d} className="p-2 text-center min-w-[100px]">
                  <div>星期{DAY_LABELS[hkDayOfWeek(d)]}</div>
                  <div className="text-muted-foreground">{d}</div>
                  {d === todayHK() && <Badge variant="secondary" className="mt-1">今日</Badge>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Provider rows */}
            {providers.map(p => (
              <tr key={p.id} className="border-t">
                <td className="sticky left-0 z-10 bg-background p-2 font-medium" style={{ position: 'sticky', left: 0, borderRight: '2px solid #e5e7eb' }}>
                  <span style={{ color: p.color || '#888' }}>●</span> {p.name}
                </td>
                {weekDays.map(d => {
                  const shift = shifts.find(s => s.date === d && s.providerId === p.id)
                  return (
                    <td key={d} className="p-1 text-center border-l"
                      onClick={(e) => handleCellClick(e, d, p.id)}
                      onDoubleClick={(e) => handleCellDoubleClick(e, d, p.id)}
                      onContextMenu={(e) => shift && handleCellContextMenu(e, shift)}
                      style={{ cursor: 'pointer', minHeight: 48 }}
                    >
                      {shift ? (
                        <div className={`p-1 rounded text-xs ${canSchedule ? 'hover:ring-2 ring-offset-1 ring-primary/50' : ''}`}
                          style={{
                            background: (p.color || '#888') + '22',
                            borderLeft: `3px solid ${p.color || '#888'}`,
                          }}
                        >
                          <div>{fmtTime(shift.startTime)} - {fmtTime(shift.endTime)}</div>
                          {shift.note && <div className="text-muted-foreground mt-0.5">{shift.note}</div>}
                          {canSchedule && (
                            <button className="absolute top-1 right-1 text-muted-foreground hover:text-foreground"
                              onClick={(e) => { e.stopPropagation(); handleDeleteShift(shift.id) }}
                              style={{ position: 'relative' }}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="h-12 flex items-center justify-center text-muted-foreground/30 text-[10px]">+</div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}

            {/* Employee summary row (read-only) */}
            <tr className="border-t-2">
              <td className="sticky left-0 z-10 bg-muted/30 p-2 font-medium text-muted-foreground" style={{ position: 'sticky', left: 0 }}>
                員工當值
              </td>
              {weekDays.map(d => (
                <td key={d} className="p-1 text-center bg-muted/10">
                  {(() => {
                    const dayEmps = employees.filter(emp => {
                      // Simplified view — just show count
                      // TODO: cross-reference with employee shifts
                      return true
                    })
                    return dayEmps.length > 0 ? (
                      <div className="text-muted-foreground text-[10px]">{dayEmps.length} 人</div>
                    ) : <div className="text-muted-foreground/30 text-[10px]">—</div>
                  })()}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </Card>

      {/* Batch Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setModalOpen(false)}>
          <Card className="w-full max-w-md p-4 m-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold">安排醫生當值</h3>
              <button onClick={() => setModalOpen(false)}><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1 block">日期</label>
                <input type="date" value={modalCell?.date || ''} className="w-full border rounded px-2 py-1 text-sm" readOnly />
              </div>
              {modalEntries.map((en, i) => (
                <div key={i} className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground">醫生</label>
                    <select value={en.providerId} onChange={e => {
                      const next = [...modalEntries]; next[i].providerId = e.target.value; setModalEntries(next)
                    }} className="w-full border rounded px-2 py-1 text-sm">
                      {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">診所</label>
                    <select value={en.clinicId} onChange={e => {
                      const next = [...modalEntries]; next[i].clinicId = e.target.value; setModalEntries(next)
                    }} className="w-full border rounded px-2 py-1 text-sm">
                      {clinics.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">開始</label>
                    <input type="time" value={en.start} onChange={e => {
                      const next = [...modalEntries]; next[i].start = e.target.value; setModalEntries(next)
                    }} className="w-full border rounded px-2 py-1 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">結束</label>
                    <input type="time" value={en.end} onChange={e => {
                      const next = [...modalEntries]; next[i].end = e.target.value; setModalEntries(next)
                    }} className="w-full border rounded px-2 py-1 text-sm" />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">備註</label>
                    <input value={en.note} onChange={e => {
                      const next = [...modalEntries]; next[i].note = e.target.value; setModalEntries(next)
                    }} className="w-full border rounded px-2 py-1 text-sm" placeholder="可選" />
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">重複（週）</label>
                  <select value={modalRepeatWeeks} onChange={e => setModalRepeatWeeks(Number(e.target.value))} className="w-full border rounded px-2 py-1 text-sm">
                    {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 週</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">衝突處理</label>
                  <select value={modalConflict} onChange={e => setModalConflict(e.target.value as any)} className="w-full border rounded px-2 py-1 text-sm">
                    <option value="skip">略過</option>
                    <option value="overwrite">覆蓋</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setModalOpen(false)} className="px-3 py-1.5 text-sm border rounded hover:bg-muted">取消</button>
              <button onClick={handleSaveModal} disabled={saving} className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50">
                {saving ? '儲存中...' : '儲存'}
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
