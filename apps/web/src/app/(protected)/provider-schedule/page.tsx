'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { apiFetch } from '@/lib/api-client'
import { todayHK, addDays, fmtTime, hkDayOfWeek, toHKDateStr } from '@/lib/hk-date'
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
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState<string>('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const [scope, setScope] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Staff shifts for employee summary row
  const [staffShifts, setStaffShifts] = useState<any[]>([])
  const [staffError, setStaffError] = useState(false)

  const canSchedule = userRole
    ? hasPermission(userRole, 'provider_schedule' as any, grant, deny)
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

  // ★ visibleClinics: filtered by scope
  const visibleClinics = scope === null ? clinics : clinics.filter((c: any) => scope.includes(c.id))

  // ★ shiftByDay: Map<"date|providerId", shift[]> — supports multi-shift per cell
  const shiftByDay = useMemo(() => {
    const m = new Map<string, any[]>()
    for (const s of shifts) {
      const key = `${toHKDateStr(s.date)}|${s.providerId}`
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(s)
    }
    return m
  }, [shifts])

  // ★ staffByDate: Map<"date", Set<employeeId>>
  const staffByDate = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const s of staffShifts) {
      if (s.clinicId !== selectedClinicId && s.secondaryClinicId !== selectedClinicId) continue
      const d = toHKDateStr(s.date)
      if (!m.has(d)) m.set(d, new Set())
      m.get(d)!.add(s.employeeId)
    }
    return m
  }, [staffShifts, selectedClinicId])

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
      setUserRole(meRes.user?.role ?? '')
      setGrant(meRes.user?.grant ?? [])
      setDeny(meRes.user?.deny ?? [])
    }).finally(() => setLoading(false))
  }, [])

  // Load shifts + staff shifts when date range changes
  useEffect(() => {
    loadShifts()
    loadStaffShifts()
  }, [weekStart, weekEnd, selectedClinicId])

  async function loadShifts() {
    try {
      setLoadError(null)
      const params = new URLSearchParams({
        startDate: weekStart, endDate: weekEnd,
        ...(selectedClinicId ? { clinicId: selectedClinicId } : {}),
      })
      const res = await apiFetch<any>(`/api/provider-shifts?${params}`)
      setShifts(res.shifts || [])
      setScope(res.scope ?? null)
      // ★ Set default clinic from visible scope
      if (visibleClinics.length > 0 && !selectedClinicId) {
        setSelectedClinicId(visibleClinics[0].id)
      }
    } catch (e: any) {
      console.error('[provider-schedule] load shifts failed', e)
      setLoadError(e?.message ?? '載入當值記錄失敗')
    }
  }

  async function loadStaffShifts() {
    try {
      setStaffError(false)
      const res = await apiFetch<any>(
        `/api/shifts?startDate=${weekStart}&endDate=${weekEnd}&pageSize=1000`)
      setStaffShifts(res.shifts || [])
    } catch (e) {
      console.error('[provider-schedule] load staff shifts failed', e)
      setStaffShifts([])
      setStaffError(true)
    }
  }

  // Cell handlers
  function handleCellClick(e: React.MouseEvent, date: string, providerId: string) {
    if (isDoubleClickRef.current) { isDoubleClickRef.current = false; return }
    e.preventDefault()
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      setModalCell({ date, providerId })
      const existing = shifts.find(s => toHKDateStr(s.date) === date && s.providerId === providerId)
      setModalEntries([{
        providerId,
        clinicId: selectedClinicId || '',
        start: existing?.startTime ? fmtTime(existing.startTime) : '09:00',
        end: existing?.endTime ? fmtTime(existing.endTime) : '17:00',
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
          {visibleClinics.length === 1
            ? <span className="text-sm font-medium">{visibleClinics[0].name}</span>
            : <select value={selectedClinicId || ''} onChange={e => setSelectedClinicId(e.target.value)} className="border rounded px-2 py-1 text-sm">
                {visibleClinics.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>}
          <button onClick={prevWeek} className="p-1 hover:bg-muted rounded"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={goToday} className="text-xs px-2 py-1 hover:bg-muted rounded">今日</button>
          <button onClick={nextWeek} className="p-1 hover:bg-muted rounded"><ChevronRight className="w-4 h-4" /></button>
          <span className="text-sm font-medium">{weekDays[0]} ~ {weekDays[6]}</span>
        </div>
      </div>

      {/* Load error */}
      {loadError && (
        <div className="mb-2 px-3 py-2 text-sm rounded bg-destructive/10 text-destructive">
          載入失敗：{loadError}
          <button onClick={() => { setLoadError(null); loadShifts() }} className="ml-2 underline">重試</button>
        </div>
      )}

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
                  const dayShifts = shiftByDay.get(`${d}|${p.id}`)
                  return (
                    <td key={d} className="p-1 text-center border-l"
                      onClick={(e) => handleCellClick(e, d, p.id)}
                      onDoubleClick={(e) => handleCellDoubleClick(e, d, p.id)}
                      onContextMenu={(e) => dayShifts?.[0] && handleCellContextMenu(e, dayShifts[0])}
                      style={{ cursor: 'pointer', minHeight: 48 }}
                    >
                      {dayShifts && dayShifts.length > 0 ? (
                        <div>
                          {dayShifts.map(sh => (
                            <div key={sh.id} className={`p-1 rounded text-xs mb-0.5 ${canSchedule ? 'hover:ring-2 ring-offset-1 ring-primary/50' : ''}`}
                              style={{
                                background: (p.color || '#888') + '22',
                                borderLeft: `3px solid ${p.color || '#888'}`,
                              }}
                            >
                              <div>{fmtTime(sh.startTime)} - {fmtTime(sh.endTime)}</div>
                              {sh.note && <div className="text-muted-foreground mt-0.5">{sh.note}</div>}
                              {canSchedule && (
                                <button className="mt-0.5 text-muted-foreground hover:text-foreground"
                                  onClick={(e) => { e.stopPropagation(); handleDeleteShift(sh.id) }}
                                >
                                  <X className="w-3 h-3 inline" />
                                </button>
                              )}
                            </div>
                          ))}
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
                  {staffError
                    ? <div className="text-muted-foreground text-[10px]">載入失敗</div>
                    : (() => {
                        const n = staffByDate.get(d)?.size ?? 0
                        return n > 0
                          ? <div className="text-muted-foreground text-[10px]">{n} 人</div>
                          : <div className="text-muted-foreground/30 text-[10px]">—</div>
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
                      {visibleClinics.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
              <div className="text-xs text-muted-foreground">
                ▸ 預覽：將寫入 {modalRepeatWeeks} 條（1 日 × {modalRepeatWeeks} 週）
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
