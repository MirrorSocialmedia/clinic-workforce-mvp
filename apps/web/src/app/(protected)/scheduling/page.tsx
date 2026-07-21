'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Settings, X, Trash2, Calendar, ClipboardList, BarChart3, RefreshCw, PlusCircle, Palmtree, AlertCircle, CheckCircle, AlertTriangle } from 'lucide-react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin, { Draggable } from '@fullcalendar/interaction'
import zhcn from '@fullcalendar/core/locales/zh-cn'
import { toHKDateStr, fmtTime, leaveCoversDate, hkDateStart, fmtDateTime, todayHK } from '@/lib/hk-date'
import type { ShiftRuleConfig } from '@/lib/shift-rule-config'
import { DEFAULT_SHIFT_RULE_CONFIG } from '@/lib/shift-rule-config'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'

// ============================================================
// Sorting helpers
// ============================================================
const ROLE_ORDER: Record<string, number> = { OWNER: 0, MANAGER: 1, ACCOUNTANT: 2, EMPLOYEE: 3 }
const roleOf = (e: any) => e.user?.role ?? e.role ?? null
const roleRank = (e: any) => {
  const r = roleOf(e)
  return (r != null && r in ROLE_ORDER) ? ROLE_ORDER[r] : 99
}

const byRoleThenName = (a: any, b: any) => {
  const rr = roleRank(a) - roleRank(b)
  if (rr !== 0) return rr
  const na = (a.name || a.user?.name || '').toLowerCase()
  const nb = (b.name || b.user?.name || '').toLowerCase()
  if (na !== nb) return na < nb ? -1 : 1
  return (a.id || '').localeCompare(b.id || '')
}

const byName = (a: any, b: any) => {
  const na = (a.name || a.user?.name || '').toLowerCase()
  const nb = (b.name || b.user?.name || '').toLowerCase()
  if (na !== nb) return na < nb ? -1 : 1
  return (a.id || '').localeCompare(b.id || '')
}

// ============================================================
// Types
// ============================================================
type ViewMode = 'week' | 'month'
type ChangeType = 'SWAP' | 'COVER' | 'REPORT'
type OvScope = { type: 'all' } | { type: 'company'; id: string; name: string } | { type: 'clinic'; id: string; name: string }

interface Employee {
  id: string
  user: { id: string; name: string; phone?: string }
  clinics: { clinic: { id: string; name: string } }[]
  payRules?: { payType: string }[]
  status: string
}

interface Clinic {
  id: string
  name: string
  shortName?: string | null
  company?: { id: string; name: string } | null
}

type LabelPart = 'clinic' | 'shift' | 'name'

interface ShiftTemplate {
  id: string
  name: string
  startHour: number
  startMinute: number
  endHour: number
  endMinute: number
  isNightShift: boolean
  isDefault: boolean
  shortName?: string | null
}

interface Shift {
  id: string
  employeeId: string
  clinicId: string
  date: string
  startTime: string
  endTime: string
  role?: string
  status: string
  templateId?: string
  hasPunch?: boolean
  employee?: { user: { name: string } }
  clinic?: { name: string }
  template?: { name: string; shortName?: string | null }
}

interface ShiftChangeRequest {
  id: string
  shiftId: string
  fromEmployeeId: string
  toEmployeeId?: string
  type: ChangeType
  reason?: string
  status: string
  approverId?: string
  approvedAt?: string
  createdAt: string
  shift?: { date: string; clinic: { name: string } }
  fromEmployee?: { user: { name: string } }
  toEmployee?: { user: { name: string } }
}

interface ValidationIssue {
  type: 'error' | 'warning'
  rule: string
  message: string
}

// ============================================================
// Hook: Drag-out delete with undo (no confirm, instant delete + 5s toast)
// ============================================================
function useDragOutDeleteWithUndo(
  overviewRef: React.RefObject<HTMLDivElement | null>,
  onDeleteWithUndo: (id: string, label: string, restoreFn: () => Promise<void>) => void,
) {
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string; outside: boolean } | null>(null)

  const start = (e: React.PointerEvent, id: string, label: string, restoreFn: () => Promise<void>) => {
    const el = e.currentTarget as HTMLElement
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    const sx = e.clientX, sy = e.clientY
    let dragging = false

    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) dragging = true
      if (!dragging) return
      const r = overviewRef.current?.getBoundingClientRect()
      const outside = !!r && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)
      setGhost({ x: ev.clientX, y: ev.clientY, label, outside })
    }
    const onUp = async (ev: PointerEvent) => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.releasePointerCapture(ev.pointerId)
      setGhost(null)
      if (!dragging) return
      const r = overviewRef.current?.getBoundingClientRect()
      const outside = !!r && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)
      if (!outside) return
      onDeleteWithUndo(id, label, restoreFn)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }
  return { start, ghost }
}

// ============================================================
// Main Component
// ============================================================
export default function SchedulingPage() {
  // State
  const [viewMode, setViewMode] = useState<ViewMode>('week')
  const [currentDate, setCurrentDate] = useState(new Date())
  const [viewRange, setViewRange] = useState<{start: string, end: string} | null>(null)
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [selectedClinicId, setSelectedClinicId] = useState<string | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [shifts, setShifts] = useState<Shift[]>([])
  const [cardShifts, setCardShifts] = useState<Shift[]>([])
  const [cardRefreshTick, setCardRefreshTick] = useState(0)

  // viewRange / clinic 變 → 拉「瀏覽錨點所在月 ∪ 瀏覽週」的 shifts（跨月週不遺漏）
  useEffect(() => {
    if (!viewRange || !selectedClinicId) return
    const anchor = new Date(viewRange.start)
    const mStart = toHKDateStr(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
    const mEnd = toHKDateStr(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))
    // ★ 瀏覽週末端(anchor+6)可能跨出月界 → 拉取範圍取兩者較大
    const wEndD = new Date(anchor); wEndD.setDate(anchor.getDate() + 6)
    const wEndStr = toHKDateStr(wEndD)
    const fetchEnd = wEndStr > mEnd ? wEndStr : mEnd
    fetch(`/api/shifts?startDate=${mStart}&endDate=${fetchEnd}&pageSize=1000`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.shifts)) setCardShifts(d.shifts) })
      .catch(() => {})
  }, [viewRange?.start, selectedClinicId, cardRefreshTick])
  const [templates, setTemplates] = useState<ShiftTemplate[]>([])
  const [changeRequests, setChangeRequests] = useState<ShiftChangeRequest[]>([])
  const [userRole, setUserRole] = useState<string>('')
  const [userId, setUserId] = useState<string>('')
  const [loading, setLoading] = useState(true)

  // Step 7: Overview scope
  const [ovScope, setOvScope] = useState<OvScope>({ type: 'all' })

  // UI State
  const [selectedTemplate, setSelectedTemplate] = useState<ShiftTemplate | null>(null)
  const [leaveTypes, setLeaveTypes] = useState<any[]>([])
  const [leaveRequests, setLeaveRequests] = useState<any[]>([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('')
  const [empScope, setEmpScope] = useState<'clinic' | 'all'>('clinic')

  // Touch detection for iPad: coarse = touch (iPad/phone) → click mode; fine = mouse → drag
  const [isTouch, setIsTouch] = useState(false)
  useEffect(() => {
    setIsTouch(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  // Mobile day view state
  const [mobileSelectedDate, setMobileSelectedDate] = useState<string>(toHKDateStr(todayHK()))
  const [mobileView, setMobileView] = useState<'day' | 'week'>('day')
  const mobileWeekDays = useMemo(() => {
    const d = new Date(mobileSelectedDate)
    const dow = d.getDay() // 0=日
    const mondayOffset = dow === 0 ? -6 : 1 - dow
    const monday = new Date(d)
    monday.setDate(d.getDate() + mondayOffset)
    const days: string[] = []
    for (let i = 0; i < 7; i++) {
      const wd = new Date(monday)
      wd.setDate(monday.getDate() + i)
      days.push(toHKDateStr(wd))
    }
    return days // 週一→週日，固定一週
  }, [mobileSelectedDate])

  const shiftMobileWeek = (deltaDays: number) => {
    const d = new Date(mobileSelectedDate)
    d.setDate(d.getDate() + deltaDays)
    setMobileSelectedDate(toHKDateStr(d))
  }

  // Desktop: week navigation linked with FullCalendar
  const shiftViewWeek = (delta: number) => {
    const api = calendarRef.current?.getApi()
    if (api) { delta < 0 ? api.prev() : api.next(); return }
    if (viewRange) {
      const s = new Date(viewRange.start); s.setDate(s.getDate() + delta)
      const e = new Date(viewRange.end); e.setDate(e.getDate() + delta)
      setViewRange({ start: toHKDateStr(s), end: toHKDateStr(e) })
    }
  }

  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [showChangePanel, setShowChangePanel] = useState(false)
  const [editingShift, setEditingShift] = useState<Shift | null>(null)
  const [showNewShiftModal, setShowNewShiftModal] = useState(false)
  const [showRuleSettings, setShowRuleSettings] = useState(false)
  const [showLeaveEmployeeModal, setShowLeaveEmployeeModal] = useState<{ date: string; leaveTypeId: string } | null>(null)
  const [displayWarning, setDisplayWarning] = useState<string | null>(null)
  const [fullscreenOverview, setFullscreenOverview] = useState(false)

  // Capsule label parts (persisted in localStorage)
  const [labelParts, setLabelParts] = useState<LabelPart[]>(() => {
    try { return JSON.parse((typeof window !== 'undefined' ? localStorage.getItem('ov_label_parts') : null) || '["clinic","shift"]') }
    catch { return ['clinic', 'shift'] }
  })
  const toggleLabelPart = (p: LabelPart) => setLabelParts(prev => {
    const next = prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]
    const ordered = (['clinic', 'shift', 'name'] as LabelPart[]).filter(x => next.includes(x))
    if (typeof window !== 'undefined') localStorage.setItem('ov_label_parts', JSON.stringify(ordered))
    return ordered.length ? ordered : ['shift']
  })

  // 📅 Calendar show/hide
  const [showCalendar, setShowCalendar] = useState<boolean>(
    () => { try { return localStorage.getItem('sched_show_cal') !== '0' } catch { return true } }
  )
  const toggleCalendar = () => {
    setShowCalendar(v => {
      const next = !v
      try { localStorage.setItem('sched_show_cal', next ? '1' : '0') } catch {}
      return next
    })
  }

  // 🏢 Derive current company from selected clinic
  const currentCompanyId = clinics.find(c => c.id === selectedClinicId)?.company?.id ?? null
  const currentCompanyName = currentCompanyId
    ? clinics.find(c => c.id === selectedClinicId)?.company?.name ?? '未知'
    : ''

  // 🗑 Drag-to-delete via pointer capture (stable, no lost events)
  const overviewRef = useRef<HTMLDivElement>(null)

  // 🔧 Undo toast state
  const [undoToast, setUndoToast] = useState<{ label: string; restore: () => Promise<void> } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 🔧 Fix #3a: 抓當前選中員工的假期餘額
  const [selectedEmpBalances, setSelectedEmpBalances] = useState<any[]>([])
  useEffect(() => {
    if (!selectedEmployeeId) { setSelectedEmpBalances([]); return }
    fetch(`/api/leave-balance?employeeId=${selectedEmployeeId}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { leaveBalances: [] })
      .then(d => setSelectedEmpBalances(d.leaveBalances || []))
      .catch(() => setSelectedEmpBalances([]))
  }, [selectedEmployeeId])

  // 🔧 Fix #4a: Refresh leave balances after drag-drop or delete
  const refreshLeaveBalances = useCallback(async () => {
    if (!selectedEmployeeId) return
    const res = await fetch(`/api/leave-balance?employeeId=${selectedEmployeeId}`, { credentials: 'include' })
    if (res.ok) {
      const d = await res.json()
      setSelectedEmpBalances(d.leaveBalances || [])
    }
  }, [selectedEmployeeId])

  // Shift rule config state
  const [shiftRuleConfig, setShiftRuleConfig] = useState<ShiftRuleConfig>({ ...DEFAULT_SHIFT_RULE_CONFIG })
  const [savingRules, setSavingRules] = useState(false)

  // Drag and drop state
  const dragData = useRef<{ employeeId: string; templateId: string } | null>(null)
  const draggingTemplate = useRef<{ templateId: string; employeeId: string } | null>(null)
  const draggingLeave = useRef<{ leaveTypeId: string; employeeId: string } | null>(null)
  const justDroppedRef = useRef(false)

  // Global pointerup cleanup for draggingTemplate & draggingLeave (next tick, let cell's pointerup fire first)
  useEffect(() => {
    const clear = () => setTimeout(() => {
      draggingTemplate.current = null
      draggingLeave.current = null
    }, 50)
    window.addEventListener('pointerup', clear)
    return () => window.removeEventListener('pointerup', clear)
  }, [])

  // Set compact slot height after calendar mounts
  useEffect(() => {
    const cal = calendarRef.current?.getApi()
    if (cal) {
      cal.option('slotHeight', 36)
    }
  }, [])

  // === Callback refs for Draggable registration (no useEffect deps) ===
  const leaveDraggableRef = useRef<Draggable | null>(null)
  const attachLeavePanel = useCallback((node: HTMLDivElement | null) => {
    if (leaveDraggableRef.current) {
      leaveDraggableRef.current.destroy()
      leaveDraggableRef.current = null
    }
    if (node) {
      leaveDraggableRef.current = new Draggable(node, {
        itemSelector: '.leave-card',
        eventData: (el: HTMLElement) => ({
          title: el.getAttribute('data-name') || '假期',
          extendedProps: {
            dragType: 'leave',
            leaveTypeId: el.getAttribute('data-leave-id'),
          },
          backgroundColor: '#4a4a4a',
          borderColor: '#4a4a4a',
        }),
      })
    }
  }, [])

  const templateDraggableRef = useRef<Draggable | null>(null)
  const attachTemplatePanel = useCallback((node: HTMLDivElement | null) => {
    templateDraggableRef.current?.destroy()
    templateDraggableRef.current = null
    if (node) {
      templateDraggableRef.current = new Draggable(node, {
        itemSelector: '.template-card',
        eventData: (el: HTMLElement) => ({
          title: el.getAttribute('data-name') || '',
          extendedProps: { dragType: 'shift', templateId: el.getAttribute('data-template-id') },
        }),
      })
    }
  }, [])

  const employeeDraggableRef = useRef<Draggable | null>(null)
  const attachEmployeePanel = useCallback((node: HTMLDivElement | null) => {
    employeeDraggableRef.current?.destroy()
    employeeDraggableRef.current = null
    if (node) {
      employeeDraggableRef.current = new Draggable(node, {
        itemSelector: '.employee-card',
        eventData: (el: HTMLElement) => ({
          title: el.getAttribute('data-name') || '',
          extendedProps: { dragType: 'employee', employeeId: el.getAttribute('data-employee-id') },
        }),
      })
    }
  }, [])
  const calendarContainerRef = useRef<HTMLDivElement>(null)
  const calendarRef = useRef<any>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const [isDraggingEvent, setIsDraggingEvent] = useState(false)

  // Month-level shifts for statistics (Task 3b)
  const [monthShifts, setMonthShifts] = useState<any[]>([])

  
// Fixed color palette for employee drag chips
const EMPLOYEE_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#a855f7', '#d946ef', '#e11d48', '#0ea5e9', '#10b981',
];
function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return EMPLOYEE_COLORS[Math.abs(hash) % EMPLOYEE_COLORS.length];
}

// Clinic abbreviation and color maps for overview grid
const CLINIC_ABBR: Record<string, string> = {
  '銅鑼灣診所': '銅', '旺角診所': '旺', '荃灣診所': '荃',
  '仁愛診所': '仁', '沙田診所': '沙', '元朗診所': '元',
}
const CLINIC_COLOR: Record<string, string> = {
  '銅鑼灣診所': '#e74c3c', '旺角診所': '#27ae60', '荃灣診所': '#8e44ad',
  '仁愛診所': '#2980b9', '沙田診所': '#e67e22', '元朗診所': '#16a085',
}
function getShiftCode(shift: Shift): string {
  const clinicName = shift.clinic?.name || ''
  const abbr = CLINIC_ABBR[clinicName] || clinicName?.[0] || '?'
  const tplName = shift.template?.shortName || shift.template?.name || '班'
  return `${abbr}-${tplName}`
}
function getShiftColor(shift: Shift): string {
  return CLINIC_COLOR[shift.clinic?.name || ''] || '#95a5a6'
}
function getClinicColor(name: string): string {
  return CLINIC_COLOR[name] || '#95a5a6'
}

  // ============================================================
  // Data Loading
  // ============================================================
  const loadData = useCallback(async () => {
    try {
      const [meRes, clinicsRes, employeesRes, changesRes] = await Promise.all([
        fetch('/api/me', { credentials: 'include' }),
        fetch('/api/clinics', { credentials: 'include' }),
        fetch('/api/employees?pageSize=200', { credentials: 'include' }),
        fetch('/api/shift-changes', { credentials: 'include' }),
      ])

      if (meRes.ok) {
        const meData = await meRes.json()
        setUserRole(meData.user.role)
        setUserId(meData.user.id)
      }

      if (clinicsRes.ok) {
        const clinicsData = await clinicsRes.json()
        setClinics(clinicsData.clinics || [])
        if (clinicsData.clinics?.length > 0 && !selectedClinicId) {
          setSelectedClinicId(clinicsData.clinics[0].id)
        }
      }

      if (employeesRes.ok) {
        const empData = await employeesRes.json()
        setEmployees(empData.employees || [])
      }

      if (changesRes.ok) {
        const changesData = await changesRes.json()
        setChangeRequests(changesData.requests || [])
      }
    } catch (error) {
      console.error('Failed to load data:', error)
    } finally {
      setLoading(false)
    }
  }, [selectedClinicId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Load shift rule config for selected clinic
  useEffect(() => {
    if (!selectedClinicId) return
    fetch(`/api/clinics/${selectedClinicId}/shift-rule-config`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setShiftRuleConfig(d.shiftRules || { ...DEFAULT_SHIFT_RULE_CONFIG }))
      .catch(() => setShiftRuleConfig({ ...DEFAULT_SHIFT_RULE_CONFIG }))
  }, [selectedClinicId])

  // Load templates scoped to current company (reloads when clinic/company changes)
  useEffect(() => {
    if (!currentCompanyId) return
    fetch(`/api/shifts/templates?companyId=${currentCompanyId}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setTemplates(d.templates || []))
      .catch(() => setTemplates([]))
  }, [currentCompanyId])

  // Load month-level shifts for statistics (all clinics)
  const loadMonthShifts = useCallback(async () => {
    const now = new Date()
    const monthStart = toHKDateStr(new Date(now.getFullYear(), now.getMonth(), 1))  // tz-ok: client-side browser
    const monthEnd = toHKDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0))  // tz-ok: client-side browser
    try {
      const r = await fetch(`/api/shifts?startDate=${monthStart}&endDate=${monthEnd}&pageSize=1000`, { credentials: 'include' })
      if (r.ok) {
        const d = await r.json()
        setMonthShifts(d.shifts || [])
      }
    } catch {
      setMonthShifts([])
    }
  }, [])

  useEffect(() => {
    loadMonthShifts()
  }, [loadMonthShifts])

  // Filter employees by selected clinic
  const clinicEmployees = useMemo(() => {
    const activeEmployees = employees.filter(emp => emp.status === 'ACTIVE' || emp.status === undefined)
    if (empScope === 'all' || !selectedClinicId) return activeEmployees
    return activeEmployees.filter(emp =>
      emp.clinics.some(ec => ec.clinic.id === selectedClinicId)
    )
  }, [employees, selectedClinicId, empScope])

  // Step 5: Group clinics by company
  const companyGroups = useMemo(() => {
    const map = new Map<string, { name: string; companyId: string; clinics: Clinic[] }>()
    for (const c of clinics) {
      const key = c.company?.id ?? '_none'
      if (!map.has(key)) map.set(key, { name: c.company?.name ?? '未分組', companyId: key, clinics: [] })
      map.get(key)!.clinics.push(c)
    }
    return [...map.values()]
  }, [clinics])

  // Step 7: Scope clinic IDs
  const scopeClinicIds = useMemo(() => {
    if (ovScope.type === 'all') return null
    if (ovScope.type === 'company') return new Set(clinics.filter(c => c.company?.id === ovScope.id).map(c => c.id))
    return new Set([ovScope.id])
  }, [ovScope, clinics])

  // Step 7: Overview employees (filtered by scope + sorted by role then name, full/part split)
  const ovEmployees = useMemo(() => {
    const activeEmployees = employees.filter(emp => emp.status === 'ACTIVE' || emp.status === undefined)
    const scoped = !scopeClinicIds ? activeEmployees
      : activeEmployees.filter(e => e.clinics?.some((ec: any) => scopeClinicIds.has(ec.clinic?.id)))
    const full = scoped.filter(e => e.payRules?.[0]?.payType !== 'HOURLY').sort(byRoleThenName)
    const part = scoped.filter(e => e.payRules?.[0]?.payType === 'HOURLY').sort(byRoleThenName)
    return { full, part, ordered: [...full, ...part] }
  }, [employees, scopeClinicIds])

  // Step 7: Overview shifts (filtered by scope)
  const ovShifts = useMemo(() => {
    if (!scopeClinicIds) return shifts
    return shifts.filter(s => scopeClinicIds.has(s.clinicId))
  }, [shifts, scopeClinicIds])

  // Step 7: Companies derived from clinics (deduplicated)
  const companies = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>()
    clinics.forEach((c: any) => {
      if (c.company?.id) m.set(c.company.id, c.company)
    })
    return [...m.values()]
  }, [clinics])

  // Helper: get mobile overview cell for an employee on a given date
  const getMobileCell = useCallback((empId: string, dateStr: string) => {
    const empShiftsOnDay = ovShifts.filter(s =>
      s.employeeId === empId && toHKDateStr(new Date(s.date)) === dateStr
    )
    const empLeavesOnDay = leaveRequests.filter(lr =>
      lr.employeeId === empId && leaveCoversDate(lr, dateStr)
    )
    if (empShiftsOnDay.length > 0) {
      const s = empShiftsOnDay[0]
      const clinicName = (s.clinic as any)?.shortName || s.clinic?.name || ''
      const shiftName = s.template?.shortName || s.template?.name || s.role || ''
      const color = getClinicColor(s.clinic?.name || '')
      const timeLabel = fmtTime(s.startTime).slice(0, 5)
      return { label: shiftName || clinicName, bg: color, detail: `${shiftName} ${timeLabel}` }
    }
    if (empLeavesOnDay.length > 0) {
      const lr = empLeavesOnDay[0]
      const leaveTypeMap: Record<string, string> = { ANNUAL: '年', SICK: '病', HALF_SICK: '半病', UNPAID: '無薪', SPECIAL: '特' }
      return { label: leaveTypeMap[lr.leaveType] || '假', bg: '#fef3c7', detail: leaveTypeMap[lr.leaveType] || '假' }
    }
    return { label: 'R', bg: '#f3f4f6', detail: 'R' }
  }, [ovShifts, leaveRequests])

  // Mobile week label: "M/D–M/D"
  const mobileWeekLabel = useMemo(() => {
    if (mobileWeekDays.length < 2) return ''
    const start = mobileWeekDays[0].slice(5) // MM-DD
    const end = mobileWeekDays[6].slice(5)
    return `${start}–${end}`
  }, [mobileWeekDays])

  // Step 6: Split by pay type
  const fullTimeEmps = clinicEmployees.filter(e => e.payRules?.[0]?.payType !== 'HOURLY').sort(byName)
  const partTimeEmps = clinicEmployees.filter(e => e.payRules?.[0]?.payType === 'HOURLY').sort(byName)

  // Load leave types
  useEffect(() => {
    const fetchLeaveTypes = async () => {
      try {
        const res = await fetch('/api/leave-types', { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data.leaveTypes)) setLeaveTypes(data.leaveTypes)
        }
      } catch (err) {
        console.error('Failed to load leave types:', err)
      }
    }
    fetchLeaveTypes()
  }, [])

  // ============================================================
  // Load shifts for current view (all clinics, no clinicId filter)
  // ============================================================
  const loadShifts = useCallback(async () => {
    if (!viewRange) return

    // Extend endDate by 7 days to cover both this week and next week in overview
    const endDate = new Date(viewRange.end)
    endDate.setDate(endDate.getDate() + 7)
    const endDateStr = toHKDateStr(endDate)

    const url = `/api/shifts?startDate=${viewRange.start}&endDate=${endDateStr}&pageSize=1000`

    try {
      const [shiftsRes, leavesRes] = await Promise.all([
        fetch(url, { credentials: 'include' }),
        fetch(`/api/leave-requests?startDate=${viewRange.start}&endDate=${endDateStr}&status=APPROVED`, { credentials: 'include' }),
      ])
      if (shiftsRes.ok) {
        const data = await shiftsRes.json()
        if (Array.isArray(data.shifts)) setShifts(data.shifts)
      }
      if (leavesRes.ok) {
        const leavesData = await leavesRes.json()
        if (Array.isArray(leavesData.leaveRequests)) setLeaveRequests(leavesData.leaveRequests)
      }
    } catch (error) {
      console.error('Failed to load shifts:', error)
    }
  }, [viewRange])

  useEffect(() => {
    if (viewRange) loadShifts()
  }, [viewRange])

  // Mobile: load shifts for the current mobile week independently
  useEffect(() => {
    if (!selectedClinicId || mobileWeekDays.length === 0) return
    const weekStart = mobileWeekDays[0]
    const weekEnd = mobileWeekDays[6]
    if (!weekStart || !weekEnd) return
    const url = `/api/shifts?startDate=${weekStart}&endDate=${weekEnd}&pageSize=1000`
    fetch(url, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { shifts: [] })
      .then(d => { if (Array.isArray(d.shifts)) setShifts((prev: Shift[]) => {
        const existingIds = new Set(prev.map((s: Shift) => s.id))
        const newShifts = d.shifts.filter((s: Shift) => !existingIds.has(s.id))
        return newShifts.length ? [...prev, ...newShifts] : prev
      }) })
      .catch(err => console.error('Failed to load mobile shifts:', err))
    // Also load leave requests for the mobile week
    fetch(`/api/leave-requests?startDate=${weekStart}&endDate=${weekEnd}&status=APPROVED`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { leaveRequests: [] })
      .then(d => { if (Array.isArray(d.leaveRequests)) setLeaveRequests((prev: any[]) => {
        const existingIds = new Set(prev.map((lr: any) => lr.id))
        const newLeaves = d.leaveRequests.filter((lr: any) => !existingIds.has(lr.id))
        return newLeaves.length ? [...prev, ...newLeaves] : prev
      }) })
      .catch(() => {})
  }, [mobileSelectedDate, selectedClinicId])

  // Refresh all data after shift changes (Task 2)
  const refreshAll = useCallback(async () => {
    await loadShifts()
    await loadMonthShifts()
    setCardRefreshTick(t => t + 1)
  }, [loadShifts, loadMonthShifts])

  // Unified deleteLeave helper — single entry point for all leave deletions
  const deleteLeave = useCallback(async (leaveId: string) => {
    const res = await fetch(`/api/leave-requests/${leaveId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (res.ok) {
      await refreshAll()
      await refreshLeaveBalances()
      return true
    } else {
      const err = await res.json().catch(() => ({}))
      alert(err.error || '刪除假期失敗')
      return false
    }
  }, [refreshAll, refreshLeaveBalances])

  // 🗑 Drag-out delete via pointer capture — with undo
  const { start: shiftDragOutStart, ghost: shiftGhost } = useDragOutDeleteWithUndo(
    overviewRef, async (id, label, _restoreFn) => {
      const s = shifts.find(x => x.id === id)
      if (!s) return
      const raw = {
        employeeId: s.employeeId,
        clinicId: s.clinicId,
        date: toHKDateStr(new Date(s.date)),
        startTime: s.startTime,
        endTime: s.endTime,
        templateId: s.templateId,
      }
      const res = await fetch(`/api/shifts/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) { alert('刪除失敗'); return }
      await refreshAll()
      const restore = async () => {
        await fetch('/api/shifts', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(raw),
        })
        await refreshAll()
      }
      if (undoTimer.current) clearTimeout(undoTimer.current)
      setUndoToast({ label: `已刪除 ${label}`, restore })
      undoTimer.current = setTimeout(() => setUndoToast(null), 5000)
    },
  )
  const { start: leaveDragOutStart, ghost: leaveGhost } = useDragOutDeleteWithUndo(
    overviewRef, async (id, label, _restoreFn) => {
      const lr = leaveRequests.find(x => x.id === id)
      if (!lr) return
      const raw = {
        leaveTypeId: lr.leaveTypeId,
        employeeId: lr.employeeId,
        startDate: lr.startDate,
        endDate: lr.endDate || lr.startDate,
        days: lr.days ?? 1,
        reason: lr.reason ?? `排班頁拖曳請假`,
        isPlanned: lr.isPlanned ?? true,
        clinicId: lr.clinicId,
      }
      const res = await fetch(`/api/leave-requests/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) { alert('刪除失敗'); return }
      await refreshAll()
      await refreshLeaveBalances()
      const restore = async () => {
        await fetch('/api/leave-requests', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(raw),
        })
        await refreshAll()
        await refreshLeaveBalances()
      }
      if (undoTimer.current) clearTimeout(undoTimer.current)
      setUndoToast({ label: `已刪除 ${label}`, restore })
      undoTimer.current = setTimeout(() => setUndoToast(null), 5000)
    },
  )

  // ============================================================
  // Date Helpers
  // ============================================================
  const getDateRange = (): { startDate: string; endDate: string } => {
    const base = new Date(currentDate)
    if (viewMode === 'week') {
      const day = base.getDay()  // tz-ok: client-side browser
      const diff = (day === 0 ? -6 : 1) - day // offset to Monday
      const start = new Date(base)
      start.setDate(base.getDate() + diff)  // tz-ok: client-side browser
      const end = new Date(start)
      end.setDate(start.getDate() + 6)  // tz-ok: client-side browser
      return {
        startDate: toHKDateStr(start),
        endDate: toHKDateStr(end),
      }
    } else {
      const start = new Date(base.getFullYear(), base.getMonth(), 1)  // tz-ok: client-side browser
      const end = new Date(base.getFullYear(), base.getMonth() + 1, 0)  // tz-ok: client-side browser
      return {
        startDate: toHKDateStr(start),
        endDate: toHKDateStr(end),
      }
    }
  }

  const getDates = (): Date[] => {
    const { startDate, endDate } = getDateRange()
    const dates: Date[] = []
    const start = new Date(startDate)
    const end = new Date(endDate)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {  // tz-ok: client-side browser
      dates.push(new Date(d))
    }
    return dates
  }

  const formatDate = (date: Date): string => {
    return toHKDateStr(date)
  }

  const formatDateLabel = (date: Date): string => {
    const dayNames = ['日', '一', '二', '三', '四', '五', '六']
    return `${date.getMonth() + 1}/${date.getDate()} 周${dayNames[date.getDay()]}`  // tz-ok: client-side browser
  }

  // Note: navigateDate removed — FC headerToolbar handles prev/next

  // ============================================================
  // Shift Operations
  // ============================================================
  const getShiftForCell = (employeeId: string, dateStr: string): Shift | undefined => {
    return shifts.find(
      s => s.employeeId === employeeId && formatDate(new Date(s.date)) === dateStr
    )
  }

  const saveShiftRuleConfig = async (updatedRules: ShiftRuleConfig) => {
    if (!selectedClinicId) return
    setSavingRules(true)
    try {
      const res = await fetch(`/api/clinics/${selectedClinicId}/shift-rule-config`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedRules),
      })
      if (res.ok) {
        const data = await res.json()
        setShiftRuleConfig(data.shiftRules)
        alert('排班規則已更新')
      }
    } catch (err) {
      console.error('Save shift rule config error:', err)
    } finally {
      setSavingRules(false)
    }
  }

  const createShift = async (employeeId: string, date: string, template: ShiftTemplate): Promise<boolean> => {
    if (!selectedClinicId) {
      setValidationIssues([{ type: 'error', rule: 'clinic', message: '⚠️ 請先選擇診所' }])
      return false
    }

    // Build start/end times from template — timezone-safe
    const pad = (n: number) => String(n).padStart(2, '0')
    const startTime = new Date(`${date}T${pad(template.startHour)}:${pad(template.startMinute)}:00+08:00`)
    const endTime = new Date(`${date}T${pad(template.endHour)}:${pad(template.endMinute)}:00+08:00`)

    // For night shifts, end time is next day
    if (template.isNightShift) {
      endTime.setTime(endTime.getTime() + 86400000)
    }

    // Validate first
    const validationResult = await validateBeforeCreate(employeeId, date, startTime.toISOString(), endTime.toISOString())
    if (!validationResult.valid) {
      setValidationIssues([
        ...validationResult.errors.map((e: any) => ({ type: 'error' as const, rule: e.rule, message: e.message })),
        ...validationResult.warnings.map((w: any) => ({ type: 'warning' as const, rule: w.rule, message: w.message })),
      ])
      if (validationResult.errors.length > 0) return false // Block on errors
    }

    try {
      const res = await fetch('/api/shifts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId,
          clinicId: selectedClinicId,
          date,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          templateId: template.id,
        }),
      })

      if (res.ok) {
        setValidationIssues([])
        const data = await res.json()
        // Optimistic update: add new shift to state immediately
        if (data.shifts?.[0]) {
          const newShift = { ...data.shifts[0], hasPunch: false }
          setShifts(prev => [...prev, newShift])
        }
        await refreshAll()
        return true
      } else {
        const err = await res.json()
        setValidationIssues([{ type: 'error', rule: 'api', message: err.error || '建立班次失敗' }])
        return false
      }
    } catch (error) {
      console.error('Create shift error:', error)
      setValidationIssues([{ type: 'error', rule: 'network', message: '❌ 網路錯誤，建立失敗' }])
      return false
    }
  }

  const validateBeforeCreate = async (employeeId: string, date: string, startTime: string, endTime: string): Promise<any> => {
    try {
      const res = await fetch('/api/shifts/validate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shift: {
            employeeId,
            clinicId: selectedClinicId,
            date,
            startTime,
            endTime,
          },
        }),
      })
      if (res.ok) return await res.json()
    } catch {
      // Validation failed, allow creation with warnings
    }
    return { valid: true, errors: [], warnings: [] }
  }

  const deleteShift = async (shiftId: string) => {
    try {
      const res = await fetch(`/api/shifts/${shiftId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        // Optimistic update
        setShifts(prev => prev.filter(s => s.id !== shiftId))
        await refreshAll()
      }
    } catch (error) {
      console.error('Delete shift error:', error)
    }
  }

  const bulkApplyTemplate = async () => {
    if (!selectedTemplate) {
      alert('請先選擇更次模板')
      return
    }

    const { startDate, endDate } = getDateRange()
    const dates: string[] = []
    const start = new Date(startDate)
    const end = new Date(endDate)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {  // tz-ok: client-side browser
      dates.push(formatDate(d))
    }

    // Filter employees by selected clinic
    const clinicEmps = employees.filter(emp =>
      emp.clinics.some(ec => ec.clinic.id === selectedClinicId)
    )

    try {
      const res = await fetch('/api/shifts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: clinicEmps[0]?.id, // bulk mode with dates
          clinicId: selectedClinicId,
          date: dates[0],
          startTime: buildTime(dates[0], selectedTemplate.startHour, selectedTemplate.startMinute),
          endTime: buildTime(dates[0], selectedTemplate.endHour, selectedTemplate.endMinute, selectedTemplate.isNightShift),
          templateId: selectedTemplate.id,
          bulkDates: dates,
        }),
      })

      if (res.ok) {
        await refreshAll()
        alert('批量套用成功')
      }
    } catch (error) {
      console.error('Bulk apply error:', error)
    }
  }

  const buildTime = (date: string, hour: number, minute: number, isNight = false): string => {
    const pad = (n: number) => String(n).padStart(2, '0')
    let dt = new Date(`${date}T${pad(hour)}:${pad(minute)}:00+08:00`)
    if (isNight) dt.setTime(dt.getTime() + 86400000)
    return dt.toISOString()
  }

  // ============================================================
  // Shift Change Requests
  // ============================================================
  const createChangeRequest = async (shiftId: string, type: ChangeType, toEmployeeId?: string, reason?: string) => {
    try {
      const res = await fetch('/api/shift-changes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftId, toEmployeeId, type, reason }),
      })

      if (res.ok) {
        const data = await res.json()
        setChangeRequests(prev => [data.changeRequest, ...prev])
        setShowChangePanel(false)
        setEditingShift(null)
      }
    } catch (error) {
      console.error('Create change request error:', error)
    }
  }

  const approveChangeRequest = async (id: string, action: 'APPROVE' | 'REJECT', reason?: string) => {
    try {
      const res = await fetch(`/api/shift-changes/${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      })

      if (res.ok) {
        loadShifts()
        const changesRes = await fetch('/api/shift-changes', { credentials: 'include' })
        if (changesRes.ok) {
          const data = await changesRes.json()
          setChangeRequests(data.requests || [])
        }
        await refreshAll()
      }
    } catch (error) {
      console.error('Approve change request error:', error)
    }
  }

  // ============================================================
  // Drag and Drop Handlers
  // ============================================================
  // Drop handler for overview grid — drag template to any (employee, day) cell or drag leave to create leave request
  const handleOverviewDrop = async (employeeId: string, dateStr: string) => {
    // ① Template drag → create shift (existing logic)
    const drag = draggingTemplate.current
    if (drag) {
      draggingTemplate.current = null
      justDroppedRef.current = true
      setTimeout(() => { justDroppedRef.current = false }, 100)

      const tpl = templates.find(t => t.id === drag.templateId)
      if (!tpl) return

      const empId = drag.employeeId || employeeId
      if (!empId) return

      // Fix: check if employee has approved leave on that day
      const hasLeaveOnDate = leaveRequests.some(lr =>
        lr.employeeId === empId &&
        leaveCoversDate(lr, dateStr)
      )
      if (hasLeaveOnDate) {
        setValidationIssues([{ type: 'error', rule: 'shift', message: '❌ 該員工該天已有假期，無法排班' }])
        return
      }

      await createShift(empId, dateStr, tpl)
      return
    }

    // ② Leave drag → create leave request
    const dl = draggingLeave.current
    if (dl) {
      draggingLeave.current = null
      justDroppedRef.current = true
      setTimeout(() => { justDroppedRef.current = false }, 100)

      const lt = leaveTypes.find(l => l.id === dl.leaveTypeId)
      if (!lt || !dl.employeeId) return

      // Unlimited types (quantity === null && no systemKey) skip balance check
      const isUnlimited = lt.quantity == null && !lt.systemKey
      if (!isUnlimited) {
        const bal = selectedEmpBalances.find(b => b.leaveTypeId === dl.leaveTypeId)
        if (!bal || bal.remaining <= 0) {
          setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 此假期餘額不足，無法安排' }])
          return
        }
      }

      // Check no existing shift on that day for that employee
      const hasShiftOnDate = shifts.some(s =>
        s.employeeId === dl.employeeId &&
        toHKDateStr(new Date(s.date)) === dateStr
      )
      if (hasShiftOnDate) {
        setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 該員工該天已有排班，無法設置假期' }])
        return
      }

      try {
        const res = await fetch('/api/leave-requests', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leaveTypeId: dl.leaveTypeId,
            employeeId: dl.employeeId,
            startDate: dateStr,
            endDate: dateStr,
            days: 1,
            reason: `排班總覽拖曳請假`,
            isPlanned: true,
            clinicId: selectedClinicId,
          }),
        })
        if (res.ok) {
          setValidationIssues([])
          await refreshAll()
          await refreshLeaveBalances()
        } else {
          const err = await res.json()
          setValidationIssues([{ type: 'error', rule: 'leave', message: err.error || '建立請假失敗' }])
        }
      } catch {
        setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 建立請假失敗' }])
      }
      return
    }
  }

  const handleDragStart = (e: React.DragEvent, employeeId: string) => {
    dragData.current = { employeeId, templateId: selectedTemplate?.id || '' }
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', employeeId)
    // Visual feedback: fade the dragged element
    setTimeout(() => { (e.target as HTMLElement).style.opacity = '0.5' }, 0)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  // ============================================================
  // FullCalendar Event Handlers
  // ============================================================
  const handleFcEventClick = async (info: any) => {
    // Leave event: click to delete without confirm
    if (info.event.extendedProps.isLeave) {
      if (canManage) {
        const lr = info.event.extendedProps.leaveRequest
        const leaveId = lr?.id || info.event.id.replace('leave-', '')
        await deleteLeave(leaveId)
      }
      return
    }

    // Shift event
    const shift = shifts.find(s => s.id === info.event.id)
    if (shift) {
      // Touch mode: confirm delete instead of opening change panel
      if (isTouch && canManage) {
        if (confirm(`刪除 ${info.event.title}？`)) {
          await deleteShift(info.event.id)
        }
        return
      }
      setEditingShift(shift)
      if (canManage) {
        setShowChangePanel(true)
      }
    }
  }

  const handleFcEventDrop = async (info: any) => {
    const shift = shifts.find(s => s.id === info.event.id)
    if (!shift) return

    // Only change the date; keep original start/end times (template times)
    const newDate = new Date(info.event.start)

    try {
      const res = await fetch('/api/shifts/' + shift.id, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: toHKDateStr(newDate),
        }),
      })
      if (!res.ok) {
        info.revert()
        alert('排班移動失敗')
      } else {
        await refreshAll()
      }
    } catch {
      info.revert()
    }
  }

  const handleFcDateClick = async (info: any) => {
    if (!canManage) return

    // Touch mode: click grid → create shift directly with selected employee + template
    if (isTouch) {
      if (!selectedEmployeeId) {
        setValidationIssues([{ type: 'warning', rule: 'employee', message: '📱 請先點選左側員工' }])
        return
      }
      if (!selectedTemplate) {
        setValidationIssues([{ type: 'warning', rule: 'template', message: '📱 請先點選更次模板' }])
        return
      }
      const dateStr = info.dateStr
      const ok = await createShift(selectedEmployeeId, dateStr, selectedTemplate)
      if (ok) {
        setValidationIssues([])
        await refreshAll()
      }
      return
    }

    // Mouse mode: open shift creation modal
    if (!selectedTemplate) return
    setShowNewShiftModal(true)
    setCurrentDate(new Date(info.dateStr))
  }

  // Filter shifts by selected clinic for FC display
  const clinicFilteredShifts = useMemo(() => {
    if (!selectedClinicId) return []
    return shifts.filter(s => s.clinicId === selectedClinicId)
  }, [shifts, selectedClinicId])

  // Monthly work hours per employee (browsed month/week, current clinic)
  const monthlyWorkHours = useMemo(() => {
    if (!viewRange) return []
    const anchor = new Date(viewRange.start)
    const mStart = toHKDateStr(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
    const mEnd = toHKDateStr(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))
    const wStartStr = toHKDateStr(anchor)
    const wEndD = new Date(anchor); wEndD.setDate(anchor.getDate() + 6)
    const wEndStr = toHKDateStr(wEndD)

    // ★ 雙保險：merge cardShifts + shifts 避免週級別漏算
    const merged = (() => {
      const m = new Map<string, any>()
      cardShifts.forEach(s => m.set(s.id, s))
      shifts.forEach(s => m.set(s.id, s))
      return [...m.values()]
    })()

    const byEmp = new Map<string, { month: number; week: number }>()
    merged.forEach(s => {
      if (s.status === 'CANCELLED') return
      if (s.clinicId !== selectedClinicId) return
      const d = toHKDateStr(new Date(s.date))
      const h = Math.max(0, (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()) / 3600000 - 1)
      const cur = byEmp.get(s.employeeId) || { month: 0, week: 0 }
      if (d >= mStart && d <= mEnd) cur.month += h
      if (d >= wStartStr && d <= wEndStr) cur.week += h
      byEmp.set(s.employeeId, cur)
    })
    return clinicEmployees
      .map(e => {
        const v = byEmp.get(e.id) || { month: 0, week: 0 }
        return { id: e.id, name: e.user?.name ?? '?', month: Math.round(v.month * 10) / 10, week: Math.round(v.week * 10) / 10 }
      })
      .filter(x => x.month > 0 || x.week > 0)
      .sort((a, b) => b.month - a.month)
  }, [cardShifts, shifts, viewRange, clinicEmployees, selectedClinicId])

  // Task 3: Per-week stats helper (statsForDays + renderWeekStats)
  const statsForDays = useCallback((days: { date: Date; label: string; dateStr: string }[]) => {
    if (!selectedEmployeeId || days.length === 0) return null
    const emp = clinicEmployees.find(e => e.id === selectedEmployeeId)
    if (!emp) return null
    const daySet = new Set(days.map(d => d.dateStr))
    const empShifts = clinicFilteredShifts.filter(
      s => s.employeeId === selectedEmployeeId && daySet.has(toHKDateStr(new Date(s.date)))
    )
    const dayCount = new Set(empShifts.map(s => s.date)).size
    const lunchDefaultMin = 60 // ★ 預設午休 1 小時（與 payroll engine 一致）
    const hours = empShifts.reduce((sum, s) => {
      const shiftMs = new Date(s.endTime).getTime() - new Date(s.startTime).getTime()
      const shiftHours = shiftMs / 3600000
      const withLunchDeduct = Math.max(0, shiftHours - lunchDefaultMin / 60)
      return sum + withLunchDeduct
    }, 0)
    return { name: emp.user?.name ?? '?', days: dayCount, hours: Math.round(hours * 10) / 10 }
  }, [selectedEmployeeId, clinicFilteredShifts, clinicEmployees])

  const renderWeekStats = useCallback((days: { date: Date; label: string; dateStr: string }[]) => {
    const st = statsForDays(days)
    return (
      <div style={{
        padding: '6px 10px', borderRadius: '0 0 8px 8px',
        border: '1px solid #e5e7eb', borderTop: 'none',
        background: '#f0f4ff',
        fontSize: 13,
        color: st ? '#374151' : '#9ca3af',
      }}>
        {st
          ? <span>{st.name}: {st.days} 天班 · {st.hours.toFixed(1)} 小時</span>
          : <span>請先選取員工</span>
        }
      </div>
    )
  }, [statsForDays])

  // Map shifts to FC events — colors by employee, leave by gray
  const fcEvents = [
    ...clinicFilteredShifts.map(s => {
      const shiftDate = new Date(s.date)
      const todayStart = hkDateStart(toHKDateStr(new Date()))
      const isPast = shiftDate < todayStart
      const isAbsent = isPast && !s.hasPunch

      // Employee color for shifts, gray for absent indicator
      const empColor = colorFor(s.employeeId)
      let backgroundColor = empColor
      let borderColor = empColor
      if (isAbsent) {
        backgroundColor = '#e74c3c'
        borderColor = '#c0392b'
      }

      return {
        id: s.id,
        title: `${s.employee?.user?.name || ''} ${s.template?.name || ''}${isAbsent ? ' ⚠️' : ''}`,
        start: s.startTime,
        end: s.endTime,
        backgroundColor,
        borderColor,
        extendedProps: { shift: s, isAbsent },
      }
    }),
    ...leaveRequests
      .filter(lr => !selectedClinicId || lr.clinicId === selectedClinicId)
      .map((lr) => ({
      id: 'leave-' + lr.id,
      title: lr.employee?.user?.name + ' ' + (lr.leaveType?.name || ''),
      start: lr.startDate,
      end: lr.endDate,
      backgroundColor: '#4a4a4a',
      borderColor: '#4a4a4a',
      extendedProps: { isLeave: true, leaveRequest: lr },
    })),
  ]

  // Jump to edit: click overview grid → switch clinic + scroll to calendar
  function jumpToEdit(shift: Shift | undefined, date: string) {
    if (shift) setSelectedClinicId(shift.clinicId)
    calendarRef.current?.getApi()?.gotoDate(date)
    document.getElementById('fc-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const handleDrop = async (e: React.DragEvent, employeeId: string, dateStr: string) => {
    e.preventDefault()
    if (!selectedTemplate) {
      setValidationIssues([{ type: 'error', rule: 'template', message: '⚠️ 請先選擇班次模板' }])
      return
    }

    const result = await createShift(employeeId, dateStr, selectedTemplate)
    if (result) {
      await refreshAll()
    } else {
      setValidationIssues([{ type: 'error', rule: 'create', message: '❌ 建立班次失敗' }])
    }
  }

  const canManage = userRole === 'OWNER' || userRole === 'MANAGER'
  const isCanRead = userRole === 'OWNER' || userRole === 'MANAGER' || userRole === 'ACCOUNTANT' || userRole === 'EMPLOYEE'

  // ============================================================
  // Render Helpers
  // ============================================================
  // Helper: count shift days for an employee this month
  const empShiftDays = (empId: string): number => {
    return new Set(
      monthShifts.filter(s => s.employeeId === empId).map(s => toHKDateStr(new Date(s.date)))
    ).size
  }

  const formatTimeFromShift = (isoString: string): string => fmtTime(isoString)

  // Helper: calculate shift hours (Task 3b)
  const shiftHours = (shift: any): number => {
    const s = new Date(shift.startTime)
    const e = new Date(shift.endTime)
    return (e.getTime() - s.getTime()) / (1000 * 60 * 60)
  }

  // ============================================================
  // Render Overview Week — takes a days array, renders title + table + stats
  // ============================================================
  const renderOverviewWeek = (days: typeof weekDays, title: string) => (
    <div style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', margin: '8px 0 4px 10px' }}>
        {title}（{days[0]?.dateStr.slice(5)} – {days[6]?.dateStr.slice(5)}）
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', overflowX: 'auto' }}>
        <table className="overview-table" style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '12%' }} />
            {days.map((d, i) => <col key={i} style={{ width: `${88 / 7}%` }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{
                position: 'sticky', left: 0, background: '#f3f4f6',
                padding: '4px 6px', textAlign: 'left', zIndex: 10,
                borderBottom: '2px solid #e5e7eb',
              }}>員工</th>
              {days.map((wd, i) => (
                <th key={i} style={{
                  padding: '4px 2px', textAlign: 'center',
                  borderBottom: '2px solid #e5e7eb',
                }}>{wd.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Full-time employees (sorted by role then name) */}
            {ovEmployees.full.map(emp => (
              <tr key={emp.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{
                  position: 'sticky', left: 0,
                  background: emp.status === 'ACTIVE' || emp.status === undefined ? '#fafbfc' : '#fee2e2',
                  padding: '4px 8px', whiteSpace: 'nowrap', zIndex: 5,
                  fontWeight: 500, fontSize: 11,
                }}>{emp.user?.name ?? '?'}</td>
                {days.map((wd, dayIdx) => {
                  const empShiftsOnDay = ovShifts.filter(s =>
                    s.employeeId === emp.id &&
                    toHKDateStr(new Date(s.date)) === wd.dateStr
                  )
                  const empLeavesOnDay = leaveRequests.filter(lr =>
                    lr.employeeId === emp.id &&
                    leaveCoversDate(lr, wd.dateStr)
                  )
                  const hasShift = empShiftsOnDay.length > 0
                  const hasLeave = empLeavesOnDay.length > 0
                  return (
                    <td key={dayIdx}
                      className="overview-cell"
                      onPointerUp={() => handleOverviewDrop(emp.id, wd.dateStr)}
                      onPointerEnter={e => {
                        if (!draggingTemplate.current && !draggingLeave.current) return
                        ;(e.currentTarget as HTMLTableCellElement).style.background = '#ecfdf5'
                        ;(e.currentTarget as HTMLTableCellElement).style.outline = '2px dashed #10b981'
                        ;(e.currentTarget as HTMLTableCellElement).style.outlineOffset = '-2px'
                      }}
                      onPointerLeave={e => {
                        if (hasShift) return
                        if (hasLeave) {
                          ;(e.currentTarget as HTMLTableCellElement).style.background = '#4a4a4a10'
                        } else {
                          ;(e.currentTarget as HTMLTableCellElement).style.background = '#f0f0f0'
                        }
                        ;(e.currentTarget as HTMLTableCellElement).style.outline = ''
                        ;(e.currentTarget as HTMLTableCellElement).style.outlineOffset = ''
                      }}
                      style={{
                        padding: '2px 3px', textAlign: 'center',
                        cursor: hasShift ? 'pointer' : 'default',
                        background: hasShift ? '' : hasLeave ? '#4a4a4a10' : '#f0f0f0',
                        transition: 'background 0.15s',
                        verticalAlign: 'top',
                      }}
                      onMouseEnter={e => {
                        if (!hasShift && !hasLeave) (e.currentTarget as HTMLTableCellElement).style.background = '#e0e7ff'
                      }}
                      onMouseLeave={e => {
                        if (!hasShift && !hasLeave) (e.currentTarget as HTMLTableCellElement).style.background = '#f0f0f0'
                      }}
                      onClick={async () => {
                        if (justDroppedRef.current) return
                        // Touch mode: click cell to create shift with selected employee + template
                        if (isTouch && canManage && selectedEmployeeId && selectedTemplate && !hasShift && !hasLeave) {
                          const ok = await createShift(selectedEmployeeId, wd.dateStr, selectedTemplate)
                          if (ok) {
                            setValidationIssues([])
                            await refreshAll()
                          }
                          return
                        }
                        if (hasShift) jumpToEdit(empShiftsOnDay[0], wd.dateStr)
                      }}
                    >
                      <div className="overview-cell-inner">
                        {empShiftsOnDay.map((s, si) => {
                          const tpl = templates.find(t => t.id === s.templateId)
                          const clinic = clinics.find(c => c.id === s.clinicId)
                          const parts: string[] = []
                          if (labelParts.includes('clinic')) parts.push(clinic?.shortName || clinic?.name?.slice(0, 1) || '')
                          if (labelParts.includes('shift')) parts.push(tpl?.shortName || tpl?.name?.slice(0, 2) || fmtTime(s.startTime))
                          if (labelParts.includes('name')) parts.push(s.employee?.user?.name?.slice(0, 2) || '')
                          const shiftLabel = parts.filter(Boolean).join('·')
                          const shiftTitle = `${s.employee?.user?.name} ${clinic?.name ?? ''} ${tpl?.name ?? ''} ${fmtTime(s.startTime)}-${fmtTime(s.endTime)}`
                          return (
                            <div key={'s' + si} className="ov-capsule" title={shiftTitle} style={{
                              background: getShiftColor(s),
                              touchAction: 'none',
                              userSelect: 'none',
                            }}
                              onPointerDown={(e) => shiftDragOutStart(e, s.id, shiftLabel, () => Promise.resolve())}
                            >
                              {shiftLabel}
                            </div>
                          )
                        })}
                        {empLeavesOnDay.map((lr, li) => {
                          const leaveColor = lr.leaveType?.color ?? '#9ca3af'
                          const leaveLabel = `${lr.leaveType?.name}·${lr.employee?.user?.name?.slice(0, 2)}`
                          const leaveTitle = `${lr.employee?.user?.name} ${lr.leaveType?.name}`
                          return (
                            <div key={'l' + li} className="ov-capsule" title={leaveTitle}
                              style={{
                                background: (leaveColor || '#9ca3af') + '26',
                                color: '#1f2937',
                                borderLeft: `3px solid ${leaveColor}`,
                                touchAction: 'none',
                                userSelect: 'none',
                              }}
                              onPointerDown={(e) => leaveDragOutStart(e, lr.id, leaveLabel, () => Promise.resolve())}
                            >
                              {leaveLabel}
                            </div>
                          )
                        })}
                        {(!hasShift && !hasLeave) && (
                          <span style={{ fontSize: 10, color: '#999', fontWeight: 500 }}>R</span>
                        )}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
            {/* Full-time ↔ Part-time separator */}
            {ovEmployees.full.length > 0 && ovEmployees.part.length > 0 && (
              <tr>
                <td colSpan={days.length + 1} style={{ padding: 0 }}>
                  <div style={{
                    height: 24,
                    background: '#fef3c7',
                    borderTop: '2px solid #f59e0b',
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 12,
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#92400e',
                  }}>
                    兼職
                  </div>
                </td>
              </tr>
            )}
            {/* Part-time employees (sorted by role then name) */}
            {ovEmployees.part.map(emp => (
              <tr key={emp.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{
                  position: 'sticky', left: 0,
                  background: emp.status === 'ACTIVE' || emp.status === undefined ? '#fafbfc' : '#fee2e2',
                  padding: '4px 8px', whiteSpace: 'nowrap', zIndex: 5,
                  fontWeight: 500, fontSize: 11,
                }}>{emp.user?.name ?? '?'}</td>
                {days.map((wd, dayIdx) => {
                  const empShiftsOnDay = ovShifts.filter(s =>
                    s.employeeId === emp.id &&
                    toHKDateStr(new Date(s.date)) === wd.dateStr
                  )
                  const empLeavesOnDay = leaveRequests.filter(lr =>
                    lr.employeeId === emp.id &&
                    leaveCoversDate(lr, wd.dateStr)
                  )
                  const hasShift = empShiftsOnDay.length > 0
                  const hasLeave = empLeavesOnDay.length > 0
                  return (
                    <td key={dayIdx}
                      className="overview-cell"
                      onPointerUp={() => handleOverviewDrop(emp.id, wd.dateStr)}
                      onPointerEnter={e => {
                        if (!draggingTemplate.current && !draggingLeave.current) return
                        ;(e.currentTarget as HTMLTableCellElement).style.background = '#ecfdf5'
                        ;(e.currentTarget as HTMLTableCellElement).style.outline = '2px dashed #10b981'
                        ;(e.currentTarget as HTMLTableCellElement).style.outlineOffset = '-2px'
                      }}
                      onPointerLeave={e => {
                        if (hasShift) return
                        if (hasLeave) {
                          ;(e.currentTarget as HTMLTableCellElement).style.background = '#4a4a4a10'
                        } else {
                          ;(e.currentTarget as HTMLTableCellElement).style.background = '#f0f0f0'
                        }
                        ;(e.currentTarget as HTMLTableCellElement).style.outline = ''
                        ;(e.currentTarget as HTMLTableCellElement).style.outlineOffset = ''
                      }}
                      style={{
                        padding: '2px 3px', textAlign: 'center',
                        cursor: hasShift ? 'pointer' : 'default',
                        background: hasShift ? '' : hasLeave ? '#4a4a4a10' : '#f0f0f0',
                        transition: 'background 0.15s',
                        verticalAlign: 'top',
                      }}
                      onMouseEnter={e => {
                        if (!hasShift && !hasLeave) (e.currentTarget as HTMLTableCellElement).style.background = '#e0e7ff'
                      }}
                      onMouseLeave={e => {
                        if (!hasShift && !hasLeave) (e.currentTarget as HTMLTableCellElement).style.background = '#f0f0f0'
                      }}
                      onClick={async () => {
                        if (justDroppedRef.current) return
                        // Touch mode: click cell to create shift with selected employee + template
                        if (isTouch && canManage && selectedEmployeeId && selectedTemplate && !hasShift && !hasLeave) {
                          const ok = await createShift(selectedEmployeeId, wd.dateStr, selectedTemplate)
                          if (ok) {
                            setValidationIssues([])
                            await refreshAll()
                          }
                          return
                        }
                        if (hasShift) jumpToEdit(empShiftsOnDay[0], wd.dateStr)
                      }}
                    >
                      <div className="overview-cell-inner">
                        {empShiftsOnDay.map((s, si) => {
                          const tpl = templates.find(t => t.id === s.templateId)
                          const clinic = clinics.find(c => c.id === s.clinicId)
                          const parts: string[] = []
                          if (labelParts.includes('clinic')) parts.push(clinic?.shortName || clinic?.name?.slice(0, 1) || '')
                          if (labelParts.includes('shift')) parts.push(tpl?.shortName || tpl?.name?.slice(0, 2) || fmtTime(s.startTime))
                          if (labelParts.includes('name')) parts.push(s.employee?.user?.name?.slice(0, 2) || '')
                          const shiftLabel = parts.filter(Boolean).join('·')
                          const shiftTitle = `${s.employee?.user?.name} ${clinic?.name ?? ''} ${tpl?.name ?? ''} ${fmtTime(s.startTime)}-${fmtTime(s.endTime)}`
                          return (
                            <div key={'s' + si} className="ov-capsule" title={shiftTitle} style={{
                              background: getShiftColor(s),
                              touchAction: 'none',
                              userSelect: 'none',
                            }}
                              onPointerDown={(e) => shiftDragOutStart(e, s.id, shiftLabel, () => Promise.resolve())}
                            >
                              {shiftLabel}
                            </div>
                          )
                        })}
                        {empLeavesOnDay.map((lr, li) => {
                          const leaveColor = lr.leaveType?.color ?? '#9ca3af'
                          const leaveLabel = `${lr.leaveType?.name}·${lr.employee?.user?.name?.slice(0, 2)}`
                          const leaveTitle = `${lr.employee?.user?.name} ${lr.leaveType?.name}`
                          return (
                            <div key={'l' + li} className="ov-capsule" title={leaveTitle}
                              style={{
                                background: (leaveColor || '#9ca3af') + '26',
                                color: '#1f2937',
                                borderLeft: `3px solid ${leaveColor}`,
                                touchAction: 'none',
                                userSelect: 'none',
                              }}
                              onPointerDown={(e) => leaveDragOutStart(e, lr.id, leaveLabel, () => Promise.resolve())}
                            >
                              {leaveLabel}
                            </div>
                          )
                        })}
                        {(!hasShift && !hasLeave) && (
                          <span style={{ fontSize: 10, color: '#999', fontWeight: 500 }}>R</span>
                        )}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {renderWeekStats(days)}
    </div>
  )

  // Factory: derive 7 days starting from a given Monday
  const makeWeekDays = useCallback((monday: Date) => {
    const dayNames = ['一', '二', '三', '四', '五', '六', '日']
    const list: { date: Date; label: string; dateStr: string }[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i) // tz-ok: client-side browser
      list.push({ date: d, label: `${dayNames[i]}${d.getDate()}`, dateStr: toHKDateStr(d) }) // tz-ok: client-side browser
    }
    return list
  }, [])

  // Get week days for overview grid
  const weekDays = useMemo(() => {
    if (!viewRange) return []
    const start = new Date(viewRange.start)
    const dayOfWeek = start.getDay()  // tz-ok: client-side browser
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const monday = new Date(start)
    monday.setDate(start.getDate() + mondayOffset)  // tz-ok: client-side browser
    return makeWeekDays(monday)
  }, [viewRange, makeWeekDays])

  // Next week days (for dual-week overview)
  const weekDays2 = useMemo(() => {
    if (weekDays.length === 0) return []
    const nextMonday = new Date(weekDays[0].date)
    nextMonday.setDate(nextMonday.getDate() + 7) // tz-ok: client-side browser
    return makeWeekDays(nextMonday)
  }, [weekDays, makeWeekDays])

  // Fix #1b: Orphan shift detection — shifts stored but not displayed in dual-week grid
  // Only check in week view; month view has different date range
  useEffect(() => {
    if (viewMode !== 'week') {
      setDisplayWarning(null)
      return
    }
    if (!shifts.length || !weekDays.length) return
    // Check against both weeks
    const allDateStrs = [...weekDays.map(wd => wd.dateStr), ...weekDays2.map(wd => wd.dateStr)]
    const orphans = shifts.filter(s => {
      const dateStr = formatDate(new Date(s.date))
      return !allDateStrs.includes(dateStr)
    })
    if (orphans.length > 0) {
      console.warn(`⚠️ ${orphans.length} 筆排班無法顯示（日期對不上）:`,
        orphans.map(s => ({ id: s.id, date: s.date, hkDate: formatDate(new Date(s.date)) })))
      setDisplayWarning(`有 ${orphans.length} 筆排班未顯示，可能是日期問題`)
    } else {
      setDisplayWarning(null)
    }
  }, [shifts, weekDays, weekDays2, viewMode])

  // Fix #1c: weekDays validation — must have 7 days, day 7 must be Sunday
  useEffect(() => {
    if (weekDays.length > 0) {
      console.assert(weekDays.length === 7, `weekDays 應有7天，實際${weekDays.length}天`)
      if (weekDays[6]) {
        const dayOfWeek = new Date(weekDays[6].dateStr).getDay()  // tz-ok: client-side browser
        console.assert(dayOfWeek === 0, `第7天應是週日，實際是週${dayOfWeek}`)
      }
    }
    if (weekDays2.length > 0) {
      console.assert(weekDays2.length === 7, `weekDays2 應有7天，實際${weekDays2.length}天`)
      if (weekDays2[6]) {
        const dayOfWeek = new Date(weekDays2[6].dateStr).getDay()  // tz-ok: client-side browser
        console.assert(dayOfWeek === 0, `第7天應是週日，實際是週${dayOfWeek}`)
      }
    }
  }, [weekDays, weekDays2])

  const allEmployees = useMemo(() => {
    return employees.filter(emp => emp.status === 'ACTIVE' || emp.status === undefined)
  }, [employees])

  // Clinic sidebar: count shifts per clinic this week
  const weekShiftCountByClinic = useMemo(() => {
    const counts: Record<string, number> = {}
    shifts.forEach(s => {
      const cid = s.clinicId
      if (cid) counts[cid] = (counts[cid] ?? 0) + 1
    })
    return counts
  }, [shifts])

  // ============================================================
  // Loading State
  // ============================================================
  if (loading) {
    return <div className="flex justify-center items-center py-12 text-muted-foreground">載入中...</div>
  }

  const selectedEmpName = selectedEmployeeId ? (clinicEmployees.find(e => e.id === selectedEmployeeId)?.user?.name || '') : ''
  const excludeEmployeeId = editingShift?.employeeId || ''
  const availableEmployees = clinicEmployees.filter((e: Employee) => e.id !== excludeEmployeeId)

  // ============================================================
  // Render
  // ============================================================
  // Sticky panel style —钉住三卡，內部自動捲動
  const stickyPanel: React.CSSProperties = {
    position: 'sticky',
    top: 12,
    alignSelf: 'flex-start',
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
  }

  return (
    <div className="w-full" style={{ maxWidth: '100%', padding: '0 16px' }}>
      {/* Overview capsule styles */}
      <style>{`
        .overview-table {
          table-layout: fixed;
          width: 100%;
        }
        .overview-cell {
          padding: 2px !important;
          vertical-align: top;
          overflow: hidden;
        }
        .overview-cell-inner {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-height: 0;
          height: auto;
        }
        .ov-capsule {
          flex: none;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 1px 2px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          min-height: 16px;
          line-height: 14px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          cursor: grab;
        }
        .ov-capsule[style*="borderLeft"] {
          color: inherit;
        }
        /* Compact mode — auto-fill grid, 16px capsules, 9px font for narrow cells */
        .ov-compact .overview-cell {
          padding: 1px !important;
        }
        .ov-compact .ov-capsule {
          font-size: 9px;
          min-height: 14px;
          line-height: 12px;
          padding: 1px 1px;
        }
        .ov-compact .overview-cell-inner {
          min-height: 0 !important;
          gap: 1px;
          display: grid !important;
          grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
        }
        .ov-compact .ov-capsule {
          min-height: 16px;
          padding: 0 4px;
          font-size: 11px;
        }
      `}</style>
      {/* Header */}
      <div className="flex justify-between items-center mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }} className="flex items-center gap-2"><Calendar size={24} /> 排班管理</h1>
          <p className="text-muted text-sm" style={{ margin: '4px 0 0 0' }}>
            {canManage ? '拖放排班 · 規則校驗 · 頂更/轉更' : '查看班表'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* View mode toggle removed — FC headerToolbar handles week/month switching */}

          {/* Shift rule settings button */}
          {canManage && (
            <button
              onClick={() => setShowRuleSettings(!showRuleSettings)}
              style={{
                padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6,
                background: showRuleSettings ? '#1a1a2e' : 'white',
                color: showRuleSettings ? 'white' : '#333',
                cursor: 'pointer', fontSize: 12,
              }}
            >
              <span className="flex items-center gap-1"><Settings size={16} /> 排班規則</span>
            </button>
          )}
        </div>
      </div>

      {/* Shift Rule Settings Panel */}
      {canManage && showRuleSettings && shiftRuleConfig && (
        <div className="card rounded-xl g border p-4 shadow-card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>
              {'⚙️ 排班校驗規則（' + (clinics.find(c => c.id === selectedClinicId)?.name || '') + '）'}
            </h2>
            <button onClick={() => setShowRuleSettings(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}><X size={18} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[
              { key: 'maxDailyHours', label: '單日工時上限', unit: '小時', enabledKey: 'maxDailyHoursEnabled', type: 'warning' },
              { key: 'maxConsecutiveHours', label: '連續工時上限', unit: '小時', enabledKey: 'maxConsecutiveEnabled', type: 'warning' },
              { key: 'minRestHours', label: '班次間最少休息', unit: '小時', enabledKey: 'minRestEnabled', type: 'warning' },
              { key: 'longShiftThreshold', label: '長班休息閾值', unit: '小時', enabledKey: 'longShiftEnabled', type: 'warning' },
            ].map(rule => (
              <div key={rule.key} style={{ padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{rule.label}</span>
                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: rule.type === 'error' ? '#fde8e8' : '#fff8e1', color: rule.type === 'error' ? '#dc3545' : '#856404' }}>
                    {rule.type === 'error' ? '硬擋' : '警示'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={(shiftRuleConfig as any)[rule.enabledKey] ?? true}
                      onChange={e => setShiftRuleConfig(prev => ({ ...prev, [rule.enabledKey as keyof ShiftRuleConfig]: e.target.checked }))}
                    />
                    啟用
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={(shiftRuleConfig as any)[rule.key]}
                    onChange={e => setShiftRuleConfig(prev => ({ ...prev, [rule.key as keyof ShiftRuleConfig]: parseFloat(e.target.value) || 0 }))}
                    style={{ width: 70, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
                  />
                  <span style={{ fontSize: 12, color: '#888' }}>{rule.unit}</span>
                </div>
              </div>
            ))}
            {/* Long shift break minutes */}
            <div style={{ padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>長班最少休息</span>
                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fff8e1', color: '#856404' }}>警示</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={shiftRuleConfig.longShiftEnabled}
                    onChange={e => setShiftRuleConfig(prev => ({ ...prev, longShiftEnabled: e.target.checked }))}
                  />
                  啟用
                </label>
                <input
                  type="number"
                  min={0}
                  step={5}
                  value={shiftRuleConfig.longShiftBreakMin}
                  onChange={e => setShiftRuleConfig(prev => ({ ...prev, longShiftBreakMin: parseInt(e.target.value) || 0 }))}
                  style={{ width: 70, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
                />
                <span style={{ fontSize: 12, color: '#888' }}>分鐘</span>
              </div>
            </div>
            {/* Overlap check - always error */}
            <div style={{ padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>撞更檢查</span>
                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fde8e8', color: '#dc3545' }}>硬擋</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={shiftRuleConfig.overlapCheck}
                    onChange={e => setShiftRuleConfig(prev => ({ ...prev, overlapCheck: e.target.checked }))}
                  />
                  啟用
                </label>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button
              onClick={() => shiftRuleConfig && saveShiftRuleConfig(shiftRuleConfig)}
              disabled={savingRules}
              style={{
                padding: '8px 20px', borderRadius: 6, border: 'none',
                background: savingRules ? '#ccc' : '#1a1a2e',
                color: 'white', cursor: savingRules ? 'not-allowed' : 'pointer',
                fontSize: 13, fontWeight: 500,
              }}
            >
              {savingRules ? '儲存中...' : '💾 儲存規則'}
            </button>
          </div>

          {/* Shift Template Management */}
          {userRole === 'OWNER' && (
            <div style={{ marginTop: 24, borderTop: '1px solid #eee', paddingTop: 16 }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: 15, fontWeight: 600 }} className="flex items-center gap-2"><ClipboardList size={16} /> 更次模版管理{currentCompanyName ? ` — ${currentCompanyName}` : ''}</h3>
              {templates.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, padding: '8px 12px', background: '#f9f9f9', borderRadius: 6 }}>
                  <span style={{ minWidth: 60, fontWeight: 500, fontSize: 13 }}>{t.name}</span>
                  {t.shortName && <span style={{ fontSize: 10, color: '#6b7280', background: '#f3f4f6', padding: '1px 5px', borderRadius: 4 }}>簡稱: {t.shortName}</span>}
                  <span style={{ fontSize: 12, color: '#888' }}>
                    {String(t.startHour).padStart(2, '0')}:{String(t.startMinute).padStart(2, '0')}
                    -{String(t.endHour).padStart(2, '0')}:{String(t.endMinute).padStart(2, '0')}
                    {t.isNightShift ? ' (夜更)' : ''}
                  </span>
                  {t.isDefault && <span style={{ fontSize: 10, color: '#1976d2', background: '#e3f2fd', padding: '1px 6px', borderRadius: 4 }}>預設</span>}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-sm"
                        style={{ background: '#e3f2fd', color: '#1976d2', border: '1px solid #bbdefb', fontSize: 11, padding: '2px 8px' }}
                        onClick={async () => {
                          const newName = prompt('修改更次名稱：', t.name)
                          if (newName === null) return
                          const newShort = prompt('修改簡稱（1-4字，總覽顯示，留空用名稱）：', t.shortName || '')
                          if (newShort === null) return
                          const newStart = prompt(`修改開始時間 (HH:mm)：`, `${String(t.startHour).padStart(2, '0')}:${String(t.startMinute).padStart(2, '0')}`)
                          if (newStart === null) return
                          const newEnd = prompt(`修改結束時間 (HH:mm)：`, `${String(t.endHour).padStart(2, '0')}:${String(t.endMinute).padStart(2, '0')}`)
                          if (newEnd === null) return
                          const [sh, sm] = newStart.split(':').map(Number)
                          const [eh, em] = newEnd.split(':').map(Number)
                          try {
                            const res = await fetch(`/api/shifts/templates/${t.id}`, {
                              method: 'PUT',
                              credentials: 'include',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                name: newName,
                                shortName: (newShort as string)?.trim() || null,
                                startHour: sh,
                                startMinute: sm,
                                endHour: eh,
                                endMinute: em,
                              }),
                            })
                            if (res.ok) {
                              await refreshAll()
                            } else {
                              const err = await res.json()
                              alert(err.error || '修改失敗')
                            }
                          } catch (e) { console.error('Edit template error:', e) }
                        }}
                      >編輯</button>
                      <button
                        className="btn btn-sm"
                        style={{ background: '#fde8e8', color: '#dc3545', border: '1px solid #f5c6cb', fontSize: 11, padding: '2px 8px' }}
                        onClick={async () => {
                          if (!confirm(`確定刪除「${t.name}」模版？`)) return
                          try {
                            const res = await fetch(`/api/shifts/templates/${t.id}`, { method: 'DELETE', credentials: 'include' })
                            if (res.ok) {
                              await refreshAll()
                            } else {
                              const err = await res.json()
                              alert(err.error || '刪除失敗')
                            }
                          } catch (e) { console.error('Delete template error:', e) }
                        }}
                      >刪除</button>
                    </div>
                </div>
              ))}
              {/* Add new template */}
              <NewShiftTemplateForm
                onCreated={async (tpl) => {
                  try {
                    const res = await fetch('/api/shifts/templates', {
                      method: 'POST',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ ...tpl, companyId: currentCompanyId }),
                    })
                    if (res.ok) {
                      await refreshAll()
                    } else {
                      const err = await res.json()
                      alert(err.error || '新增失敗')
                    }
                  } catch (e) { console.error('Create template error:', e) }
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Validation Issues */}
      {validationIssues.length > 0 && (
        <div style={{
          padding: '12px 16px', marginBottom: 16,
          background: validationIssues.some(i => i.type === 'error') ? '#fde8e8' : '#fff8e1',
          border: `1px solid ${validationIssues.some(i => i.type === 'error') ? '#f5c6cb' : '#ffe082'}`,
          borderRadius: 8,
        }}>
          {validationIssues.map((issue, i) => (
            <div key={i} style={{
              color: issue.type === 'error' ? '#721c24' : '#856404',
              fontSize: 13, marginBottom: issue.type === 'error' && i < validationIssues.length - 1 ? 4 : 0,
            }}>
              {issue.type === 'error' ? '❌' : '⚠️'} {issue.message}
            </div>
          ))}
          <button
            onClick={() => setValidationIssues([])}
            style={{
              marginTop: 8, background: 'none', border: 'none',
              color: '#888', cursor: 'pointer', fontSize: 12,
            }}
          >
            清除提示
          </button>
        </div>
      )}

      {/* Orphan Shift Warning (Fix #1b) — desktop only */}
      {displayWarning && (
        <div className="hidden md:block" style={{
          padding: '8px 12px', marginBottom: 16, borderRadius: 6,
          background: '#fff3cd', border: '1px solid #ffc107', fontSize: 13, color: '#856404'
        }}>
          ⚠️ {displayWarning}
        </div>
      )}



      {/* ============================================================ */}
      {/* GLOBAL OVERVIEW GRID — integrated into 4-column layout below */}
      {/* (moved into the right column; removed standalone block) */}
      {/* ============================================================ */}

      {/* 🗑 Ghost capsule: follows cursor, turns red when outside */}
      {shiftGhost && (
        <div className="fixed z-50 pointer-events-none px-2 py-1 rounded text-xs font-semibold shadow-lg"
          style={{
            left: shiftGhost.x + 10,
            top: shiftGhost.y + 10,
            background: shiftGhost.outside ? '#dc2626' : '#334155',
            color: '#fff',
          }}>
          {shiftGhost.outside ? '🗑 放開刪除' : shiftGhost.label}
        </div>
      )}
      {leaveGhost && (
        <div className="fixed z-50 pointer-events-none px-2 py-1 rounded text-xs font-semibold shadow-lg"
          style={{
            left: leaveGhost.x + 10,
            top: leaveGhost.y + 10,
            background: leaveGhost.outside ? '#dc2626' : '#334155',
            color: '#fff',
          }}>
          {leaveGhost.outside ? '🗑 放開刪除' : leaveGhost.label}
        </div>
      )}

      {/* 🔧 Undo Toast */}
      {undoToast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm shadow-lg">
          {undoToast.label}
          <button className="underline font-semibold" onClick={async () => {
            await undoToast.restore()
            setUndoToast(null)
            if (undoTimer.current) clearTimeout(undoTimer.current)
          }}>
            復原
          </button>
        </div>
      )}


      {/* Mobile: Read-only day view + week overview */}
      <div className="md:hidden px-4" style={{ marginTop: 12 }}>
        <p className="text-xs text-muted-foreground mb-3 text-center bg-amber-50 rounded-lg p-2 border border-amber-200">
          📱 手機為唯讀檢視，排班請用電腦
        </p>

        {/* Tab switch: Day / Week */}
        <div className="flex gap-1 mb-2">
          <button onClick={() => setMobileView('day')}
            className={`flex-1 py-1.5 text-sm rounded ${mobileView === 'day' ? 'bg-brand text-white' : 'bg-muted'}`}>
            單日
          </button>
          <button onClick={() => setMobileView('week')}
            className={`flex-1 py-1.5 text-sm rounded ${mobileView === 'week' ? 'bg-brand text-white' : 'bg-muted'}`}>
            一週總覽
          </button>
        </div>

        {/* ── Day View (existing content) ── */}
        {mobileView === 'day' && (
          <>
        {/* Monthly work hours bar */}
        {monthlyWorkHours.length > 0 && (
          <div className="mb-3 rounded-lg border bg-card px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-semibold">
                📊 工時 {(() => { const a = viewRange ? new Date(viewRange.start) : new Date(); return `${a.getFullYear()}年${a.getMonth() + 1}月` })()}
              </span>
              <span className="text-xs text-muted-foreground">{currentCompanyName || selectedClinicId ? (clinics.find(c => c.id === selectedClinicId)?.name || '') : ''}</span>
            </div>
            {/* 本月 */}
            <div className="mb-1">
              <span className="text-xs text-muted-foreground mr-2">本月</span>
              <span className="inline-flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
                {monthlyWorkHours.map(e => (
                  <span key={e.id}>{e.name} <span className="font-medium">{e.month}h</span></span>
                ))}
              </span>
            </div>
            {/* 當週 */}
            <div className="pt-1 border-t">
              <span className="text-xs text-muted-foreground mr-2">{(() => { const a = viewRange ? new Date(viewRange.start) : new Date(); const e = new Date(a); e.setDate(a.getDate() + 6); return `當週(${toHKDateStr(a).slice(5)}–${toHKDateStr(e).slice(5)})` })()}</span>
              <span className="inline-flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
                {monthlyWorkHours.map(e => (
                  <span key={e.id} className={e.week > 45 ? 'text-red-600 font-semibold' : ''}>
                    {e.week > 45 && '🔴 '}{e.name} <span className="font-medium">{e.week}h</span>
                  </span>
                ))}
              </span>
            </div>
          </div>
        )}

        {/* Clinic selector */}
        <div className="mb-3">
          <select className="w-full rounded-lg border px-3 py-2 text-sm"
            value={selectedClinicId || ''}
            onChange={e => setSelectedClinicId(e.target.value || null)}>
            <option value="">選擇診所</option>
            {clinics.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {/* Week navigation */}
        <div className="flex items-center justify-between mb-2 px-1">
          <button onClick={() => shiftMobileWeek(-7)}
            className="w-9 h-9 flex items-center justify-center rounded-lg border text-lg active:bg-muted">
            ‹
          </button>
          <span className="text-sm font-semibold">
            {(() => {
              const d = new Date(mobileSelectedDate)
              return `${d.getFullYear()}年${d.getMonth() + 1}月`
            })()}
          </span>
          <button onClick={() => shiftMobileWeek(7)}
            className="w-9 h-9 flex items-center justify-center rounded-lg border text-lg active:bg-muted">
            ›
          </button>
        </div>

        {/* Date bar */}
        <div className="flex gap-1 overflow-x-auto pb-2 mb-3" style={{ scrollbarWidth: 'none' }}>
          {mobileWeekDays.map((d) => {
            const isToday = d === toHKDateStr(todayHK())
            const isSelected = d === mobileSelectedDate
            const parts = d.split('-')
            const dayOfWeek = ['日','一','二','三','四','五','六'][new Date(d).getDay()]
            return (
              <button key={d} onClick={() => setMobileSelectedDate(d)}
                className="flex-shrink-0 flex flex-col items-center justify-center rounded-lg border px-3 py-2 text-xs transition-all"
                style={{
                  minWidth: 48,
                  background: isSelected ? '#3b82f6' : isToday ? '#eff6ff' : '#fff',
                  color: isSelected ? '#fff' : isToday ? '#3b82f6' : '#333',
                  borderColor: isSelected ? '#3b82f6' : isToday ? '#93c5fd' : '#e5e7eb',
                  fontWeight: isSelected || isToday ? 600 : 400,
                }}>
                <span>{dayOfWeek}</span>
                <span className="text-base font-bold">{parseInt(parts[2])}</span>
              </button>
            )
          })}
        </div>

        {/* Shift cards for selected date */}
        {(() => {
          const dayShifts = clinicFilteredShifts.filter(s => toHKDateStr(new Date(s.date)) === mobileSelectedDate)
          const dayLeaves = leaveRequests.filter(lr => {
            const lrStart = toHKDateStr(new Date(lr.startDate))
            const lrEnd = toHKDateStr(new Date(lr.endDate))
            return mobileSelectedDate >= lrStart && mobileSelectedDate <= lrEnd
          })
          const hasClinic = !!selectedClinicId
          return (
            <div className="space-y-2">
              {!hasClinic ? (
                <div className="text-center py-8 text-sm text-muted-foreground">請選擇診所</div>
              ) : dayShifts.length === 0 && dayLeaves.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">該日無排班</div>
              ) : (
                <>
                  {dayShifts.map(s => (
                    <div key={s.id} className="rounded-xl border shadow-card p-3">
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-semibold text-sm">{s.employee?.user?.name || s.employeeId}</span>
                        <span className="text-xs text-muted-foreground">{fmtTime(s.startTime)} - {fmtTime(s.endTime)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">{s.template?.shortName || s.template?.name || s.role || '一般'}</span>
                        <span className="text-xs px-2 py-0.5 rounded" style={{
                          background: s.hasPunch ? '#d1fae5' : '#f3f4f6',
                          color: s.hasPunch ? '#065f46' : '#6b7280'
                        }}>
                          {s.hasPunch ? '已打卡' : '待打卡'}
                        </span>
                      </div>
                    </div>
                  ))}
                  {dayLeaves.map(lr => {
                    const leaveTypeMap = { ANNUAL: '年假', SICK: '病假', HALF_SICK: '半日病假', UNPAID: '無薪假', SPECIAL: '特假' }
                    const empName = clinicEmployees.find(e => e.id === lr.employeeId)?.user?.name || '未知'
                    return (
                      <div key={lr.id} className="rounded-xl border shadow-card p-3" style={{ background: '#fefce8' }}>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-semibold text-sm">{empName}</span>
                          <span className="text-xs text-muted-foreground">{lr.startDate} ~ {lr.endDate}</span>
                        </div>
                        <div className="text-xs" style={{ color: '#92400e' }}>
                          🏖 {leaveTypeMap[lr.leaveType as keyof typeof leaveTypeMap] || lr.leaveType}
                        </div>
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          )
        })()}
          </>
        )}

        {/* ── Week Overview Grid (new) ── */}
        {mobileView === 'week' && (
          <div className="px-1">
            {/* Scope selector: all / company / clinic */}
            <div className="flex gap-2 mb-2">
              <select value={ovScope.type === 'all' ? 'all' : `${ovScope.type}:${ovScope.id}`}
                onChange={e => {
                  const v = e.target.value
                  if (v === 'all') setOvScope({ type: 'all' })
                  else {
                    const [t, id] = v.split(':')
                    const found = t === 'company' ? companies.find(c => c.id === id) : clinics.find(c => c.id === id)
                    setOvScope({ type: t as any, id, name: found?.name ?? '' })
                  }
                }}
                className="flex-1 text-xs rounded border px-2 py-1.5">
                <option value="all">所有診所</option>
                {companies.length > 0 && (
                  <optgroup label="公司">
                    {companies.map(co => <option key={co.id} value={`company:${co.id}`}>{co.name}</option>)}
                  </optgroup>
                )}
                <optgroup label="診所">
                  {clinics.map(c => <option key={c.id} value={`clinic:${c.id}`}>{c.name}</option>)}
                </optgroup>
              </select>
            </div>

            {/* Week navigation */}
            <div className="flex items-center justify-between mb-2">
              <button onClick={() => shiftMobileWeek(-7)} className="w-8 h-8 rounded border">‹</button>
              <span className="text-sm font-semibold">{mobileWeekLabel}</span>
              <button onClick={() => shiftMobileWeek(7)} className="w-8 h-8 rounded border">›</button>
            </div>

            {/* Week grid (click to fullscreen) */}
            <div onClick={() => setFullscreenOverview(true)} className="cursor-pointer">
              <table className="w-full text-[10px]" style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th className="text-left w-14 sticky left-0 bg-white">員工</th>
                    {mobileWeekDays.map(d => (
                      <th key={d} className="text-center px-0.5">
                        {['一', '二', '三', '四', '五', '六', '日'][new Date(d).getDay() === 0 ? 6 : new Date(d).getDay() - 1]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ovEmployees.ordered.map((emp: any) => (
                    <tr key={emp.id} className="border-t">
                      <td className="text-left truncate sticky left-0 bg-white">{emp.user?.name ?? '?'}</td>
                      {mobileWeekDays.map(d => {
                        const cell = getMobileCell(emp.id, d)
                        return <td key={d} className="text-center px-0" style={{ background: cell.bg, fontSize: 9 }}>{cell.label}</td>
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-center text-[10px] text-muted-foreground mt-1">點擊放大 · 手機為唯讀檢視</div>
          </div>
        )}
      </div>

      {/* ── Fullscreen Week Overview Overlay ── */}
      {fullscreenOverview && (
        <div className="fixed inset-0 z-[100] bg-white overflow-auto md:hidden"
          onClick={() => setFullscreenOverview(false)}>
          <div className="sticky top-0 bg-white border-b px-3 py-2 flex justify-between items-center">
            <span className="font-semibold text-sm">
              {ovScope.type === 'all' ? '所有診所' : ovScope.name} · {mobileWeekLabel}
            </span>
            <button className="text-lg" onClick={() => setFullscreenOverview(false)}>✕</button>
          </div>
          <div className="overflow-x-auto p-2" style={{ display: 'flex', justifyContent: 'center' }}>
            <table className="text-xs" style={{ width: '100%', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '12%' }} />
                {mobileWeekDays.map((d, i) => <col key={i} style={{ width: `${88 / mobileWeekDays.length}%` }} />)}
              </colgroup>
              <thead>
                <tr>
                  <th className="text-left w-20 sticky left-0 bg-white">員工</th>
                  {mobileWeekDays.map(d => (
                    <th key={d} className="text-center px-1">
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ovEmployees.ordered.map((emp: any) => (
                  <tr key={emp.id} className="border-t">
                    <td className="text-left sticky left-0 bg-white">{emp.user?.name ?? '?'}</td>
                    {mobileWeekDays.map(d => {
                      const cell = getMobileCell(emp.id, d)
                      return <td key={d} className="text-center px-1 py-1 min-w-[80px]"
                        style={{ background: cell.bg, fontSize: 12 }}>{cell.detail ?? cell.label}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MAIN LAYOUT: Clinic Sidebar | Employees | Templates+Leave | Content */}
      {/* ============================================================ */}

      {/* Desktop: Monthly work hours bar + Full scheduling interface */}
      <div className="hidden md:block">
        {monthlyWorkHours.length > 0 && (
          <div className="mb-3 rounded-lg border bg-card px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-semibold">
              📊 工時 {(() => { const a = viewRange ? new Date(viewRange.start) : new Date(); return `${a.getFullYear()}年${a.getMonth() + 1}月` })()}
            </span>
            <span className="text-xs text-muted-foreground">{currentCompanyName || selectedClinicId ? (clinics.find(c => c.id === selectedClinicId)?.name || '') : ''}</span>
          </div>
          {/* 本月 */}
          <div className="mb-1">
            <span className="text-xs text-muted-foreground mr-2">本月</span>
            <span className="inline-flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
              {monthlyWorkHours.map(e => (
                <span key={e.id}>{e.name} <span className="font-medium">{e.month}h</span></span>
              ))}
            </span>
          </div>
          {/* 當週 */}
          <div className="pt-1 border-t">
            <span className="text-xs text-muted-foreground mr-2">{(() => { const a = viewRange ? new Date(viewRange.start) : new Date(); const e = new Date(a); e.setDate(a.getDate() + 6); return `當週(${toHKDateStr(a).slice(5)}–${toHKDateStr(e).slice(5)})` })()}</span>
            <span className="inline-flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
              {monthlyWorkHours.map(e => (
                <span key={e.id} className={e.week > 45 ? 'text-red-600 font-semibold' : ''}>
                  {e.week > 45 && '🔴 '}{e.name} <span className="font-medium">{e.week}h</span>
                </span>
              ))}
            </span>
          </div>
        </div>
      )}

        {/* Desktop: Full scheduling interface */}
        <div className="flex" style={{
        gap: 12,
        alignItems: 'start',
      }}>

        {/* LEFTMOST: Clinic Sidebar grouped by Company */}
        <div style={{
          ...stickyPanel,
          width: '130px',
          flexShrink: 0,
          borderRight: '1px solid #e5e7eb',
          paddingRight: 8,
          background: '#fafbfc',
          borderRadius: 8,
          border: '1px solid #e5e7eb',
          padding: 8,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6, textAlign: 'center' }}>
            店舖
          </div>
          {companyGroups.map(g => (
            <div key={g.companyId} style={{ marginBottom: 8 }}>
              <div
                style={{
                  fontSize: 11, fontWeight: 700, textAlign: 'center', padding: '3px 4px',
                  borderBottom: '1px solid #ddd', marginBottom: 4, cursor: 'pointer',
                  borderRadius: 4,
                }}
                onClick={() => setOvScope({ type: 'company', id: g.companyId, name: g.name })}
                title="點擊切總覽範圍到這家公司"
              >
                {g.name}
              </div>
              {g.clinics.map(c => (
                <button
                  key={c.id}
                  onClick={() => { setSelectedClinicId(c.id); setOvScope({ type: 'clinic', id: c.id, name: c.name }) }}
                  style={{
                    width: '100%', textAlign: 'left', padding: '5px 6px', marginBottom: 2,
                    borderRadius: 4, fontSize: 11, cursor: 'pointer',
                    border: selectedClinicId === c.id ? '2px solid #1a1a2e' : '1px solid transparent',
                    background: selectedClinicId === c.id ? '#1a1a2e' : '#f0f0f0',
                    color: selectedClinicId === c.id ? '#fff' : '#333',
                    fontWeight: selectedClinicId === c.id ? 600 : 400,
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ fontSize: 11 }}>{c.name}</div>
                  <div style={{ fontSize: 10, opacity: 0.7, marginTop: 1 }}>
                    本週 {weekShiftCountByClinic[c.id] ?? 0} 更
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* COLUMN 2: Employees split by pay type */}
        <div style={{
          ...stickyPanel,
          background: '#fafbfc',
          borderRadius: 8,
          border: '1px solid #e5e7eb',
          padding: 8,
        }}>
          {/* Employee scope toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>員工</span>
            <div style={{ display: 'flex', borderRadius: 4, border: '1px solid #d1d5db', overflow: 'hidden' }}>
              {(['clinic', 'all'] as const).map(scope => (
                <button key={scope} onClick={() => setEmpScope(scope)}
                  style={{
                    fontSize: 10, padding: '2px 8px', border: 'none', cursor: 'pointer',
                    background: empScope === scope ? '#3b82f6' : '#fff',
                    color: empScope === scope ? '#fff' : '#374151',
                    fontWeight: empScope === scope ? 600 : 400,
                    transition: 'all 0.15s',
                  }}>
                  {scope === 'clinic' ? '本店' : '全部'}
                </button>
              ))}
            </div>
          </div>
          {/* Full-time + Part-time — single container for Draggable callback ref */}
          <div ref={attachEmployeePanel}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 4, textAlign: 'center' }}>
              全職
            </div>
            {fullTimeEmps.map(emp => (
              <div
                key={emp.id}
                className="employee-card"
                data-employee-id={emp.id}
                data-name={emp.user?.name ?? ''}
                onClick={() => setSelectedEmployeeId(prev => prev === emp.id ? '' : emp.id)}
                draggable={canManage && !isTouch}
                onDragStart={(e) => {
                  if (canManage && !isTouch) {
                    e.dataTransfer.setData('text/plain', emp.id)
                    setSelectedEmployeeId(emp.id)
                  }
                }}
                style={{
                  padding: '5px 4px',
                  marginBottom: 4,
                  borderRadius: 6,
                  fontSize: 11,
                  textAlign: 'center',
                  cursor: canManage ? 'grab' : 'pointer',
                  background: selectedEmployeeId === emp.id ? '#fff' : colorFor(emp.id),
                  color: selectedEmployeeId === emp.id ? '#333' : '#fff',
                  border: selectedEmployeeId === emp.id ? `2px solid ${colorFor(emp.id)}` : '2px solid transparent',
                  outline: isTouch && selectedEmployeeId === emp.id ? '2px solid #fbbf24' : 'none',
                  outlineOffset: isTouch && selectedEmployeeId === emp.id ? '2px' : undefined,
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  userSelect: 'none',
                }}
                title={emp.user?.name ?? ''}
              >
                {emp.user?.name ?? '?'}
              </div>
            ))}

            {/* Part-time */}
            {partTimeEmps.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 4, textAlign: 'center', marginTop: 8 }}>
                  兼職
                </div>
                {partTimeEmps.map(emp => (
                  <div
                    key={emp.id}
                    className="employee-card"
                    data-employee-id={emp.id}
                    data-name={emp.user?.name ?? ''}
                    onClick={() => setSelectedEmployeeId(prev => prev === emp.id ? '' : emp.id)}
                    draggable={canManage && !isTouch}
                    onDragStart={(e) => {
                      if (canManage && !isTouch) {
                        e.dataTransfer.setData('text/plain', emp.id)
                        setSelectedEmployeeId(emp.id)
                      }
                    }}
                    style={{
                      padding: '5px 4px',
                      marginBottom: 4,
                      borderRadius: 6,
                      fontSize: 11,
                      textAlign: 'center',
                      cursor: canManage ? 'grab' : 'pointer',
                      background: selectedEmployeeId === emp.id ? '#fff' : colorFor(emp.id),
                      color: selectedEmployeeId === emp.id ? '#333' : '#fff',
                      border: selectedEmployeeId === emp.id ? `2px solid ${colorFor(emp.id)}` : '2px solid transparent',
                      outline: isTouch && selectedEmployeeId === emp.id ? '2px solid #fbbf24' : 'none',
                      outlineOffset: isTouch && selectedEmployeeId === emp.id ? '2px' : undefined,
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      userSelect: 'none',
                    }}
                    title={emp.user?.name ?? ''}
                  >
                    {emp.user?.name ?? '?'}
                  </div>
                ))}
              </>
            )}
          </div>
          {/* Clear weekly shifts + leave button */}
          {selectedEmployeeId && canManage && (
            <button
              onClick={async () => {
                if (!confirm('確定清空當週排班？')) return
                const { startDate, endDate } = getDateRange()
                // 清排班
                const weekShifts = shifts.filter(s => {
                  const shiftDateStr = toHKDateStr(new Date(s.date))
                  return s.employeeId === selectedEmployeeId &&
                    shiftDateStr >= startDate &&
                    shiftDateStr <= endDate
                })
                // 清假期
                const weekLeaves = leaveRequests.filter(lr => {
                  const lrStart = toHKDateStr(new Date(lr.startDate))
                  const lrEnd = lr.endDate ? toHKDateStr(new Date(lr.endDate)) : lrStart
                  return lr.employeeId === selectedEmployeeId &&
                    lrStart >= startDate &&
                    lrEnd <= endDate
                })
                if (weekShifts.length === 0 && weekLeaves.length === 0) {
                  alert('該員工當週沒有排班及假期')
                  return
                }
                for (const shift of weekShifts) {
                  await fetch('/api/shifts/' + shift.id, {
                    method: 'DELETE',
                    credentials: 'include',
                  })
                }
                for (const l of weekLeaves) {
                  await fetch('/api/leave-requests/' + l.id, {
                    method: 'DELETE',
                    credentials: 'include',
                  })
                }
                await refreshAll()
                await refreshLeaveBalances()
              }}
              style={{
                background: '#fde8e8', color: '#dc3545', border: '1px solid #f5c6cb',
                borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
                fontSize: 12, padding: '2px 8px',
              }}
            >
              清空當週排班
            </button>
          )}
        </div>

        {/* MIDDLE COLUMN: Templates + Leave */}
        <div style={{
          ...stickyPanel,
          background: '#fafbfc',
          borderRadius: 8,
          border: '1px solid #e5e7eb',
          padding: 8,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
            更次
          </div>
          <div ref={attachTemplatePanel}>
            {templates.map(t => (
              <div
                key={t.id}
                className="template-card"
                data-template-id={t.id}
                data-name={t.name}
                onPointerDown={() => {
                  if (!isTouch) draggingTemplate.current = { templateId: t.id, employeeId: selectedEmployeeId }
                }}
                onClick={() => setSelectedTemplate(t)}
                style={{
                  padding: '6px 4px', margin: '3px 0', borderRadius: 6,
                  cursor: canManage ? 'grab' : 'pointer',
                  background: selectedTemplate?.id === t.id ? '#1a1a2e' : '#378add',
                  color: '#fff',
                  fontSize: 11,
                  textAlign: 'center',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  userSelect: 'none',
                  outline: selectedTemplate?.id === t.id && isTouch ? '2px solid #fbbf24' : 'none',
                  outlineOffset: selectedTemplate?.id === t.id && isTouch ? '2px' : undefined,
                }}
                title={`${t.name} ${String(t.startHour).padStart(2,'0')}:${String(t.startMinute).padStart(2,'0')}-${String(t.endHour).padStart(2,'0')}:${String(t.endMinute).padStart(2,'0')}`}
              >
                {t.name}
              </div>
            ))}
          </div>

          {/* Touch mode hint */}
          {isTouch && canManage && (
            <div style={{
              marginTop: 8, padding: '4px 8px', borderRadius: 6,
              background: '#fef3c7', border: '1px solid #fde68a',
              fontSize: 10, color: '#92400e', lineHeight: 1.4,
            }}>
              📱 點選模式：先點左側員工 → 點更次 → 點總覽或日曆格子排班
              {(selectedEmployeeId || selectedTemplate) && (
                <div style={{ marginTop: 3 }}>
                  <span style={{ color: '#166534' }}>
                    {selectedEmployeeId ? `✅ ${(clinicEmployees.find(e => e.id === selectedEmployeeId)?.user?.name || '未知員工')}` : '⬜ 員工'}
                    {' + '}
                    {selectedTemplate ? `✅ ${selectedTemplate.name}` : '⬜ 更次'}
                  </span>
                  <button
                    onClick={() => { setSelectedEmployeeId(''); setSelectedTemplate(null) }}
                    style={{ marginLeft: 6, fontSize: 10, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                  >取消選取</button>
                </div>
              )}
            </div>
          )}

          {/* Leave types — container always exists so ref is never null */}
          <div ref={attachLeavePanel} style={{ marginTop: 10 }}>
            {leaveTypes.length > 0 && (
              <>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
                假期
              </div>
              {leaveTypes.map(lt => {
                const bal = selectedEmpBalances.find(b => b.leaveTypeId === lt.id)
                const remaining = bal?.remaining ?? 0
                // 🔧 Fix #2a: 無限類型永遠可拖
                const isUnlimited = lt.quantity == null && !lt.systemKey
                // 🔧 REST_DAY 豁免：剩 0 仍可拖（server ensure 補血）
                const isRestDay = lt.systemKey === 'REST_DAY'
                // ★ 未選員工時可拖（drop 時彈選人 modal + 驗餘額）
                const canDragLeave = canManage && (!selectedEmployeeId || isUnlimited || isRestDay || remaining > 0)
                return (
                  <div
                    key={lt.id}
                    className={canDragLeave ? 'leave-card' : 'leave-card-disabled'}
                    data-leave-id={lt.id}
                    data-name={lt.name}
                    onPointerDown={() => {
                      draggingLeave.current = { leaveTypeId: lt.id, employeeId: selectedEmployeeId }
                      // 不加 e.stopPropagation() ——FC Draggable 委託需要事件冒泡
                    }}
                    style={{
                      padding: '6px 4px', margin: '3px 0',
                      background: canDragLeave ? '#4a4a4a' : '#3a3a3a',
                      color: canDragLeave ? '#fff' : '#888',
                      borderRadius: 6,
                      cursor: canDragLeave ? 'grab' : 'not-allowed',
                      opacity: canDragLeave ? 1 : 0.4,
                      fontSize: 11, textAlign: 'center',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      userSelect: 'none',
                    }}
                    title={canDragLeave ? `拖到日曆建立請假 - ${lt.name}` : '無餘額，無法拖放'}
                  >
                    <Palmtree size={11} style={{ marginRight: 2, verticalAlign: 'middle' }} /> {lt.name}
                    <span style={{ fontSize: 10, fontWeight: 600 }}>{isUnlimited ? '（無限）' : selectedEmployeeId ? `（剩 ${remaining.toFixed(1)} 天）` : ''}</span>
                    {!canDragLeave && !isUnlimited && !isRestDay && remaining <= 0 && <span style={{ fontSize: 9, color: '#dc2626' }}> 無餘額</span>}
                  </div>
                )
              })}
              </>
            )}
          </div>

          {/* Week navigation buttons */}
          <div className="flex gap-2 mt-2">
            <button onClick={() => shiftViewWeek(-7)}
              className="flex-1 rounded-lg border py-1.5 text-sm hover:bg-muted">
              ‹ 上週
            </button>
            <button onClick={() => shiftViewWeek(7)}
              className="flex-1 rounded-lg border py-1.5 text-sm hover:bg-muted">
              下週 ›
            </button>
          </div>
        </div>
        <div id="fc-section" style={{ minWidth: 0, flex: 1 }}>
          {/* Overview Grid — compact mode, always shown */}
          {viewMode === 'week' && viewRange && ovEmployees.ordered.length > 0 && (
            <div ref={overviewRef} className="ov-compact" style={{
              marginBottom: 12,
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              overflowX: 'auto',
              background: '#fafbfc',
            }}>
              {/* Shared header: scope + capsule settings */}
              <div style={{ padding: '6px 10px', borderBottom: '1px solid #e5e7eb', fontSize: 12, fontWeight: 600, color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="flex items-center gap-3">
                  <span>📊 全局總覽（{ovScope.type === 'all' ? '所有診所' : ovScope.name}）</span>
                  {ovScope.type !== 'all' && (
                    <button onClick={() => setOvScope({ type: 'all' })}
                      style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }}>
                      全部
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11, fontWeight: 400, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>膠囊顯示：</span>
                  {([['clinic','店鋪'],['shift','更次'],['name','姓名']] as const).map(([k, label]) => (
                    <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, cursor: 'pointer' }}>
                      <input type="checkbox" checked={labelParts.includes(k)} onChange={() => toggleLabelPart(k)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              {/* Two weeks rendered via renderOverviewWeek */}
              {renderOverviewWeek(weekDays, '本週')}
              {renderOverviewWeek(weekDays2, '下週')}
            </div>
          )}

          {/* Calendar toggle + clinic info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <button
              onClick={toggleCalendar}
              style={{
                padding: '5px 12px', borderRadius: 6, border: '1px solid #ddd',
                background: showCalendar ? '#1a1a2e' : '#f5f5f5',
                color: showCalendar ? '#fff' : '#333', fontSize: 12, cursor: 'pointer',
                fontWeight: 500, transition: 'all 0.15s',
              }}
            >
              {showCalendar ? '📅 隱藏日曆' : '📅 顯示日曆'}
            </button>
            {showCalendar && canManage && (
              <span style={{ fontSize: 11, color: '#aaa' }}>拖更次/員工到日曆為 {clinics.find(c => c.id === selectedClinicId)?.name || '此店'} 排班</span>
            )}
          </div>

          {/* Employee stats + Calendar (conditional) */}
          {showCalendar && (
            <>
            <div className="card rounded-xl g border p-4 shadow-card">
          <div ref={calendarContainerRef}>

            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView={viewMode === 'week' ? 'timeGridWeek' : 'dayGridMonth'}
              locale={zhcn}
              headerToolbar={{
                left: 'prev,next',
                center: '',
                right: 'timeGridWeek,dayGridMonth',
              }}
              datesSet={(dateInfo) => {
                // Sync viewMode from FC view type
                const viewType = dateInfo.view.type
                if (viewType === 'timeGridWeek') {
                  setViewMode('week')
                } else if (viewType === 'dayGridMonth') {
                  setViewMode('month')
                }
                // Sync currentDate to FC midpoint
                const mid = new Date((dateInfo.start.getTime() + dateInfo.end.getTime()) / 2)
                const hkMid = toHKDateStr(mid)
                const hkCurrent = toHKDateStr(currentDate)
                if (hkMid !== hkCurrent) {
                  setCurrentDate(mid)
                }
                // Set visible range for loadShifts
                const range = {
                  start: toHKDateStr(dateInfo.start),
                  end: toHKDateStr(new Date(dateInfo.end.getTime() - 86400000)),
                }
                if (range.start !== viewRange?.start || range.end !== viewRange?.end) {
                  setViewRange(range)
                }
              }}
              events={fcEvents}
              droppable={canManage && !isTouch}
              eventReceive={async (info) => {
                console.log('🔬E: eventReceive fired', info.event.extendedProps)
                info.event.remove()
                const props = info.event.extendedProps
                const date = toHKDateStr(info.event.start!)

                if (props.dragType === 'leave') {
                  const leaveTypeId = props.leaveTypeId
                  if (!leaveTypeId) {
                    setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 假期類型無效' }])
                    return
                  }

                  if (!selectedEmployeeId) {
                    setShowLeaveEmployeeModal({ date, leaveTypeId })
                    return
                  }

                  // 🔧 Fix #3c: 拖放時再次檢查餘額（無限類型跳過）
                  const lt = leaveTypes.find(l => l.id === leaveTypeId)
                  const isUnlimited = lt && lt.quantity == null && !lt.systemKey
                  const bal = selectedEmpBalances.find(b => b.leaveTypeId === leaveTypeId)
                  if (!isUnlimited && (!bal || bal.remaining <= 0)) {
                    setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 此假期餘額不足，無法安排' }])
                    return
                  }

                  const hasShiftOnDate = shifts.some(s =>
                    s.employeeId === selectedEmployeeId &&
                    toHKDateStr(new Date(s.date)) === date
                  )
                  if (hasShiftOnDate) {
                    setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 該員工該天已有排班，無法設置假期' }])
                    return
                  }

                  try {
                    const res = await fetch('/api/leave-requests', {
                      method: 'POST',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        leaveTypeId,
                        employeeId: selectedEmployeeId,
                        startDate: date,
                        endDate: date,
                        days: 1,
                        reason: `排班頁拖曳請假`,
                        isPlanned: true,
                        clinicId: selectedClinicId,
                      }),
                    })
                    if (res.ok) {
                      setValidationIssues([])
                      await refreshLeaveBalances()
                    } else {
                      const err = await res.json()
                      setValidationIssues([{ type: 'error', rule: 'leave', message: err.error || '建立請假失敗' }])
                    }
                  } catch {
                    setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 建立請假失敗' }])
                  }
                } else if (props.dragType === 'shift' || props.dragType === 'employee') {
                  // Drag template or employee to calendar
                  const empId = props.employeeId || selectedEmployeeId
                  if (!empId) {
                    setValidationIssues([{ type: 'error', rule: 'employee', message: '⚠️ 請先點擊選擇員工' }])
                    return
                  }
                  const tpl = templates.find(t => t.id === props.templateId)
                  if (!tpl) {
                    setValidationIssues([{ type: 'error', rule: 'template', message: '⚠️ 請先選擇更次模板' }])
                    return
                  }
                  setValidationIssues([])
                  await createShift(empId, date, tpl)
                } else {
                  // Legacy: dragged employee (backward compat)
                  const empId = props.employeeId
                  if (!empId) return
                  if (!selectedTemplate) {
                    setValidationIssues([{ type: 'error', rule: 'template', message: '⚠️ 請先選擇班次模板才能排班' }])
                    return
                  }
                  const hasLeaveOnDate = leaveRequests.some(lr =>
                    lr.employeeId === empId &&
                    leaveCoversDate(lr, date)
                  )
                  if (hasLeaveOnDate) {
                    setValidationIssues([{ type: 'error', rule: 'shift', message: '❌ 該員工該天已有假期，無法排班' }])
                    return
                  }
                  setValidationIssues([])
                  await createShift(empId, date, selectedTemplate)
                }
                await refreshAll()
              }}
              editable={canManage && !isTouch}
              selectable={canManage && !!selectedTemplate && !isTouch}
              dayMaxEvents={viewMode === 'month' ? false : undefined}
              nowIndicator={true}
              eventClick={handleFcEventClick}
              eventDrop={handleFcEventDrop}
              eventDragStart={() => setIsDraggingEvent(true)}
              eventDragStop={async (info: any) => {
                setIsDraggingEvent(false)
                const dz = dropZoneRef.current
                if (!dz) return
                const dzRect = dz.getBoundingClientRect()
                const clientX = (info as any).jsEvent?.clientX ?? 0
                const clientY = (info as any).jsEvent?.clientY ?? 0

                const onDropZone = clientX >= dzRect.left && clientX <= dzRect.right
                  && clientY >= dzRect.top && clientY <= dzRect.bottom
                if (!onDropZone) return

                // Leave event: delete directly without confirm
                if (info.event.extendedProps.isLeave) {
                  const lr = info.event.extendedProps.leaveRequest
                  const leaveId = lr?.id || info.event.id.replace('leave-', '')
                  await deleteLeave(leaveId)
                  return
                }

                // Shift event: delete directly without confirmation
                await deleteShift(info.event.id)
              }}
              dateClick={handleFcDateClick}
              snapDuration="00:30:00"
              eventConstraint={{ startTime: '06:00:00', endTime: '23:00:00' }}
              eventDurationEditable={false}
              eventContent={(eventInfo) => {
                const shift = eventInfo.event.extendedProps.shift
                return (
                  <div style={{
                    fontSize: viewMode === 'month' ? 11 : undefined,
                    padding: viewMode === 'month' ? '1px 4px' : undefined,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    <b>{eventInfo.event.title}</b>
                    {shift && viewMode !== 'month' && (
                      <div style={{ fontSize: 11 }}>
                        {formatTimeFromShift(shift.startTime)}-{formatTimeFromShift(shift.endTime)}
                      </div>
                    )}
                  </div>
                )
              }}
              height="auto"
              slotMinTime="06:00:00"
              slotMaxTime="23:00:00"
              eventDidMount={(info) => {
                info.el.style.borderRadius = '6px'
              }}
              expandRows={true}
              allDaySlot={false}
              slotDuration="01:00:00"
            />

            {/* Drop Zone for cancelling shifts by dragging out */}
            <div
              ref={dropZoneRef}
              style={{
                marginTop: 12,
                padding: 16,
                borderRadius: 8,
                border: isDraggingEvent ? '2px dashed #dc3545' : '2px dashed #e0e0e0',
                background: isDraggingEvent ? '#fff5f5' : '#fafafa',
                textAlign: 'center',
                fontSize: 13,
                color: isDraggingEvent ? '#dc3545' : '#aaa',
                transition: 'all 0.2s',
                userSelect: 'none',
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'none' }}
            >
              {isDraggingEvent ? <span className="flex items-center gap-1"><Trash2 size={16} /> 放開此處取消班次</span> : <span className="flex items-center gap-1"><Trash2 size={16} /> 拖到此處取消班次</span>}
            </div>
          </div>
          </div>
            </>
          )}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 12, color: '#888' }}>
        <span className="flex items-center gap-1"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#1976d2' }}></span> 已確認</span>
        <span className="flex items-center gap-1"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#f57c00' }}></span> 草稿</span>
        <span className="flex items-center gap-1"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#388e3c' }}></span> 已完成</span>
        <span className="flex items-center gap-1"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#dc3545' }}></span> 已取消</span>
      </div>

      {/* ============================================================ */}
      {/* Shift Change Request Panel */}
      {/* ============================================================ */}
      {showChangePanel && (
        <div className="card rounded-xl g border p-4 shadow-card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18 }} className="flex items-center gap-2"><RefreshCw size={18} /> 換更申請</h2>
            <button
              onClick={() => setShowChangePanel(false)}
              style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
            >
              <X size={18} />
            </button>
          </div>

          {/* New change request form (for employees) */}
          {userRole === 'EMPLOYEE' && !editingShift && (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, marginBottom: 12 }}>發起新申請</h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select
                  id="changeShiftSelect"
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}
                >
                  <option value="">選擇要換的班次</option>
                  {shifts.map(s => (
                    <option key={s.id} value={s.id}>
                      {formatDate(new Date(s.date))} {s.role || ''} {formatTimeFromShift(s.startTime)}-{formatTimeFromShift(s.endTime)}
                    </option>
                  ))}
                </select>
                <select
                  id="changeTypeSelect"
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}
                >
                  <option value="SWAP">轉更 (Swap)</option>
                  <option value="COVER">頂更 (Cover)</option>
                  <option value="REPORT">報更 (Report)</option>
                </select>
                <select
                  id="changeToEmployeeSelect"
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}
                >
                  <option value="">選擇對象（可選）</option>
                  {availableEmployees.map(e => (
                    <option key={e.id} value={e.id}>{e.user?.name ?? '?'}</option>
                  ))}
                </select>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    const shiftId = (document.getElementById('changeShiftSelect') as HTMLSelectElement).value
                    const type = (document.getElementById('changeTypeSelect') as HTMLSelectElement).value as ChangeType
                    const toEmployeeId = (document.getElementById('changeToEmployeeSelect') as HTMLSelectElement).value || undefined

                    if (!shiftId) {
                      alert('請選擇班次')
                      return
                    }

                    const reason = prompt('申請原因（可選）：')
                    createChangeRequest(shiftId, type, toEmployeeId || undefined, reason || undefined)
                  }}
                >
                  提交申請
                </button>
              </div>
            </div>
          )}

          {/* Change request list */}
          <div>
            <h3 style={{ fontSize: 14, marginBottom: 12 }}>
              申請列表 ({changeRequests.length})
            </h3>

            {changeRequests.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: '#aaa' }}>
                暫無換更申請
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {changeRequests.map(req => {
                  const statusColors: Record<string, string> = {
                    PENDING: '#f57c00',
                    APPROVED: '#388e3c',
                    REJECTED: '#dc3545',
                    COMPLETED: '#1976d2',
                  }
                  const statusLabels: Record<string, string> = {
                    PENDING: '待審批',
                    APPROVED: '已批准',
                    REJECTED: '已拒絕',
                    COMPLETED: '已完成',
                  }
                  const typeLabels: Record<string, string> = {
                    SWAP: '轉更',
                    COVER: '頂更',
                    REPORT: '報更',
                  }

                  return (
                    <div key={req.id} style={{
                      padding: 12,
                      border: '1px solid #eee',
                      borderRadius: 8,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}>
                      <div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold text-white" style={{ background: statusColors[req.status] || '#888' }}>
                            {statusLabels[req.status] || req.status}
                          </span>
                          <span className="text-sm font-medium">
                            {typeLabels[req.type] || req.type}
                          </span>
                          <span style={{ fontSize: 12, color: '#888' }}>
                            {req.shift?.date ? formatDate(new Date(req.shift.date)) : ''}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                          {req.fromEmployee?.user?.name ?? '?'}
                          {req.toEmployee && ` → ${req.toEmployee?.user?.name ?? '?'}`}
                        </div>
                        {req.reason && (
                          <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                            原因：{req.reason}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: '#aaa', marginTop: 2 }}>
                          創建於 {fmtDateTime(req.createdAt)}
                          {req.approvedAt && ` | 審批於 ${fmtDateTime(req.approvedAt)}`}
                        </div>
                      </div>

                      {/* Action buttons for managers */}
                      {canManage && req.status === 'PENDING' && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => {
                              const reason = prompt('批準原因（可選）：')
                              approveChangeRequest(req.id, 'APPROVE', reason || undefined)
                            }}
                            className="btn btn-sm"
                            style={{ background: '#388e3c', color: 'white' }}
                          >
                            ✅ 批準
                          </button>
                          <button
                            onClick={() => {
                              const reason = prompt('拒絕原因：')
                              approveChangeRequest(req.id, 'REJECT', reason || undefined)
                            }}
                            className="btn btn-sm"
                            style={{ background: '#dc3545', color: 'white' }}
                          >
                            ❌ 拒絕
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* Edit Shift Modal */}
      {/* ============================================================ */}
      {editingShift && canManage && !showChangePanel && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}
          onClick={() => setEditingShift(null)}
        >
          <div
            className="g bg-card g border rounded-xl shadow-lg mx-4 p-6 relative"
            style={{ width: '500px', maxWidth: '90vw' }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setEditingShift(null)}
              style={{
                position: 'absolute', top: 12, right: 12,
                background: 'none', border: 'none', fontSize: 18,
                cursor: 'pointer', color: '#888',
              }}
            >
              <X size={18} />
            </button>

            <h2 style={{ fontSize: 16, marginTop: 0 }}>編輯班次</h2>

            <div className="form-group">
              <label>日期</label>
              <input
                type="date"
                id="editShiftDate"
                defaultValue={formatDate(new Date(editingShift.date))}
              />
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label>開始時間</label>
                <input
                  type="time"
                  id="editShiftStart"
                  defaultValue={formatTimeFromShift(editingShift.startTime)}
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>結束時間</label>
                <input
                  type="time"
                  id="editShiftEnd"
                  defaultValue={formatTimeFromShift(editingShift.endTime)}
                />
              </div>
            </div>

            <div className="form-group">
              <label>職位</label>
              <select id="editShiftRole">
                <option value="">選擇職位</option>
                <option value="Doctor" selected={editingShift.role === 'Doctor'}>醫生</option>
                <option value="Nurse" selected={editingShift.role === 'Nurse'}>護士</option>
                <option value="Receptionist" selected={editingShift.role === 'Receptionist'}>前台</option>
              </select>
            </div>

            <div className="form-group">
              <label>狀態</label>
              <select id="editShiftStatus">
                <option value="DRAFT" selected={editingShift.status === 'DRAFT'}>草稿</option>
                <option value="CONFIRMED" selected={editingShift.status === 'CONFIRMED'}>已確認</option>
                <option value="COMPLETED" selected={editingShift.status === 'COMPLETED'}>已完成</option>
                <option value="CANCELLED" selected={editingShift.status === 'CANCELLED'}>已取消</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                onClick={() => setEditingShift(null)}
                className="btn"
                style={{ background: '#eee', color: '#333' }}
              >
                取消
              </button>
              <button
                onClick={async () => {
                  const date = (document.getElementById('editShiftDate') as HTMLInputElement).value
                  const startTime = (document.getElementById('editShiftStart') as HTMLInputElement).value
                  const endTime = (document.getElementById('editShiftEnd') as HTMLInputElement).value
                  const role = (document.getElementById('editShiftRole') as HTMLSelectElement).value
                  const status = (document.getElementById('editShiftStatus') as HTMLSelectElement).value

                  if (!date || !startTime || !endTime) {
                    alert('請填寫完整資訊')
                    return
                  }

                  const [startH, startM] = startTime.split(':').map(Number)
                  const [endH, endM] = endTime.split(':').map(Number)
                  const pad = (n: number) => String(n).padStart(2, '0')
                  const startTimeISO = new Date(`${date}T${pad(startH)}:${pad(startM)}:00+08:00`).toISOString()
                  const endTimeISO = new Date(`${date}T${pad(endH)}:${pad(endM)}:00+08:00`).toISOString()

                  try {
                    const res = await fetch(`/api/shifts/${editingShift.id}`, {
                      method: 'PUT',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        date,
                        startTime: startTimeISO,
                        endTime: endTimeISO,
                        role: role || null,
                        status,
                      }),
                    })

                    if (res.ok) {
                      setEditingShift(null)
                      loadShifts()
                      setCardRefreshTick(t => t + 1)
                    } else {
                      const err = await res.json()
                      alert(err.error || '更新失敗')
                    }
                  } catch (error) {
                    console.error('Update shift error:', error)
                  }
                }}
                className="btn btn-primary"
              >
                儲存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Shift Modal */}
      {showNewShiftModal && canManage && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}
          onClick={() => setShowNewShiftModal(false)}
        >
          <div
            className="g bg-card g border rounded-xl shadow-lg mx-4 p-6 relative"
            style={{ width: '512px', maxWidth: '90vw' }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setShowNewShiftModal(false)}
              style={{
                position: 'absolute', top: 12, right: 12,
                background: 'none', border: 'none', fontSize: 18,
                cursor: 'pointer', color: '#888',
              }}
            >
              <X size={18} />
            </button>
            <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 16 }}>
              <PlusCircle size={16} style={{ marginRight: 6 }} /> 新增班次
            </h2>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>員工</label>
              <select
                id="newShiftEmployee"
                style={{
                  width: '100%', padding: '6px 10px', borderRadius: 6,
                  border: '1px solid #ddd', fontSize: 13,
                }}
              >
                <option value="">選擇員工</option>
                {clinicEmployees.map(emp => (
                  <option key={emp.id} value={emp.id}>{emp.user?.name ?? '?'}</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>日期</label>
              <input
                type="date"
                id="newShiftDate"
                defaultValue={formatDate(currentDate)}
                style={{
                  width: '100%', padding: '6px 10px', borderRadius: 6,
                  border: '1px solid #ddd', fontSize: 13,
                }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>更次模板</label>
              <select
                id="newShiftTemplate"
                style={{
                  width: '100%', padding: '6px 10px', borderRadius: 6,
                  border: '1px solid #ddd', fontSize: 13,
                }}
              >
                <option value="">選擇模板</option>
                {templates.map(tpl => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name} ({String(tpl.startHour).padStart(2, '0')}:{String(tpl.startMinute).padStart(2, '0')}
                    -{String(tpl.endHour).padStart(2, '0')}:{String(tpl.endMinute).padStart(2, '0')})
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowNewShiftModal(false)}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: '1px solid #ddd',
                  background: '#f5f5f5', cursor: 'pointer', fontSize: 13,
                }}
              >
                取消
              </button>
              <button
                onClick={async () => {
                  const employeeId = (document.getElementById('newShiftEmployee') as HTMLSelectElement).value
                  const date = (document.getElementById('newShiftDate') as HTMLInputElement).value
                  const templateId = (document.getElementById('newShiftTemplate') as HTMLSelectElement).value

                  if (!employeeId || !date || !templateId) {
                    alert('請填寫完整資訊')
                    return
                  }

                  const template = templates.find(t => t.id === templateId)
                  if (!template) return

                  await createShift(employeeId, date, template)
                  await loadShifts()
                  setCardRefreshTick(t => t + 1)
                  setShowNewShiftModal(false)
                }}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  background: '#0d6efd', color: '#fff',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >
                建立班次
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Leave Employee Selection Modal (shown when dragging leave without selected employee) */}
      {showLeaveEmployeeModal && canManage && clinicEmployees.length > 0 && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}
          onClick={() => setShowLeaveEmployeeModal(null)}
        >
          <div
            className="g bg-card g border rounded-xl shadow-lg mx-4 p-6 relative"
            style={{ width: '380px', maxWidth: '90vw' }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setShowLeaveEmployeeModal(null)}
              style={{
                position: 'absolute', top: 12, right: 12,
                background: 'none', border: 'none', fontSize: 18,
                cursor: 'pointer', color: '#888',
              }}
            >
              <X size={18} />
            </button>
            <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 8 }}>
              <Palmtree size={16} style={{ marginRight: 6 }} /> 選擇員工
            </h2>
            <p style={{ fontSize: 13, color: '#888', margin: '0 0 16px 0' }}>
              拖放「{leaveTypes.find(lt => lt.id === showLeaveEmployeeModal.leaveTypeId)?.name || '假期'}」到 {showLeaveEmployeeModal.date}，請選擇員工：
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
              {clinicEmployees.map(emp => (
                <div
                  key={emp.id}
                  onClick={async () => {
                    const { date, leaveTypeId } = showLeaveEmployeeModal
                    try {
                      const res = await fetch('/api/leave-requests', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          leaveTypeId,
                          employeeId: emp.id,
                          startDate: date,
                          endDate: date,
                          days: 1,
                          reason: `排班頁拖曳請假`,
                          isPlanned: true,
                          clinicId: selectedClinicId,
                        }),
                      })
                      if (res.ok) {
                        setShowLeaveEmployeeModal(null)
                        setValidationIssues([])
                        await refreshAll()
                      } else {
                        const err = await res.json()
                        alert(err.error || '建立請假失敗')
                      }
                    } catch {
                      alert('建立請假失敗')
                    }
                  }}
                  style={{
                    padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                    background: '#f5f5f5', border: '1px solid #e0e0e0',
                    fontSize: 14, transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#e8e8e8' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#f5f5f5' }}
                >
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, background: colorFor(emp.id) }}></span>
                  {emp.user?.name ?? '?'}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
      </div>
  )
}

// ============================================================
// NewShiftTemplateForm — Inline form for creating new shift templates
// ============================================================
function NewShiftTemplateForm({ onCreated }: { onCreated: (tpl: { name: string; shortName: string | null; startHour: number; startMinute: number; endHour: number; endMinute: number; isNightShift: boolean }) => void }) {
  const [name, setName] = useState('')
  const [shortName, setShortName] = useState('')
  const [startHour, setStartHour] = useState(9)
  const [startMinute, setStartMinute] = useState(0)
  const [endHour, setEndHour] = useState(18)
  const [endMinute, setEndMinute] = useState(0)
  const [isNightShift, setIsNightShift] = useState(false)

  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      <input
        placeholder="名稱（如早更）"
        value={name}
        onChange={e => setName(e.target.value)}
        style={{ width: 100, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }}
      />
      <input
        placeholder="簡稱（1-4字）"
        value={shortName}
        maxLength={4}
        onChange={e => setShortName(e.target.value)}
        style={{ width: 80, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
        起
        <input
          type="number" min={0} max={23} value={startHour}
          onChange={e => setStartHour(parseInt(e.target.value) || 0)}
          style={{ width: 45, padding: '4px 4px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }}
        />:
        <input
          type="number" min={0} max={59} value={startMinute}
          onChange={e => setStartMinute(parseInt(e.target.value) || 0)}
          style={{ width: 45, padding: '4px 4px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
        迄
        <input
          type="number" min={0} max={23} value={endHour}
          onChange={e => setEndHour(parseInt(e.target.value) || 0)}
          style={{ width: 45, padding: '4px 4px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }}
        />:
        <input
          type="number" min={0} max={59} value={endMinute}
          onChange={e => setEndMinute(parseInt(e.target.value) || 0)}
          style={{ width: 45, padding: '4px 4px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
        <input type="checkbox" checked={isNightShift} onChange={e => setIsNightShift(e.target.checked)} />
        夜更
      </label>
      <button
        className="btn btn-sm"
        style={{ background: '#e8f5e9', color: '#2e7d32', border: '1px solid #c8e6c9', fontSize: 11, padding: '4px 12px' }}
        onClick={() => {
          if (!name.trim()) { alert('請輸入名稱'); return }
          onCreated({ name: name.trim(), shortName: shortName.trim() || null, startHour, startMinute, endHour, endMinute, isNightShift })
          setName('')
          setShortName('')
        }}
      >新增</button>
    </div>
  )
}
