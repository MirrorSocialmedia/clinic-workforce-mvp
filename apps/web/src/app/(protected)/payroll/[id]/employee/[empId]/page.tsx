'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
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
  const runId = params.id as string
  const empId = params.empId as string

  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/payroll-runs/${runId}/employee/${empId}`)
      if (!res.ok) {
        if (res.status === 404) router.push(`/payroll/${runId}`)
        return
      }
      setData(await res.json())
    } catch (err) {
      console.error('Failed to fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [runId, empId, router])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return <div className="flex justify-center items-center py-12 text-muted-foreground">載入中...</div>
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
  const periodMonth = data.periodMonth || '-'
  const payType = item.employee.payRules[0]?.payType || '-'

  const fmtCurrency = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtTime = (d: Date | string) => new Date(d).toLocaleString('zh-HK')

  // ---- Task 6: Extract comprehensive detail data ----
  const attendanceDetail = detail.attendance || {}
  const salaryDetail = detail.salary || {}
  const leaveAndOtDetail = detail.leaveAndOt || {}

  const scheduledDays = attendanceDetail.expectedWorkDays ?? detail.scheduledDays ?? '-'
  const actualAttendanceDays = attendanceDetail.actualAttendanceDays ?? detail.actualAttendanceDays ?? item.workedHours
  const absentDays = attendanceDetail.absentDays ?? detail.absentDays ?? item.absentDays
  const leaveDays = detail.approvedLeaveDays ?? item.leaveDays
  const lateRecords = (attendanceDetail.lateRecords ?? detail.lateRecords) || []
  const lateDays = lateRecords.length

  // Salary breakdown
  const basePay = salaryDetail.basePay ?? item.basePay
  const deduction = salaryDetail.deduction ?? item.deduction
  const dailyWage = salaryDetail.dailyWage ?? (typeof basePay === 'number' && scheduledDays !== '-' ? basePay / Number(scheduledDays) : 0)
  const attendanceBonus = salaryDetail.attendanceBonus ?? detail.attendanceBonus ?? 0
  const otPay = salaryDetail.otPay ?? item.otPay
  const allowances = salaryDetail.allowances ?? detail.totalAllowances ?? 0
  const grossPay = salaryDetail.grossPay ?? (basePay - deduction + otPay + ((item.splitPay || 0)) + attendanceBonus + allowances)
  const mpf = salaryDetail.mpf ?? 0
  const netPay = salaryDetail.netPay ?? item.totalPayable

  // Leave & OT
  const monthlyLeaveDays = leaveAndOtDetail.monthlyLeaveDays ?? 0
  const leaveTaken = leaveAndOtDetail.leaveTaken ?? item.leaveDays
  const leaveBalance = leaveAndOtDetail.leaveBalance ?? 0
  const otHours = leaveAndOtDetail.otHours ?? item.otHours
  const otConvertedLeave = leaveAndOtDetail.otConvertedLeave ?? 0
  const otRemainderMinutes = leaveAndOtDetail.otRemainderMinutes ?? 0

  // Daily punch/shift summary for collapsible detail
  const dailyPunchMap: Record<string, { punches: typeof punches; shiftDate: string }> = {}
  for (const p of punches) {
    const dateKey = new Date(p.punchTime).toLocaleDateString('en-CA')
    if (!dailyPunchMap[dateKey]) dailyPunchMap[dateKey] = { punches: [], shiftDate: dateKey }
    dailyPunchMap[dateKey].punches.push(p)
  }
  const dailyDetails = Object.entries(dailyPunchMap).map(([date, info]) => {
    const inPunch = info.punches.find((p: any) => p.punchType === 'CLOCK_IN')
    const outPunch = info.punches.find((p: any) => p.punchType === 'CLOCK_OUT')
    const isLate = lateRecords.some((lr: any) => lr.date === date)
    return {
      date,
      punchIn: inPunch ? new Date(inPunch.punchTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false }) : null,
      punchOut: outPunch ? new Date(outPunch.punchTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false }) : null,
      status: isLate ? 'late' : 'present',
    }
  })

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <BackButton to={`/payroll/${runId}`} label="返回計糧" />
        <h1 className="text-2xl font-bold tracking-tight mt-2">
          {employeeName} — {periodMonth} 薪資明細
        </h1>
        <div className="text-sm text-muted-foreground mt-1">
          診所: {item.employee.clinics.map(c => c.clinic.name).join(', ')} | 薪酬: {payType} | 電話: {item.employee.user.phone}
        </div>
      </div>

      {/* Main Card */}
      <Card className="p-6 space-y-6">
        {/* 📅 出勤概況 */}
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
                <span className="text-sm">加班 {item.otHours}h</span>
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
                <span className="text-sm">強積金 (MPF) 扣除</span>
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
        {(monthlyLeaveDays > 0 || otConvertedLeave > 0 || leaveBalance > 0) && (
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
                <div className="text-lg font-bold mt-1">{leaveBalance} 天</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">本月 OT 時數</div>
                <div className="text-lg font-bold mt-1">{otHours.toFixed(2)}h</div>
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
              <div className="text-lg font-bold mt-1">{item.otHours.toFixed(2)}h</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">請假日數</div>
              <div className="text-lg font-bold mt-1">{item.leaveDays.toFixed(2)} 天</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">缺勤日數</div>
              <div className="text-lg font-bold mt-1 text-red-500">{item.absentDays.toFixed(2)} 天</div>
            </div>
          </div>
        </div>

        {/* 🔍 每日明細（可摺疊） */}
        {dailyDetails.length > 0 && (
          <CollapsibleSection trigger="🔍 每日打卡明細">
            <div className="rounded-lg border">
              <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-muted/50 text-xs font-semibold text-muted-foreground">
                <div className="col-span-2">日期</div>
                <div className="col-span-3">上班</div>
                <div className="col-span-3">下班</div>
                <div className="col-span-4 text-right">狀態</div>
              </div>
              {dailyDetails.map((day: any) => (
                <div key={day.date} className="grid grid-cols-12 gap-2 px-4 py-2 text-sm border-t hover:bg-muted/30">
                  <div className="col-span-2">{day.date}</div>
                  <div className="col-span-3">{day.punchIn || '—'}</div>
                  <div className="col-span-3">{day.punchOut || '—'}</div>
                  <div className="col-span-4 text-right">
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
                    <td className="py-2 px-2">{new Date(p.punchTime).toLocaleDateString('zh-HK')}</td>
                    <td className="py-2 px-2">{p.clinicId}</td>
                    <td className="py-2 px-2">{fmtTime(p.punchTime)}</td>
                    <td className="py-2 px-2">
                      <span className={p.punchType === 'CLOCK_IN' ? 'text-green-600 font-semibold' : 'text-red-500 font-semibold'}>
                        {p.punchType === 'CLOCK_IN' ? '上班' : '下班'}
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
                    <td className="py-2 px-2">{new Date(l.startDate).toLocaleDateString('zh-HK')}</td>
                    <td className="py-2 px-2">{new Date(l.endDate).toLocaleDateString('zh-HK')}</td>
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
                    <td className="py-2 px-2">{fmtTime(c.correctedTime)}</td>
                    <td className="py-2 px-2">{c.clinicId}</td>
                    <td className="py-2 px-2">
                      {c.punchType === 'CLOCK_IN' ? '上班' : '下班'}
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
  )
}
