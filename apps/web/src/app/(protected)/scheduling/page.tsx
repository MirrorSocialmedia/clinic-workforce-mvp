'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin, { Draggable } from '@fullcalendar/interaction'
import zhcn from '@fullcalendar/core/locales/zh-cn'
import { toHKDateStr, fmtTime } from '@/lib/hk-date'
import type { ShiftRuleConfig } from '@/lib/shift-rule-config'
import { DEFAULT_SHIFT_RULE_CONFIG } from '@/lib/shift-rule-config'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'

// ============================================================
// Types
// ============================================================
type ViewMode = 'week' | 'month'
type ChangeType = 'SWAP' | 'COVER' | 'REPORT'

interface Employee {
  id: string
  user: { id: string; name: string; phone?: string }
  clinics: { clinic: { id: string; name: string } }[]
  status: string
}

interface Clinic {
  id: string
  name: string
}

interface ShiftTemplate {
  id: string
  name: string
  startHour: number
  startMinute: number
  endHour: number
  endMinute: number
  isNightShift: boolean
  isDefault: boolean
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
  employee?: { user: { name: string } }
  clinic?: { name: string }
  template?: { name: string }
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
  const [templates, setTemplates] = useState<ShiftTemplate[]>([])
  const [changeRequests, setChangeRequests] = useState<ShiftChangeRequest[]>([])
  const [userRole, setUserRole] = useState<string>('')
  const [userId, setUserId] = useState<string>('')
  const [loading, setLoading] = useState(true)

  // UI State
  const [selectedTemplate, setSelectedTemplate] = useState<ShiftTemplate | null>(null)
  const [leaveTypes, setLeaveTypes] = useState<any[]>([])
  const [leaveRequests, setLeaveRequests] = useState<any[]>([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('')
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [showChangePanel, setShowChangePanel] = useState(false)
  const [editingShift, setEditingShift] = useState<Shift | null>(null)
  const [showNewShiftModal, setShowNewShiftModal] = useState(false)
  const [showRuleSettings, setShowRuleSettings] = useState(false)
  const [showLeaveEmployeeModal, setShowLeaveEmployeeModal] = useState<{ date: string; leaveTypeId: string } | null>(null)

  // Shift rule config state
  const [shiftRuleConfig, setShiftRuleConfig] = useState<ShiftRuleConfig>({ ...DEFAULT_SHIFT_RULE_CONFIG })
  const [savingRules, setSavingRules] = useState(false)

  // Drag and drop state
  const dragData = useRef<{ employeeId: string; templateId: string } | null>(null)
  const empPanelRef = useRef<HTMLDivElement>(null)
  const leavePanelRef = useRef<HTMLDivElement>(null)
  const calendarContainerRef = useRef<HTMLDivElement>(null)
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

  // ============================================================
  // Data Loading
  // ============================================================
  const loadData = useCallback(async () => {
    try {
      const [meRes, clinicsRes, employeesRes, templatesRes, changesRes] = await Promise.all([
        fetch('/api/me', { credentials: 'include' }),
        fetch('/api/clinics', { credentials: 'include' }),
        fetch('/api/employees?pageSize=200', { credentials: 'include' }),
        fetch('/api/shifts/templates', { credentials: 'include' }),
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

      if (templatesRes.ok) {
        const tplData = await templatesRes.json()
        setTemplates(tplData.templates || [])
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

  // Load month-level shifts for statistics
  const loadMonthShifts = useCallback(async () => {
    if (!selectedClinicId) return
    const now = new Date()
    const monthStart = toHKDateStr(new Date(now.getFullYear(), now.getMonth(), 1))
    const monthEnd = toHKDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0))
    try {
      const r = await fetch(`/api/shifts?clinicId=${selectedClinicId}&startDate=${monthStart}&endDate=${monthEnd}&pageSize=1000`, { credentials: 'include' })
      if (r.ok) {
        const d = await r.json()
        setMonthShifts(d.shifts || [])
      }
    } catch {
      setMonthShifts([])
    }
  }, [selectedClinicId])

  useEffect(() => {
    loadMonthShifts()
  }, [loadMonthShifts])

  // Register FC Draggable on employee panel
  useEffect(() => {
    if (!empPanelRef.current) return
    const draggable = new Draggable(empPanelRef.current, {
      itemSelector: '.emp-card',
      eventData: (el: HTMLElement) => ({
        title: el.getAttribute('data-name') || '',
        extendedProps: { employeeId: el.getAttribute('data-emp-id') },
        duration: '08:00',
      }),
    })
    return () => draggable.destroy()
  }, [employees, selectedClinicId, viewMode])

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

  // Register FC Draggable on leave panel
  useEffect(() => {
    if (!leavePanelRef.current) return
    const d = new Draggable(leavePanelRef.current, {
      itemSelector: '.leave-card',
      eventData: (el: HTMLElement) => ({
        title: el.getAttribute('data-name') || '假期',
        extendedProps: {
          dragType: 'leave',
          leaveTypeId: el.getAttribute('data-leave-id'),
        },
        backgroundColor: '#95a5a6',
        borderColor: '#7f8c8d',
      }),
    })
    return () => d.destroy()
  }, [leaveTypes, viewMode])

  // ============================================================
  // Load shifts for current view
  // ============================================================
  const loadShifts = useCallback(async () => {
    if (!selectedClinicId || !viewRange) return

    const url = `/api/shifts?clinicId=${selectedClinicId}&startDate=${viewRange.start}&endDate=${viewRange.end}&pageSize=500`

    try {
      const [shiftsRes, leavesRes] = await Promise.all([
        fetch(url, { credentials: 'include' }),
        fetch(`/api/leave-requests?startDate=${viewRange.start}&endDate=${viewRange.end}&status=APPROVED`, { credentials: 'include' }),
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
  }, [selectedClinicId, viewRange])

  useEffect(() => {
    if (viewRange) loadShifts()
  }, [viewRange, selectedClinicId])

  // Refresh all data after shift changes (Task 2)
  const refreshAll = useCallback(async () => {
    await loadShifts()
    await loadMonthShifts()
  }, [loadShifts, loadMonthShifts])

  // ============================================================
  // Date Helpers
  // ============================================================
  const getDateRange = (): { startDate: string; endDate: string } => {
    const base = new Date(currentDate)
    if (viewMode === 'week') {
      const day = base.getDay()
      const diff = (day === 0 ? -6 : 1) - day // offset to Monday
      const start = new Date(base)
      start.setDate(base.getDate() + diff)
      const end = new Date(start)
      end.setDate(start.getDate() + 6)
      return {
        startDate: toHKDateStr(start),
        endDate: toHKDateStr(end),
      }
    } else {
      const start = new Date(base.getFullYear(), base.getMonth(), 1)
      const end = new Date(base.getFullYear(), base.getMonth() + 1, 0)
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
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(new Date(d))
    }
    return dates
  }

  const formatDate = (date: Date): string => {
    return toHKDateStr(date)
  }

  const formatDateLabel = (date: Date): string => {
    const dayNames = ['日', '一', '二', '三', '四', '五', '六']
    return `${date.getMonth() + 1}/${date.getDate()} 周${dayNames[date.getDay()]}`
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

    // Build start/end times from template
    const dateObj = new Date(date)
    const startTime = new Date(dateObj)
    startTime.setHours(template.startHour, template.startMinute, 0, 0)
    const endTime = new Date(dateObj)
    endTime.setHours(template.endHour, template.endMinute, 0, 0)

    // For night shifts, end time is next day
    if (template.isNightShift) {
      endTime.setDate(endTime.getDate() + 1)
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
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(formatDate(d))
    }

    // Filter employees by selected clinic
    const clinicEmployees = employees.filter(emp =>
      emp.clinics.some(ec => ec.clinic.id === selectedClinicId)
    )

    try {
      const res = await fetch('/api/shifts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: clinicEmployees[0]?.id, // bulk mode with dates
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
    const d = new Date(date)
    d.setHours(hour, minute, 0, 0)
    if (isNight) d.setDate(d.getDate() + 1)
    return d.toISOString()
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
    // Leave event: click to delete
    if (info.event.extendedProps.isLeave) {
      if (canManage) {
        if (confirm(`取消 ${info.event.title} 的假期？`)) {
          const lr = info.event.extendedProps.leaveRequest
          const leaveId = lr?.id || info.event.id.replace('leave-', '')
          try {
            const res = await fetch(`/api/leave-requests/${leaveId}`, {
              method: 'DELETE',
              credentials: 'include',
            })
            if (res.ok) {
              await refreshAll()
            } else {
              const err = await res.json()
              alert(err.error || '刪除假期失敗')
            }
          } catch (e) {
            console.error('Delete leave error:', e)
          }
        }
      }
      return
    }

    // Shift event
    const shift = shifts.find(s => s.id === info.event.id)
    if (shift) {
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

  const handleFcDateClick = (info: any) => {
    if (!canManage || !selectedTemplate) return
    // Open shift creation modal with selected date
    setShowNewShiftModal(true)
    setCurrentDate(new Date(info.dateStr))
  }

  // Map shifts to FC events
  const fcEvents = [
    ...shifts.map(s => ({
      id: s.id,
      title: (s.employee?.user?.name || '') + ' ' + (s.template?.name || ''),
      start: s.startTime,
      end: s.endTime,
      backgroundColor: s.status === 'CONFIRMED' ? '#1976d2' :
                       s.status === 'DRAFT' ? '#f57c00' :
                       s.status === 'CANCELLED' ? '#dc3545' : '#388e3c',
      borderColor: s.status === 'CONFIRMED' ? '#1565c0' :
                   s.status === 'DRAFT' ? '#e65100' :
                   s.status === 'CANCELLED' ? '#c82333' : '#2e7d32',
      extendedProps: { shift: s },
    })),
    ...leaveRequests.map((lr, idx) => ({
      id: 'leave-' + lr.id,
      title: lr.employee?.user?.name + ' ' + (lr.leaveType?.name || ''),
      start: lr.startDate,
      end: lr.endDate,
      backgroundColor: '#95a5a6',
      borderColor: '#7f8c8d',
      extendedProps: { isLeave: true, leaveRequest: lr },
    })),
  ]

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

  // ============================================================
  // Get employees for selected clinic
  // ============================================================
  const getClinicEmployees = (): Employee[] => {
    if (!selectedClinicId) return []
    return employees.filter(emp =>
      emp.clinics.some(ec => ec.clinic.id === selectedClinicId)
    )
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

  const formatTimeFromShift = (isoString: string): string => {
    const d = new Date(isoString)
    return d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  // Helper: calculate shift hours (Task 3b)
  const shiftHours = (shift: any): number => {
    const s = new Date(shift.startTime)
    const e = new Date(shift.endTime)
    return (e.getTime() - s.getTime()) / (1000 * 60 * 60)
  }

  // ============================================================
  // Loading State
  // ============================================================
  if (loading) {
    return <div className="flex justify-center items-center py-12 text-muted-foreground">載入中...</div>
  }

  const clinicEmployees = getClinicEmployees()
  const excludeEmployeeId = editingShift?.employeeId || ''
  const availableEmployees = clinicEmployees.filter((e: Employee) => e.id !== excludeEmployeeId)

  // ============================================================
  // Render
  // ============================================================
  return (
    <div style={{ maxWidth: '1200px' }}>
      {/* Header */}
      <div className="flex justify-between items-center mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>📅 排班管理</h1>
          <p className="text-muted text-sm" style={{ margin: '4px 0 0 0' }}>
            {canManage ? '拖放排班 · 規則校驗 · 頂更/轉更' : '查看班表'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Clinic selector */}
          <select
            value={selectedClinicId || ''}
            onChange={e => setSelectedClinicId(e.target.value)}
            className="form-group"
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: 'auto' }}
          >
            {clinics.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

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
              {'⚙️ 排班規則'}
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
            <button onClick={() => setShowRuleSettings(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}>✕</button>
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
              <h3 style={{ margin: '0 0 12px 0', fontSize: 15, fontWeight: 600 }}>📋 更次模版管理</h3>
              {templates.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, padding: '8px 12px', background: '#f9f9f9', borderRadius: 6 }}>
                  <span style={{ minWidth: 60, fontWeight: 500, fontSize: 13 }}>{t.name}</span>
                  <span style={{ fontSize: 12, color: '#888' }}>
                    {String(t.startHour).padStart(2, '0')}:{String(t.startMinute).padStart(2, '0')}
                    -{String(t.endHour).padStart(2, '0')}:{String(t.endMinute).padStart(2, '0')}
                    {t.isNightShift ? ' (夜更)' : ''}
                  </span>
                  {t.isDefault && <span style={{ fontSize: 10, color: '#1976d2', background: '#e3f2fd', padding: '1px 6px', borderRadius: 4 }}>預設</span>}
                  {!t.isDefault && (
                    <button
                      className="btn btn-sm"
                      style={{ marginLeft: 'auto', background: '#fde8e8', color: '#dc3545', border: '1px solid #f5c6cb', fontSize: 11, padding: '2px 8px' }}
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
                  )}
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
                      body: JSON.stringify(tpl),
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

      {/* Employee chips (top horizontal, draggable) */}
      {canManage && clinicEmployees.length > 0 && (
        <div ref={empPanelRef} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, overflowX: 'auto' }}>
          {clinicEmployees.map(emp => (
            <div
              key={emp.id}
              className="emp-card"
              data-emp-id={emp.id}
              data-name={emp.user.name}
              onClick={() => setSelectedEmployeeId(prev => prev === emp.id ? '' : emp.id)}
              style={{
                padding: '6px 14px', borderRadius: 16, fontSize: 13,
                background: selectedEmployeeId === emp.id ? '#fff' : colorFor(emp.id),
                color: selectedEmployeeId === emp.id ? colorFor(emp.id) : '#fff',
                border: selectedEmployeeId === emp.id ? `2px solid ${colorFor(emp.id)}` : '2px solid transparent',
                cursor: 'grab', whiteSpace: 'nowrap', flexShrink: 0,
                transition: 'all 0.15s',
              }}
            >
              {emp.user.name}
              <span style={{ marginLeft: 6, opacity: 0.8 }}>{empShiftDays(emp.id)}天</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16 }}>
        {/* Left: Templates + Leave (scrollable) */}
        {canManage && (
          <div style={{ width: 180, flexShrink: 0, maxHeight: 600, overflowY: 'auto' }}>
            <h4 style={{ fontSize: 13, margin: '0 0 8px 0', color: '#888' }}>更次模版</h4>
            {templates.map(t => (
              <div
                key={t.id}
                onClick={() => setSelectedTemplate(t)}
                style={{
                  padding: '8px 12px', margin: '4px 0', borderRadius: 8,
                  cursor: 'pointer',
                  background: selectedTemplate?.id === t.id ? '#1a1a2e' : '#f0f0f0',
                  color: selectedTemplate?.id === t.id ? '#fff' : '#333',
                }}
              >
                {t.name}
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  {String(t.startHour).padStart(2,'0')}:{String(t.startMinute).padStart(2,'0')}-{String(t.endHour).padStart(2,'0')}:{String(t.endMinute).padStart(2,'0')}
                </div>
              </div>
            ))}

            {/* Leave types panel */}
            {leaveTypes.length > 0 && (
              <div ref={leavePanelRef} style={{ marginTop: 16 }}>
                <h4 style={{ fontSize: 13, margin: '0 0 8px 0', color: '#888' }}>假期</h4>
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>
                  {selectedEmployeeId ? `選中: ${clinicEmployees.find(e => e.id === selectedEmployeeId)?.user?.name || ''}` : '點擊上方員工芯片選中'}
                </div>
                {leaveTypes.map(lt => (
                  <div
                    key={lt.id}
                    className="leave-card"
                    data-leave-id={lt.id}
                    data-name={lt.name}
                    style={{
                      padding: '8px 12px', margin: '4px 0',
                      background: lt.color || '#95a5a6', color: '#fff',
                      borderRadius: 8, cursor: 'grab', fontSize: 13,
                    }}
                    title="拖到日曆建立請假"
                  >
                    🏖 {lt.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      {/* Right: Calendar Card */}
      <div className="flex-1 min-w-0">
      <div className="card rounded-xl g border p-4 shadow-card">
      <div ref={calendarContainerRef}>

        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={viewMode === 'week' ? 'timeGridWeek' : 'dayGridMonth'}
          locale={zhcn}
          headerToolbar={{
            left: 'prev,next',
            center: '',
            right: 'timeGridWeek,dayGridMonth',
          }}
          datesSet={(dateInfo) => {
            // Sync viewMode from FC view type (since we removed the manual toggle)
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
              end: toHKDateStr(new Date(dateInfo.end.getTime() - 86400000)), // end is exclusive, subtract 1 day
            }
            if (range.start !== viewRange?.start || range.end !== viewRange?.end) {
              setViewRange(range)
            }
          }}
          events={fcEvents}
          droppable={true}
          eventReceive={async (info) => {
            info.event.remove() // 移除 FC 自動生成的臨時事件
            const props = info.event.extendedProps
            const date = toHKDateStr(info.event.start!)

            if (props.dragType === 'leave') {
              // 拖的是假期 → 建立請假（1天，APPROVED 模式 for manager/owner）
              const leaveTypeId = props.leaveTypeId
              if (!leaveTypeId) {
                setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 假期類型無效' }])
                return
              }

              // 複用已選中的員工（點擊員工 chip 選中的）
              if (!selectedEmployeeId) {
                setShowLeaveEmployeeModal({ date, leaveTypeId })
                return
              }

              const leaveTypeName = leaveTypes.find(lt => lt.id === leaveTypeId)?.name || '假期'
              const targetEmployeeId = selectedEmployeeId

              try {
                const res = await fetch('/api/leave-requests', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    leaveTypeId,
                    employeeId: targetEmployeeId,
                    startDate: date,
                    endDate: date,
                    days: 1,
                    reason: `排班頁拖曳請假`,
                    isPlanned: true,
                  }),
                })
                if (res.ok) {
                  setValidationIssues([])
                } else {
                  const err = await res.json()
                  setValidationIssues([{ type: 'error', rule: 'leave', message: err.error || '建立請假失敗' }])
                }
              } catch {
                setValidationIssues([{ type: 'error', rule: 'leave', message: '❌ 建立請假失敗' }])
              }
            } else {
              // 拖的是員工 → 建立班次
              const empId = props.employeeId
              if (!empId) return
              if (!selectedTemplate) {
                setValidationIssues([{ type: 'error', rule: 'template', message: '⚠️ 請先選擇班次模板才能排班' }])
                return
              }
              setValidationIssues([])
              await createShift(empId, date, selectedTemplate)
            }
            // Reload shifts + leave requests + month stats
            await refreshAll()
          }}
          editable={canManage}
          selectable={canManage && !!selectedTemplate}
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

            // Leave event: confirm and delete
            if (info.event.extendedProps.isLeave) {
              if (confirm(`確定取消假期？`)) {
                const lr = info.event.extendedProps.leaveRequest
                const leaveId = lr?.id || info.event.id.replace('leave-', '')
                try {
                  const res = await fetch(`/api/leave-requests/${leaveId}`, {
                    method: 'DELETE',
                    credentials: 'include',
                  })
                  if (res.ok) {
                    await refreshAll()
                  } else {
                    const err = await res.json()
                    alert(err.error || '刪除假期失敗')
                  }
                } catch (e) {
                  console.error('Delete leave error:', e)
                }
              }
              return
            }

            // Shift event: confirm and delete
            if (confirm(`確定取消「${info.event.title}」的班次？`)) {
              await deleteShift(info.event.id)
            }
            // else 什麼都不做 → 班次留在原位
          }}
          dateClick={handleFcDateClick}
          snapDuration="00:30:00"
          eventConstraint={{ startTime: '08:00:00', endTime: '22:00:00' }}
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
          height={viewMode === 'month' ? 'auto' : 650}
          slotMinTime="07:00:00"
          slotMaxTime="23:00:00"
          eventDidMount={(info) => {
            info.el.style.borderRadius = '6px'
          }}
          expandRows={true}
          allDaySlot={false}
          slotDuration="00:30:00"
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
          {isDraggingEvent ? '🗑 放開此處取消班次' : '🗑 拖到此處取消班次'}
        </div>
      </div>
      </div>
      </div>
      </div>


      {/* Month Shift Statistics Card (Task 3b) */}
      {clinicEmployees.length > 0 && (
        <div className="card rounded-xl g border p-4 shadow-card" style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: 16 }}>
            {'📊 本月排班統計（' + new Date().getFullYear() + '年' + (new Date().getMonth()+1) + '月）'}
          </h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #eee' }}>
                  <th style={{ textAlign: 'left', padding: '8px 12px', color: '#888' }}>員工</th>
                  <th style={{ textAlign: 'center', padding: '8px 12px', color: '#888' }}>已排天數</th>
                  <th style={{ textAlign: 'center', padding: '8px 12px', color: '#888' }}>總工時</th>
                </tr>
              </thead>
              <tbody>
                {clinicEmployees.map(emp => {
                  const empShifts = monthShifts.filter(s => s.employeeId === emp.id)
                  const days = new Set(empShifts.map(s => toHKDateStr(new Date(s.date)))).size
                  const hours = empShifts.reduce((sum, s) => sum + shiftHours(s), 0)
                  return (
                    <tr key={emp.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, background: colorFor(emp.id) }}></span>
                        {emp.user.name}
                      </td>
                      <td style={{ textAlign: 'center', padding: '8px 12px' }}>{days} 天</td>
                      <td style={{ textAlign: 'center', padding: '8px 12px' }}>{hours.toFixed(1)} 小時</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 12, color: '#888' }}>
        <span>🔵 已確認</span>
        <span>🟠 草稿</span>
        <span>🟢 已完成</span>
        <span>🔴 已取消</span>
      </div>

      {/* ============================================================ */}
      {/* Shift Change Request Panel */}
      {/* ============================================================ */}
      {showChangePanel && (
        <div className="card rounded-xl g border p-4 shadow-card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>🔄 換更申請</h2>
            <button
              onClick={() => setShowChangePanel(false)}
              style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
            >
              ✕
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
                    <option key={e.id} value={e.id}>{e.user.name}</option>
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
                          {req.fromEmployee?.user.name}
                          {req.toEmployee && ` → ${req.toEmployee.user.name}`}
                        </div>
                        {req.reason && (
                          <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                            原因：{req.reason}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: '#aaa', marginTop: 2 }}>
                          創建於 {new Date(req.createdAt).toLocaleString('zh-HK')}
                          {req.approvedAt && ` | 審批於 ${new Date(req.approvedAt).toLocaleString('zh-HK')}`}
                        </div>
                      </div>

                      {/* Action buttons for managers */}
                      {canManage && req.status === 'PENDING' && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => {
                              const reason = prompt('批准原因（可選）：')
                              approveChangeRequest(req.id, 'APPROVE', reason || undefined)
                            }}
                            className="btn btn-sm"
                            style={{ background: '#388e3c', color: 'white' }}
                          >
                            ✅ 批准
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
              ✕
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

                  const dateObj = new Date(date)
                  const [startH, startM] = startTime.split(':').map(Number)
                  const [endH, endM] = endTime.split(':').map(Number)
                  dateObj.setHours(startH, startM, 0, 0)
                  const endObj = new Date(date)
                  endObj.setHours(endH, endM, 0, 0)

                  try {
                    const res = await fetch(`/api/shifts/${editingShift.id}`, {
                      method: 'PUT',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        date: dateObj.toISOString(),
                        startTime: dateObj.toISOString(),
                        endTime: endObj.toISOString(),
                        role: role || null,
                        status,
                      }),
                    })

                    if (res.ok) {
                      setEditingShift(null)
                      loadShifts()
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
              ✕
            </button>
            <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 16 }}>
              ➕ 新增班次
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
                  <option key={emp.id} value={emp.id}>{emp.user.name}</option>
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
              ✕
            </button>
            <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 8 }}>
              🏖 選擇員工
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
                  {emp.user.name}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// NewShiftTemplateForm — Inline form for creating new shift templates
// ============================================================
function NewShiftTemplateForm({ onCreated }: { onCreated: (tpl: { name: string; startHour: number; startMinute: number; endHour: number; endMinute: number; isNightShift: boolean }) => void }) {
  const [name, setName] = useState('')
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
          onCreated({ name: name.trim(), startHour, startMinute, endHour, endMinute, isNightShift })
          setName('')
        }}
      >新增</button>
    </div>
  )
}
