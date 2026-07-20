'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { fmtDateTime, fmtDate, fmtTime, toHKDateStr } from '@/lib/hk-date'
import { punchLabel, punchColor } from '@/lib/punch-label'
import { Card } from '@/components/ui/card'
import { BackButton } from '@/components/BackButton'

interface PayrollItemData {
  id: string
  runId: string
  employeeId: string
  workedHours: number
  otHours: number
  leaveDays: number
  absentDays: number
  basePay: number
  otPay: number
  splitPay: number | null
  deduction: number
  storeBonus: number
  totalPayable: number
  detailJson: string | null
  run: {
    periodMonth: string
    clinic: { id: string; name: string } | null
  }
  employee: {
    user: { id: string; name: string; phone: string }
    clinics: { clinicId: string; clinic: { name: string } }[]
    payRules: Array<{ payType: string; configJson: string | null }>
  }
}

// Simple collapsible section component (no radix dependency)
function CollapsibleSection({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm font-medium underline cursor-pointer hover:opacity-70 transition-opacity"
        type="button"
      >
        <span className="transition-transform inline-block" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▸
        </span>
        {trigger}
      </button>
      {open && <div className="mt-2 space-y-1">{children}</div>}
    </div>
  )
}

export default function EmployeePayrollDetailPage() {
  const params = useParams()
  const router = useRouter()
  const runId = (params?.id || '') as string
  const empId = (params?.empId || '') as string

  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [leaveBalances, setLeaveBalances] = useState<any[]>([])

  const printRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/payroll-runs/${runId}/employee/${empId}`)
      if (!res.ok) {
        if (res.status === 403) { setForbidden(true); return }
        if (res.status === 404) router.push(`/payroll/${runId}`)
        return
      }
      const d = await res.json()
      setData(d)
    } catch (err) {
      console.error('Failed to fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [runId, empId, router])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Fetch leave balances from API (authentic source — same as 假期管理)
  useEffect(() => {
    if (!empId) return
    fetch(`/api/leave-balance?employeeId=${empId}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { leaveBalances: [] })
      .then(d => setLeaveBalances(d.leaveBalances || []))
      .catch(() => setLeaveBalances([]))
  }, [empId])

  if (loading) {
    return <div className="flex justify-center items-center py-12 text-muted-foreground">載入中...</div>
  }

  if (forbidden) {
    return (
      <div className="flex flex-col justify-center items-center py-12 gap-4">
        <div className="text-4xl">🔒</div>
        <div className="text-lg font-semibold text-muted-foreground">此員工薪資已設保密</div>
        <div className="text-sm text-muted-foreground">僅老闆可查看此員工的薪資明細</div>
        <Link href={`/payroll/${runId}`} className="text-sm text-blue-600 hover:underline">
          返回計糧
        </Link>
      </div>
    )
  }

  if (!data) {
    return <div className="flex justify-center items-center py-12 text-muted-foreground">找不到明細</div>
  }

  const item = data.item as PayrollItemData
  const detail = data.detail || {}
  const punches = data.punches || []
  const leaves = data.leaves || []
  const corrections = data.corrections || []

  const employeeName = item.employee.user.name
  const periodMonth = data.periodMonth ? toHKDateStr(new Date(data.periodMonth)).slice(0, 7) : '-'
  const payType = item.employee.payRules[0]?.payType || '-'

  const fmtCurrency = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtTimeLocal = fmtDateTime

  // Company logo from API
  const companyLogo = data?.item?.run?.clinic?.company?.logoData || null

  // PDF export via html2canvas
  const exportPdf = async () => {
    if (!printRef.current) return
    setExporting(true)
    try {
      const { default: html2canvas } = await import('html2canvas')
      const { jsPDF } = await import('jspdf')

      const canvas = await html2canvas(printRef.current, {
        scale: 2, backgroundColor: '#ffffff',
        onclone: (doc) => {
          doc.querySelectorAll('.no-print').forEach(el => (el as HTMLElement).style.display = 'none')
        },
      })

      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageW = 210, pageH = 297
      const imgH = (canvas.height * pageW) / canvas.width
      let offset = 0
      while (offset < imgH) {
        if (offset > 0) pdf.addPage()
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, -offset, pageW, imgH)
        offset += pageH
      }
      pdf.save(`薪資明細_${employeeName}_${periodMonth}.pdf`)
    } finally {
      setExporting(false)
    }
  }

  // ---- Task 6: Extract comprehensive detail data ----
  const attendanceDetail = detail.attendance || {}
  const salaryDetail = detail.salary || {}
  const leaveAndOtDetail = detail.leaveAndOt || {}
  const timeAccountDetail = leaveAndOtDetail.timeAccountDetail || []

  const scheduledDays = attendanceDetail.expectedWorkDays ?? detail.scheduledDays ?? '-'
  const actualAttendanceDays = attendanceDetail.actualAttendanceDays ?? detail.actualAttendanceDays ?? item.workedHours
  const absentDays = attendanceDetail.absentDays ?? detail.absentDays ?? item.absentDays
  const otDeductedAbsences = (attendanceDetail.otDeductedAbsences as Array<{ date: string; minutes: number }>) || []
  const leaveDays = detail.approvedLeaveDays ?? item.leaveDays
  const lateRecords = (attendanceDetail.lateRecords ?? detail.lateRecords) || []
  const earlyRecords = (attendanceDetail.earlyLeaveRecords ?? detail.earlyLeaveRecords) || []
  const lateDays = lateRecords.length

  // Salary breakdown
  const basePay = salaryDetail.basePay ?? item.basePay
  const deduction = salaryDetail.deduction ?? item.deduction
  const dailyWage = salaryDetail.dailyWage ?? (typeof basePay === 'number' && scheduledDays !== '-' ? basePay / Number(scheduledDays) : 0)
  const attendanceBonus = salaryDetail.attendanceBonus ?? detail.attendanceBonus ?? 0
  const sickDeduction = salaryDetail.sickDeduction ?? detail.sickDeduction ?? 0
  const sickEpisodes = salaryDetail.sickEpisodes ?? detail.sickEpisodes ?? []
  const storeBonus = salaryDetail.storeBonus ?? item.storeBonus ?? 0
  const otPay = salaryDetail.otPay ?? item.otPay
  const allowances = salaryDetail.allowances ?? detail.totalAllowances ?? 0
  const grossPay = salaryDetail.grossPay ?? (basePay - deduction + otPay + ((item.splitPay || 0)) + attendanceBonus + storeBonus + allowances)
  const mpf = salaryDetail.mpf ?? 0
  const netPay = salaryDetail.netPay ?? item.totalPayable

  // Leave & OT
  const monthlyLeaveDays = leaveAndOtDetail.monthlyLeaveDays ?? 0
  const leaveTaken = leaveAndOtDetail.leaveTaken ?? item.leaveDays
  // FIX: 從 leaveBalance 表讀取（與假期管理同源），不再用 detail 中硬編碼的 0
  const restDayBalance = leaveBalances.find(b => b.leaveType?.systemKey === 'REST_DAY')
  const restDayRemaining = restDayBalance?.remaining ?? 0
  const restDayEntitled = restDayBalance?.entitled ?? 0
  const annualBalance = leaveBalances.find(b => b.leaveType?.systemKey === 'ANNUAL_LEAVE')
  const annualRemaining = annualBalance?.remaining ?? 0
  const otBalance = leaveBalances.find(b => b.leaveType?.systemKey === 'OT_LEAVE')
  const otRemaining = otBalance?.remaining ?? 0
  // Total leave balance = sum of all types
  const totalLeaveBalance = restDayRemaining + annualRemaining + otRemaining
  // FIX: 統一資料源 — OT/遲到全部從 detail.timebank 取（計糧引擎算好）
  const tb = detail.timebank || {}
  const otHours = tb.otMinutes != null
    ? tb.otMinutes / 60
    : (leaveAndOtDetail.otHours ?? item.otHours)
  const otConvertedLeave = leaveAndOtDetail.otConvertedLeave ?? 0
  const otRemainderMinutes = leaveAndOtDetail.otRemainderMinutes ?? 0

  // Daily punch/shift summary for collapsible detail
  const fmtTime24 = fmtTime
  const dailyPunchMap: Record<string, { punches: any[]; shiftDate: string }> = {}

  // 1. 正常打卡
  for (const p of punches) {
    const dateKey = toHKDateStr(new Date(p.punchTime))
    if (!dailyPunchMap[dateKey]) dailyPunchMap[dateKey] = { punches: [], shiftDate: dateKey }
    dailyPunchMap[dateKey].punches.push({ ...p, isCorrection: p.source === 'MANUAL_CORRECTION' })
  }

  // 2. 補打卡（corrections）——去重後併入
  for (const c of corrections) {
    const dateKey = toHKDateStr(new Date(c.correctedTime))
    if (!dailyPunchMap[dateKey]) dailyPunchMap[dateKey] = { punches: [], shiftDate: dateKey }
    const exists = dailyPunchMap[dateKey].punches.some((p: any) => p.punchType === c.punchType)
    if (!exists) {
      dailyPunchMap[dateKey].punches.push({
        punchType: c.punchType,
        punchTime: c.correctedTime,
        source: 'MANUAL_CORRECTION',
        isCorrection: true,
      })
    }
  }

  const dailyDetails = Object.entries(dailyPunchMap).map(([date, info]) => {
    const inPunch = info.punches.find((p: any) => p.punchType === 'CLOCK_IN')
    const outPunch = info.punches.find((p: any) => p.punchType === 'CLOCK_OUT')
    const lunchStart = info.punches.find((p: any) => p.punchType === 'LUNCH_START')
    const lunchEnd = info.punches.find((p: any) => p.punchType === 'LUNCH_END')
    const isLate = lateRecords.some((lr: any) => lr.date === date)
    return {
      date,
      punchIn: inPunch ? fmtTime24(inPunch.punchTime) : null,
      punchOut: outPunch ? fmtTime24(outPunch.punchTime) : null,
      lunchStart: lunchStart ? fmtTime24(lunchStart.punchTime) : null,
      lunchEnd: lunchEnd ? fmtTime24(lunchEnd.punchTime) : null,
      inIsCorrection: inPunch?.isCorrection === true,
      outIsCorrection: outPunch?.isCorrection === true,
      status: isLate ? 'late' : 'present',
    }
  })

  return (
    <div className="max-w-4xl mx-auto" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <BackButton to={`/payroll/${runId}`} label="返回計糧" />

      {/* Printable area: logo + title + cards */}
      <div ref={printRef} style={{ position: 'relative' }} className="space-y-6">
        {companyLogo && (
          <img src={companyLogo} alt="logo"
            style={{ position: 'absolute', top: 24, right: 32, width: 96, height: 'auto' }} />
        )}

        {/* Title + Export button */}
        <div>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {employeeName} — {periodMonth} 薪資明細
              </h1>
              <div className="text-sm text-muted-foreground mt-1">
                診所: {item.employee.clinics.map(c => c.clinic.name).join(', ')} | 薪酬: {payType} | 電話: {item.employee.user.phone}
              </div>
            </div>
            <button className="btn btn-primary no-print" onClick={exportPdf} disabled={exporting} type="button">
              {exporting ? '匯出中...' : '📄 匯出 PDF'}
            </button>
          </div>
        </div>

      {/* Main Card */}
      <Card className="p-6 space-y-6">
        {detail.payType === 'HOURLY' ? (
          /* ─── HOURLY simplified detail ─── */
          <div>
            <h3 className="text-lg font-bold">💰 兼職薪資（時薪 ${detail.hourlyRate})</h3>

            {/* Basic attendance summary */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">總有效分鐘</div>
                <div className="text-lg font-bold mt-1">{detail.totalMinutes} 分</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">工作時數</div>
                <div className="text-lg font-bold mt-1">{item.workedHours.toFixed(2)}h</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">缺勤日數</div>
                <div className="text-lg font-bold mt-1 text-red-500">{item.absentDays}</div>
              </div>
            </div>

            <table className="w-full text-sm mt-4">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">日期</th>
                  <th className="text-left p-2">上班</th>
                  <th className="text-left p-2">下班</th>
                  <th className="text-right p-2">有效分鐘</th>
                  <th className="text-right p-2">金額</th>
                </tr>
              </thead>
              <tbody>
                {detail.days.map((d: any) => (
                  <tr key={d.date} className="border-b">
                    <td className="p-2">{d.date}</td>
                    <td className="p-2">
                      {d.note ? (
                        <span className="text-muted-foreground">{d.note}</span>
                      ) : (
                        <>
                          {fmtTime24(d.in)}
                          {d.clamped && (
                            <span className="text-xs text-muted-foreground ml-1">
                              {` (早到, 從排班${fmtTime24(d.shiftStart)}起計)`}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="p-2">{d.note ? '' : fmtTime24(d.out)}</td>
                    <td className="text-right p-2">{d.minutes} 分</td>
                    <td className="text-right p-2 font-medium">${d.amount.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex justify-between items-center mt-4 p-3 bg-muted rounded-lg">
              <span>總計 {detail.totalMinutes} 分鐘</span>
              <strong className="text-lg">實發 ${item.totalPayable.toFixed(2)}</strong>
            </div>

            {Object.keys(detail).length > 0 && (
              <CollapsibleSection trigger="📐 計算參數">
                <pre className="text-xs bg-muted p-4 rounded-lg overflow-x-auto whitespace-pre-wrap font-mono">
                  {JSON.stringify(detail, null, 2)}
                </pre>
              </CollapsibleSection>
            )}
          </div>
        ) : (
          /* ─── MONTHLY full detail ─── */
          <>
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">📅 出勤概況</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">排班日數 (應出勤)</div>
              <div className="text-lg font-bold mt-1">{scheduledDays}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">實際出勤</div>
              <div className="text-lg font-bold mt-1">{actualAttendanceDays}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">缺勤</div>
              <div className="text-lg font-bold mt-1 text-red-500">{absentDays}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">已批假期</div>
              <div className="text-lg font-bold mt-1">{leaveDays}</div>
              {leaves.length > 0 && leaves.length !== leaveDays && (
                <div className="text-xs text-muted-foreground mt-1">
                  排班 {leaves.length} 天，實際消耗 {leaveDays} 天（{leaves.length - leaveDays} 天為週末休息，不計假期）
                </div>
              )}
            </div>
          </div>
          {lateDays > 0 && (
            <div className="mt-2 text-sm text-amber-600">
              ⚠️ 遲到 {lateDays} 天
              {lateRecords.slice(0, 3).map((lr: any, i: number) => (
                <span key={i} className="ml-1">({lr.date} +{lr.minutes}min)</span>
              ))}
              {lateRecords.length > 3 && <span>...+{lateRecords.length - 3}</span>}
            </div>
          )}
          {earlyRecords.length > 0 && (
            <div className="mt-2 text-sm" style={{ color: '#dc2626' }}>
              ⚠️ 早退 {earlyRecords.length} 天
              {earlyRecords.slice(0, 3).map((er: any, i: number) => (
                <span key={i} className="ml-1">（{er.date} −{er.minutes}min）</span>
              ))}
              {earlyRecords.length > 3 && <span>...+{earlyRecords.length - 3}</span>}
            </div>
          )}
          {/* 🔧 Fix #2: 補鐘記錄 */}
          {detail.makeupRecords && detail.makeupRecords.length > 0 && (
            <div className="mt-2 text-sm">
              <span className="font-semibold">🔧 補鐘記錄（{detail.makeupRecords.length} 筆）</span>
              {detail.makeupRecords.map((m: any, i: number) => (
                <div key={i} className="text-muted-foreground ml-4">
                  {m.date}：補鐘 {m.minutes} 分鐘（用OT補遲到/早退）
                  {m.note && <span className="ml-2">— {m.note}</span>}
                </div>
              ))}
            </div>
          )}
          {/* ⏱ 缺勤扣OT鐘 */}
          {otDeductedAbsences.length > 0 && (
            <div className="mt-2 text-sm">
              <span className="font-semibold text-blue-700">⏱ 缺勤扣OT鐘（{otDeductedAbsences.length} 天）</span>
              {otDeductedAbsences.map((a: any, i: number) => (
                <div key={i} className="text-muted-foreground ml-4">
                  {a.date}：扣OT鐘 {a.minutes} 分鐘（不扣工資，仍取消勤工獎）
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 💰 薪資計算 */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">💰 薪資計算</h3>
          <div className="mt-3 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm">基本薪資</span>
              <span className="font-mono font-medium">{fmtCurrency(basePay)}</span>
            </div>

            {absentDays > 0 && (
              <div className="flex justify-between items-center text-red-500">
                <span className="text-sm">
                  缺勤扣款 {absentDays}天 × {fmtCurrency(dailyWage)} (法定日薪)
                </span>
                <span className="font-mono font-medium">-{fmtCurrency(deduction)}</span>
              </div>
            )}

            {otPay > 0 && (
              <div className="flex justify-between items-center text-green-600">
                <span className="text-sm">加班 {otHours.toFixed(2)}h</span>
                <span className="font-mono font-medium">+{fmtCurrency(otPay)}</span>
              </div>
            )}

            {item.splitPay != null && item.splitPay > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-sm">拆帳分潤</span>
                <span className="font-mono font-medium text-purple-500">+{fmtCurrency(item.splitPay)}</span>
              </div>
            )}

            {attendanceBonus !== undefined && (
              <div className="flex justify-between items-center">
                <span className="text-sm">勤工獎</span>
                <span className="font-mono font-medium">
                  {detail.attendanceBonusCancelled ? (
                    <span className="text-red-500">
                      $0（{detail.attendanceBonusReason || '已取消'}）
                    </span>
                  ) : (
                    <span className="text-green-600">+{fmtCurrency(attendanceBonus)}</span>
                  )}
                </span>
              </div>
            )}

            {sickDeduction > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-sm">病假扣減</span>
                <span className="font-mono font-medium text-red-600">
                  -{fmtCurrency(sickDeduction)}
                  <span className="block text-xs text-red-500 font-normal mt-1" style={{ fontFamily: 'sans-serif' }}>
                    {(sickEpisodes || []).map((e: any) =>
                      `${e.range} 共${e.totalDays}天${e.totalDays >= 4 ? '(連續≥4,付4/5)' : '(<4,全扣)'} × 本月${e.daysInMonth}天`
                    ).join('; ')}
                  </span>
                </span>
              </div>
            )}

            {storeBonus > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-sm">店舖獎金</span>
                <span className="font-mono font-medium text-emerald-600">+{fmtCurrency(storeBonus)}</span>
              </div>
            )}

            {allowances > 0 && (
              <div className="flex justify-between items-center text-blue-600">
                <span className="text-sm">津貼</span>
                <span className="font-mono font-medium">+{fmtCurrency(allowances)}</span>
              </div>
            )}

            {/* Gross Pay */}
            <div className="flex justify-between items-center border-t pt-2 mt-2 font-semibold">
              <span>應發 (Gross)</span>
              <span className="font-mono">{fmtCurrency(grossPay)}</span>
            </div>

            {/* MPF */}
            {mpf > 0 && (
              <div className="flex justify-between items-center text-orange-600">
                <span className="text-sm">強積金 (MPF {((salaryDetail.mpfRate ?? 0.05) * 100).toFixed(0)}%) 扣除</span>
                <span className="font-mono font-medium">-{fmtCurrency(mpf)}</span>
              </div>
            )}

            {/* Net Pay */}
            <div className="flex justify-between items-center border-t-2 border-primary pt-3 mt-2 font-bold text-lg">
              <span>實發 (Net Pay)</span>
              <span className="font-mono">{fmtCurrency(netPay)}</span>
            </div>

            {detail.rawTotal !== undefined && detail.rawTotal < 0 && item.totalPayable === 0 && (
              <div className="text-red-500 text-sm">
                ⚠️ 原值 ${detail.rawTotal}（缺勤過多），已歸零
              </div>
            )}
          </div>
        </div>

        {/* 🏖️ 假期與 OT 換假 */}
        {(monthlyLeaveDays > 0 || otConvertedLeave > 0 || totalLeaveBalance > 0) && (
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">🏖️ 假期與 OT 換假</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-3">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">本月應得假期</div>
                <div className="text-lg font-bold mt-1">{monthlyLeaveDays} 天</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">本月已用假期</div>
                <div className="text-lg font-bold mt-1">{leaveTaken} 天</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">假期餘額</div>
                <div className="text-lg font-bold mt-1">{totalLeaveBalance.toFixed(1)} 天</div>
                <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                  {restDayRemaining > 0 && <div>休息日: {restDayRemaining.toFixed(1)} (應得 {restDayEntitled})</div>}
                  {annualRemaining > 0 && <div>年假: {annualRemaining.toFixed(1)}</div>}
                  {otRemaining > 0 && <div>OT 補假: {otRemaining.toFixed(1)}</div>}
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">本月 OT 時數</div>
                <div className="text-lg font-bold mt-1">
                  {(tb.otMinutes ?? 0)} 分鐘（{((tb.otMinutes ?? 0) / 60).toFixed(1)}h）
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">OT 換假</div>
                <div className="text-lg font-bold mt-1">{otConvertedLeave} 天</div>
              </div>
              {otRemainderMinutes > 0 && (
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">OT 餘數</div>
                  <div className="text-lg font-bold mt-1">{otRemainderMinutes}min</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 考勤與時間銀行 */}
        {tb.otMinutes != null && (
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">🕐 考勤與時間銀行</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3">
              {/* 本月遲到 */}
              <div className="rounded-lg border p-3" style={tb.lateCount > 0 ? { borderLeft: '3px solid #f59e0b' } : {}}>
                <div className="text-xs text-muted-foreground">本月遲到</div>
                <div className="text-lg font-bold mt-1" style={{ color: tb.lateCount > 0 ? '#d97706' : 'inherit' }}>
                  {tb.lateCount} 次 / 淨 {tb.netLateMinutes ?? Math.max(0, (tb.lateMinutes ?? 0) - (tb.makeupMinutes ?? 0))} 分鐘
                </div>
              </div>
              {/* 本月早退 */}
              <div className="rounded-lg border p-3" style={(tb.earlyLeaveCount ?? 0) > 0 ? { borderLeft: '3px solid #dc2626' } : {}}>
                <div className="text-xs text-muted-foreground">本月早退</div>
                <div className="text-lg font-bold mt-1" style={{ color: (tb.netEarlyMinutes ?? 0) > 0 ? '#dc2626' : 'inherit' }}>
                  {tb.earlyLeaveCount ?? 0} 次 / 淨 {tb.netEarlyMinutes ?? 0} 分鐘
                </div>
              </div>
              {/* 本月 OT */}
              <div className="rounded-lg border p-3" style={{ borderLeft: '3px solid #16a34a' }}>
                <div className="text-xs text-muted-foreground">本月 OT</div>
                <div className="text-lg font-bold mt-1" style={{ color: '#16a34a' }}>
                  {(tb.otMinutes ?? 0)} 分鐘
                </div>
              </div>
              {/* 時間帳戶 — 取代 OT剩餘+拖欠 兩卡 */}
              {(() => {
                const timeAccount = tb.timeAccountMinutes ?? (tb.balance ?? (tb.availableMinutes ?? 0) - (tb.owedMinutes ?? 0))
                return (
                  <div className="rounded-lg border p-3" style={{
                    borderColor: timeAccount >= 0 ? '#10b981' : '#dc2626',
                    borderWidth: 2,
                  }}>
                    <div className="text-xs text-muted-foreground">時間帳戶</div>
                    <div className="text-xl font-bold mt-1" style={{ color: timeAccount >= 0 ? '#059669' : '#dc2626' }}>
                      {timeAccount >= 0 ? '+' : '−'}{Math.abs(timeAccount)} 分鐘
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {timeAccount > 0 && `可換假 ${Math.floor(timeAccount / 540)} 天（餘 ${timeAccount % 540} 分）`}
                      {timeAccount < 0 && <>
                        拖欠公司，之後 OT 自動償還
                        <br />
                        <span className="text-red-600" style={{ fontSize: 12 }}>拖欠 {Math.abs(timeAccount)} 分鐘（約 {(Math.abs(timeAccount) / 540).toFixed(1)} 日）</span>
                      </>}
                      {timeAccount === 0 && '兩清'}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        )}

        {/* 📊 工時統計 (secondary) */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">📊 工時統計</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">工作時數</div>
              <div className="text-lg font-bold mt-1">{item.workedHours.toFixed(2)}h</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">加班時數</div>
              <div className="text-lg font-bold mt-1">{(tb.otMinutes ?? 0)} 分鐘（{((tb.otMinutes ?? 0) / 60).toFixed(1)}h）</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">淨遲到時數</div>
              <div className="text-lg font-bold mt-1" style={{ color: (tb.netLateMinutes ?? Math.max(0, (tb.lateMinutes ?? 0) - (tb.makeupMinutes ?? 0))) > 0 ? '#f59e0b' : 'inherit' }}>
                {tb.netLateMinutes ?? Math.max(0, (tb.lateMinutes ?? 0) - (tb.makeupMinutes ?? 0))} 分鐘（{(((tb.netLateMinutes ?? Math.max(0, (tb.lateMinutes ?? 0) - (tb.makeupMinutes ?? 0))) / 60)).toFixed(1)}h）
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">缺勤日數</div>
              <div className="text-lg font-bold mt-1 text-red-500">{item.absentDays.toFixed(2)} 天</div>
            </div>
          </div>
        </div>

        {/* ⏱ 時間帳戶明細 */}
        {timeAccountDetail.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">⏱ 時間帳戶明細</h3>
            <div className="rounded-xl border shadow-card p-4 mt-3">
              {/* Desktop table */}
              <div className="hidden md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground border-b">
                      <th className="text-left py-2">日期</th>
                      <th className="text-right">類型</th>
                      <th className="text-right">分鐘</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timeAccountDetail.flatMap((d: any) => {
                      const rows = []
                      if (d.lateMinutes) rows.push({ date: d.date, label: '上班遲到', min: -d.lateMinutes, color: '#dc2626' })
                      if (d.earlyMinutes) rows.push({ date: d.date, label: '早退', min: -d.earlyMinutes, color: '#dc2626' })
                      if (d.clockOutOt) rows.push({ date: d.date, label: '下班 OT', min: d.clockOutOt, color: '#059669' })
                      if (d.lunchOt) rows.push({ date: d.date, label: '午休 OT（少休）', min: d.lunchOt, color: '#059669' })
                      if (d.lunchLate) rows.push({ date: d.date, label: '午休遲到（超休）', min: -d.lunchLate, color: '#dc2626' })
                      return rows
                    }).map((r: any, i: number) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-2">{r.date}</td>
                        <td className="text-right">{r.label}</td>
                        <td className="text-right font-medium" style={{ color: r.color }}>
                          {r.min > 0 ? '+' : ''}{r.min} 分</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile card view */}
              <div className="md:hidden space-y-2">
                {timeAccountDetail.flatMap((d: any) => {
                  const rows = []
                  if (d.lateMinutes) rows.push({ date: d.date, label: '上班遲到', min: -d.lateMinutes, color: '#dc2626' })
                  if (d.earlyMinutes) rows.push({ date: d.date, label: '早退', min: -d.earlyMinutes, color: '#dc2626' })
                  if (d.clockOutOt) rows.push({ date: d.date, label: '下班 OT', min: d.clockOutOt, color: '#059669' })
                  if (d.lunchOt) rows.push({ date: d.date, label: '午休 OT（少休）', min: d.lunchOt, color: '#059669' })
                  if (d.lunchLate) rows.push({ date: d.date, label: '午休遲到（超休）', min: -d.lunchLate, color: '#dc2626' })
                  return rows
                }).map((r: any, i: number) => (
                  <div key={i} className="flex justify-between text-sm p-2 bg-muted/50 rounded">
                    <span>{r.date} {r.label}</span>
                    <span className="font-medium" style={{ color: r.color }}>
                      {r.min > 0 ? '+' : ''}{r.min} 分
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 🔍 每日明細（可摺疊） */}
        {dailyDetails.length > 0 && (
          <CollapsibleSection trigger="🔍 每日打卡明細">
            <div className="rounded-lg border">
              <div className="grid grid-cols-16 gap-2 px-4 py-2 bg-muted/50 text-xs font-semibold text-muted-foreground">
                <div className="col-span-2">日期</div>
                <div className="col-span-2">上工</div>
                <div className="col-span-2">午休開始</div>
                <div className="col-span-2">午休結束</div>
                <div className="col-span-2">落班</div>
                <div className="col-span-6 text-right">狀態</div>
              </div>
              {dailyDetails.map((day: any) => (
                <div key={day.date} className="grid grid-cols-16 gap-2 px-4 py-2 text-sm border-t hover:bg-muted/30">
                  <div className="col-span-2">{day.date}</div>
                  <div className="col-span-2">
                    {day.punchIn || '—'}
                    {day.inIsCorrection && <span className="ml-1 text-xs text-blue-600">（補登）</span>}
                  </div>
                  <div className="col-span-2">{day.lunchStart || '—'}</div>
                  <div className="col-span-2">{day.lunchEnd || '—'}</div>
                  <div className="col-span-2">
                    {day.punchOut || '—'}
                    {day.outIsCorrection && <span className="ml-1 text-xs text-blue-600">（補登）</span>}
                  </div>
                  <div className="col-span-6 text-right">
                    {day.status === 'absent' ? '✗ 缺勤' : day.status === 'late' ? '⚠ 遲到' : '✓ 出勤'}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* 📐 計算參數（可摺疊） */}
        {Object.keys(detail).length > 0 && (
          <CollapsibleSection trigger="📐 計算參數">
            <pre className="text-xs bg-muted p-4 rounded-lg overflow-x-auto whitespace-pre-wrap font-mono">
              {JSON.stringify(detail, null, 2)}
            </pre>
          </CollapsibleSection>
        )}
        </>
        )}
      </Card>

      {/* Punch Records Table */}
      {punches.length > 0 && (
        <Card className="p-6">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            📋 打卡記錄 ({punches.length} 筆)
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2">
                  <th className="text-left py-2 px-2">日期</th>
                  <th className="text-left py-2 px-2">診所</th>
                  <th className="text-left py-2 px-2">時間</th>
                  <th className="text-left py-2 px-2">類型</th>
                  <th className="text-left py-2 px-2">來源</th>
                </tr>
              </thead>
              <tbody>
                {punches.map((p: any) => (
                  <tr key={p.id} className="border-b">
                    <td className="py-2 px-2">{fmtDate(p.punchTime)}</td>
                    <td className="py-2 px-2">{p.clinicId}</td>
                    <td className="py-2 px-2">{fmtTimeLocal(p.punchTime)}</td>
                    <td className="py-2 px-2">
                      <span className={punchColor(p.punchType) + ' font-semibold'}>
                        {punchLabel(p.punchType)}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-xs text-muted-foreground">{p.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Leave Records Table */}
      {leaves.length > 0 && (
        <Card className="p-6">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            🏖️ 已批假期 ({leaves.length} 筆)
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2">
                  <th className="text-left py-2 px-2">假期類型</th>
                  <th className="text-left py-2 px-2">開始</th>
                  <th className="text-left py-2 px-2">結束</th>
                  <th className="text-right py-2 px-2">天數</th>
                  <th className="text-left py-2 px-2">有薪</th>
                </tr>
              </thead>
              <tbody>
                {leaves.map((l: any) => (
                  <tr key={l.id} className="border-b">
                    <td className="py-2 px-2">{l.leaveType.name}</td>
                    <td className="py-2 px-2">{fmtDate(l.startDate)}</td>
                    <td className="py-2 px-2">{fmtDate(l.endDate)}</td>
                    <td className="py-2 px-2 text-right">{l.days}</td>
                    <td className="py-2 px-2">
                      <span className={l.leaveType.isPaid ? 'text-green-600' : 'text-red-500'}>
                        {l.leaveType.isPaid ? '有薪' : '無薪'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Corrections Table */}
      {corrections.length > 0 && (
        <Card className="p-6">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            ✏️ 考勤補登 ({corrections.length} 筆)
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2">
                  <th className="text-left py-2 px-2">補登時間</th>
                  <th className="text-left py-2 px-2">診所</th>
                  <th className="text-left py-2 px-2">類型</th>
                  <th className="text-left py-2 px-2">原因</th>
                </tr>
              </thead>
              <tbody>
                {corrections.map((c: any) => (
                  <tr key={c.id} className="border-b">
                    <td className="py-2 px-2">{fmtDateTime(c.correctedTime)}</td>
                    <td className="py-2 px-2">{c.clinicId}</td>
                    <td className="py-2 px-2">
                      {punchLabel(c.punchType)}
                    </td>
                    <td className="py-2 px-2 text-xs text-muted-foreground">{c.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      </div>
    </div>
  )
}
