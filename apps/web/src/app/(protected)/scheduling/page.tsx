'use client'

import { useEffect, useState, useCallback, useRef } from 'react'

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
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [showChangePanel, setShowChangePanel] = useState(false)
  const [editingShift, setEditingShift] = useState<Shift | null>(null)
  const [showNewShiftModal, setShowNewShiftModal] = useState(false)

  // Drag and drop state
  const dragData = useRef<{ employeeId: string; templateId: string } | null>(null)

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

  // ============================================================
  // Load shifts for current view
  // ============================================================
  const loadShifts = useCallback(async () => {
    if (!selectedClinicId) return

    const { startDate, endDate } = getDateRange()
    const url = `/api/shifts?clinicId=${selectedClinicId}&startDate=${startDate}&endDate=${endDate}&pageSize=500`

    try {
      const res = await fetch(url, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setShifts(data.shifts || [])
      }
    } catch (error) {
      console.error('Failed to load shifts:', error)
    }
  }, [selectedClinicId, currentDate, viewMode])

  useEffect(() => {
    loadShifts()
  }, [loadShifts])

  // ============================================================
  // Date Helpers
  // ============================================================
  const getDateRange = (): { startDate: string; endDate: string } => {
    const date = new Date(currentDate)
    if (viewMode === 'week') {
      const day = date.getDay()
      const diff = date.getDate() - day + (day === 0 ? -6 : 1) // Monday
      const start = new Date(date.setDate(diff))
      const end = new Date(start)
      end.setDate(start.getDate() + 6)
      return {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
      }
    } else {
      const start = new Date(date.getFullYear(), date.getMonth(), 1)
      const end = new Date(date.getFullYear(), date.getMonth() + 1, 0)
      return {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
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
    return date.toISOString().split('T')[0]
  }

  const formatDateLabel = (date: Date): string => {
    const dayNames = ['日', '一', '二', '三', '四', '五', '六']
    return `${date.getMonth() + 1}/${date.getDate()} 周${dayNames[date.getDay()]}`
  }

  const navigateDate = (direction: number) => {
    const newDate = new Date(currentDate)
    if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() + direction * 7)
    } else {
      newDate.setMonth(newDate.getMonth() + direction)
    }
    setCurrentDate(newDate)
  }

  // ============================================================
  // Shift Operations
  // ============================================================
  const getShiftForCell = (employeeId: string, dateStr: string): Shift | undefined => {
    return shifts.find(
      s => s.employeeId === employeeId && formatDate(new Date(s.date)) === dateStr
    )
  }

  const createShift = async (employeeId: string, date: string, template: ShiftTemplate) => {
    if (!selectedClinicId) return

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
    const validationResult = await validateBeforeCreate(employeeId, startTime.toISOString(), endTime.toISOString())
    if (!validationResult.valid) {
      setValidationIssues([
        ...validationResult.errors.map((e: any) => ({ type: 'error' as const, rule: e.rule, message: e.message })),
        ...validationResult.warnings.map((w: any) => ({ type: 'warning' as const, rule: w.rule, message: w.message })),
      ])
      if (validationResult.errors.length > 0) return // Block on errors
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
        loadShifts()
      } else {
        const err = await res.json()
        setValidationIssues([{ type: 'error', rule: 'api', message: err.error || 'Create failed' }])
      }
    } catch (error) {
      console.error('Create shift error:', error)
    }
  }

  const validateBeforeCreate = async (employeeId: string, startTime: string, endTime: string): Promise<any> => {
    try {
      const res = await fetch('/api/shifts/validate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shift: {
            employeeId,
            clinicId: selectedClinicId,
            date: formatDate(currentDate),
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
    if (!confirm('確定刪除此班次？')) return

    try {
      const res = await fetch(`/api/shifts/${shiftId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        loadShifts()
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
        loadShifts()
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
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = async (e: React.DragEvent, employeeId: string, dateStr: string) => {
    e.preventDefault()
    if (!selectedTemplate) {
      alert('請先選擇更次模板')
      return
    }

    await createShift(employeeId, dateStr, selectedTemplate)
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

  // ============================================================
  // Render Helpers
  // ============================================================
  const formatTimeFromShift = (isoString: string): string => {
    const d = new Date(isoString)
    return d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  const canManage = userRole === 'OWNER' || userRole === 'MANAGER'
  const isCanRead = userRole === 'OWNER' || userRole === 'MANAGER' || userRole === 'ACCOUNTANT' || userRole === 'EMPLOYEE'

  // ============================================================
  // Loading State
  // ============================================================
  if (loading) {
    return <div style={{ padding: 24 }}>載入中...</div>
  }

  const dates = getDates()
  const clinicEmployees = getClinicEmployees()
  const excludeEmployeeId = editingShift?.employeeId || ''
  const availableEmployees = clinicEmployees.filter((e: Employee) => e.id !== excludeEmployeeId)

  // ============================================================
  // Render
  // ============================================================
  return (
    <div>
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

          {/* View mode toggle */}
          <div style={{ display: 'flex', border: '1px solid #ddd', borderRadius: 6, overflow: 'hidden' }}>
            <button
              onClick={() => setViewMode('week')}
              style={{
                padding: '6px 14px',
                border: 'none',
                background: viewMode === 'week' ? '#1a1a2e' : 'white',
                color: viewMode === 'week' ? 'white' : '#333',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              週
            </button>
            <button
              onClick={() => setViewMode('month')}
              style={{
                padding: '6px 14px',
                border: 'none',
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                background: viewMode === 'month' ? '#1a1a2e' : 'white',
                color: viewMode === 'month' ? 'white' : '#333',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              月
            </button>
          </div>

          {/* Date navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => navigateDate(-1)} style={{
              padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6,
              background: 'white', cursor: 'pointer', fontSize: 14,
            }}>◀</button>
            <span style={{ fontSize: 14, minWidth: 120, textAlign: 'center' }}>
              {viewMode === 'week'
                ? `${formatDate(new Date(dates[0]?.toISOString()))} ~ ${formatDate(new Date(dates[dates.length - 1]?.toISOString()))}`
                : `${currentDate.getFullYear()}年${currentDate.getMonth() + 1}月`
              }
            </span>
            <button onClick={() => navigateDate(1)} style={{
              padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6,
              background: 'white', cursor: 'pointer', fontSize: 14,
            }}>▶</button>
          </div>

          {/* Today button */}
          <button
            onClick={() => setCurrentDate(new Date())}
            style={{
              padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6,
              background: 'white', cursor: 'pointer', fontSize: 12,
            }}
          >
            今天
          </button>

          {/* Change requests button */}
          <button
            onClick={() => setShowChangePanel(!showChangePanel)}
            style={{
              padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6,
              background: showChangePanel ? '#1a1a2e' : 'white',
              color: showChangePanel ? 'white' : '#333',
              cursor: 'pointer', fontSize: 12,
              position: 'relative',
            }}
          >
            🔄 換更申請
            {changeRequests.filter(r => r.status === 'PENDING').length > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -6,
                background: '#dc3545', color: 'white',
                borderRadius: '50%', width: 18, height: 18,
                fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {changeRequests.filter(r => r.status === 'PENDING').length}
              </span>
            )}
          </button>
        </div>
      </div>

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

      {/* Template Selector (for managers) */}
      {canManage && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>更次模板：</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {templates.map(tpl => (
                <button
                  key={tpl.id}
                  onClick={() => setSelectedTemplate(tpl)}
                  style={{
                    padding: '6px 14px',
                    border: selectedTemplate?.id === tpl.id ? '2px solid #1a1a2e' : '1px solid #ddd',
                    borderRadius: 20,
                    background: selectedTemplate?.id === tpl.id ? '#e8e8ff' : 'white',
                    cursor: 'pointer',
                    fontSize: 13,
                    transition: 'all 0.2s',
                  }}
                >
                  {tpl.name}
                  <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>
                    {String(tpl.startHour).padStart(2, '0')}:{String(tpl.startMinute).padStart(2, '0')}
                    -
                    {String(tpl.endHour).padStart(2, '0')}:{String(tpl.endMinute).padStart(2, '0')}
                  </span>
                </button>
              ))}
            </div>

            {selectedTemplate && (
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button
                  onClick={bulkApplyTemplate}
                  className="btn btn-primary btn-sm"
                >
                  📋 批量套用整個{viewMode === 'week' ? '週' : '月'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Schedule Grid */}
      <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
        <div style={{ minWidth: Math.max(600, dates.length * 100 + 160) }}>
          {/* Date Header Row */}
          <div style={{
            display: 'flex', borderBottom: '2px solid #eee',
            position: 'sticky', top: 0, background: 'white', zIndex: 10,
          }}>
            <div style={{
              width: 150, minWidth: 150, padding: '12px 16px',
              fontWeight: 600, fontSize: 13, color: '#555',
              borderRight: '1px solid #eee',
            }}>
              員工
            </div>
            {dates.map((date, i) => {
              const isToday = formatDate(date) === formatDate(new Date())
              return (
                <div key={i} style={{
                  flex: 1, minWidth: 90, padding: '10px 8px',
                  textAlign: 'center', fontSize: 12,
                  borderRight: '1px solid #f0f0f0',
                  background: isToday ? '#e8f5e9' : 'transparent',
                  fontWeight: isToday ? 600 : 400,
                  color: isToday ? '#2e7d32' : '#555',
                }}>
                  <div>{formatDateLabel(date)}</div>
                  <div style={{ fontSize: 11, color: '#aaa' }}>
                    {date.getMonth() + 1}/{date.getDate()}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Employee Rows */}
          {clinicEmployees.map(emp => (
            <div key={emp.id} style={{ display: 'flex', borderBottom: '1px solid #f5f5f5' }}>
              {/* Employee Name */}
              <div style={{
                width: 150, minWidth: 150, padding: '10px 16px',
                borderRight: '1px solid #eee',
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {emp.user.name}
                </div>
                <div style={{ fontSize: 11, color: '#aaa' }}>
                  {emp.user.phone}
                </div>
                {/* Draggable employee chip (for managers) */}
                {canManage && selectedTemplate && (
                  <div
                    draggable
                    onDragStart={e => handleDragStart(e, emp.id)}
                    style={{
                      marginTop: 4,
                      padding: '2px 8px',
                      background: '#e8e8ff',
                      borderRadius: 10,
                      fontSize: 10,
                      color: '#5c6bc0',
                      cursor: 'grab',
                      alignSelf: 'flex-start',
                    }}
                  >
                    ✋ 拖放排班
                  </div>
                )}
              </div>

              {/* Date Cells */}
              {dates.map((date, i) => {
                const dateStr = formatDate(date)
                const shift = getShiftForCell(emp.id, dateStr)
                const isToday = formatDate(date) === formatDate(new Date())

                return (
                  <div
                    key={i}
                    style={{
                      flex: 1, minWidth: 90, padding: 6,
                      borderRight: '1px solid #f0f0f0',
                      background: isToday ? '#f9fff9' : 'transparent',
                      minHeight: 56,
                    }}
                    onDragOver={canManage ? handleDragOver : undefined}
                    onDrop={canManage ? (e) => handleDrop(e, emp.id, dateStr) : undefined}
                  >
                    {shift && (
                      <div
                        style={{
                          padding: '4px 8px',
                          background: shift.status === 'CONFIRMED' ? '#e3f2fd' :
                            shift.status === 'DRAFT' ? '#fff3e0' :
                              shift.status === 'CANCELLED' ? '#fde8e8' : '#e8f5e9',
                          borderRadius: 4,
                          fontSize: 11,
                          cursor: canManage ? 'pointer' : 'default',
                          borderLeft: `3px solid ${shift.status === 'CONFIRMED' ? '#1976d2' :
                              shift.status === 'DRAFT' ? '#f57c00' :
                                shift.status === 'CANCELLED' ? '#dc3545' : '#388e3c'
                            }`,
                        }}
                        onClick={() => canManage && setEditingShift(shift)}
                        title={`點擊${canManage ? '編輯' : '查看'}班次詳情`}
                      >
                        <div style={{ fontWeight: 500 }}>
                          {formatTimeFromShift(shift.startTime)}-{formatTimeFromShift(shift.endTime)}
                        </div>
                        {shift.role && <div style={{ color: '#888' }}>{shift.role}</div>}
                        {shift.template?.name && (
                          <div style={{ color: '#aaa', fontSize: 10 }}>{shift.template.name}</div>
                        )}
                        {canManage && (
                          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                            {isCanRead && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation()
                                  setEditingShift(shift)
                                  setShowChangePanel(true)
                                }}
                                style={{
                                  background: 'none', border: 'none', cursor: 'pointer',
                                  fontSize: 10, color: '#5c6bc0', padding: 0,
                                }}
                                title="發起換更申請"
                              >
                                🔄
                              </button>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                deleteShift(shift.id)
                              }}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                fontSize: 10, color: '#dc3545', padding: 0,
                              }}
                              title="刪除班次"
                            >
                              🗑
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {/* Empty state */}
          {clinicEmployees.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: '#aaa' }}>
              {selectedClinicId ? '該診所暫無員工' : '請選擇診所'}
            </div>
          )}
        </div>
      </div>

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
        <div className="card" style={{ marginTop: 16 }}>
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
                          <span style={{
                            padding: '2px 8px',
                            background: statusColors[req.status] || '#888',
                            color: 'white',
                            borderRadius: 4,
                            fontSize: 11,
                          }}>
                            {statusLabels[req.status] || req.status}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 500 }}>
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
            className="card"
            style={{ width: 400, maxWidth: '90vw', position: 'relative' }}
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
    </div>
  )
}
