'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { BackButton } from '@/components/BackButton'
import { User, Printer, Eye } from 'lucide-react'
import { fmtDate } from '@/lib/hk-date'
import { hasPermission } from '@/lib/permissions'
import { zeroEntitledHint } from '@/lib/leave-types'

const api = (url: string, init?: RequestInit) =>
  fetch(url, { credentials: 'include', cache: 'no-store', ...init })

export default function EmployeeOverviewPage() {
  const params = useParams()
  const router = useRouter()
  const empId = (params?.id || '') as string

  // Basic data (fast)
  const [basic, setBasic] = useState<any>(null)
  const [payRules, setPayRules] = useState<any>(null)
  const [leaveBalances, setLeaveBalances] = useState<any[]>([])
  const [timeAccount, setTimeAccount] = useState<any>(null)
  const [adw, setAdw] = useState<any>(null)
  const [effectiveADW, setEffectiveADW] = useState<any>(null)
  const [deductionDailyRate, setDeductionDailyRate] = useState<number>(0)

  // History data (slow)
  const [history, setHistory] = useState<any>(null)
  const [historyLoading, setHistoryLoading] = useState(true)

  // Resign preview
  const [showResignPreview, setShowResignPreview] = useState(false)
  const [resignPreview, setResignPreview] = useState<any>(null)
  const [resignLoading, setResignLoading] = useState(false)

  const [userRole, setUserRole] = useState<string>('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchBasic = useCallback(async () => {
    try {
      const res = await api(`/api/employees/${empId}/overview`)
      if (!res.ok) {
        if (res.status === 403) {
          setError('此員工薪資已設保密，只有 Owner 可以查看')
          return
        }
        if (res.status === 404) {
          setError('找不到員工')
          return
        }
        return
      }
      const data = await res.json()
      setBasic(data.basic)
      setPayRules(data.payRules)
      setLeaveBalances(data.leaveBalances)
      setTimeAccount(data.timeAccount)
      setAdw(data.adw)
      setEffectiveADW(data.effectiveADW)
      setDeductionDailyRate(data.deductionDailyRate)
    } catch (err) {
      console.error('Failed to fetch basic data:', err)
    } finally {
      setLoading(false)
    }
  }, [empId])

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await api(`/api/employees/${empId}/overview/history?months=12`)
      if (!res.ok) return
      const data = await res.json()
      setHistory(data)
    } catch (err) {
      console.error('Failed to fetch history:', err)
    } finally {
      setHistoryLoading(false)
    }
  }, [empId])

  useEffect(() => {
    fetchBasic()
    fetchHistory()
    api('/api/me').then(async r => {
      if (!r.ok) return { user: { role: '', grant: [], deny: [] } }
      const d = await r.json()
      setUserRole(d.user?.role || '')
      setGrant(d.user?.grant || [])
      setDeny(d.user?.deny || [])
    })
  }, [fetchBasic, fetchHistory])

  const fmtCurrency = (v: number | null | undefined) => {
    if (v == null || v === 0) return '-'
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  // ★ 權限可以覆蓋 role 白名單（同 layout.tsx 的 nav filter 一致）——
  //   舊版硬編碼白名單，令有 employee_overview 的 EMPLOYEE 被前端擋住（API 已經通）
  //   ACCOUNTANT 刻意剔走（2026-08-03 決定側欄只有 OWNER + MANAGER）
  const canView =
    ['OWNER', 'MANAGER'].includes(userRole) /* ROLE-OK: 同上 */ ||
    hasPermission(userRole as any, 'employee_overview', grant, deny)

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <BackButton to="/employees" label="返回員工總覽" />
        <div style={{ textAlign: 'center', padding: 60, color: '#dc3545', fontSize: 16 }}>
          {error}
        </div>
      </div>
    )
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>載入中...</div>
  }

  if (!canView) {
    return (
      <div style={{ padding: 24 }}>
        <BackButton to="/employees" label="返回員工總覽" />
        <div style={{ textAlign: 'center', padding: 60, color: '#dc3545', fontSize: 16 }}>
          無權查看 — 需要「員工總覽」權限
        </div>
      </div>
    )
  }

  const payTypeLabels: Record<string, string> = {
    monthly: '月薪', hourly: '時薪', daily: '日薪', split: '拆帳',
    MONTHLY: '月薪', HOURLY: '時薪', DAILY: '日薪', SPLIT: '拆帳',
  }

  const statusLabels: Record<string, string> = {
    ACTIVE: '啟用', PROBATION: '試用期', ON_LEAVE: '休假中', RESIGNED: '已離職',
  }

  const handlePrint = () => window.print()

  return (
    <div className="employee-overview" style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      {/* Print Styles */}
      {/* ★ cw-pa P4 build fix: styled-jsx 嘅 jsx/global 屬性無 type augmentation（pre-existing TS2322）— spread cast，零 runtime 影響 */}
      <style {...({ jsx: true, global: true } as any)}>{`
        @media print {
          .no-print { display: none !important; }
          .overview-section { page-break-inside: avoid; }
          .employee-overview { padding: 0; max-width: 100%; }
          body { background: #fff; }
        }
      `}</style>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <BackButton to="/employees" label="返回員工總覽" />
          <h1 style={{ margin: '8px 0 0', fontSize: 24 }}>
            <span className="flex items-center gap-2"><User size={20} /> 員工個人總覽：{basic?.name || empId}</span>
          </h1>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8 }}>
          <button onClick={handlePrint}
            style={{ padding: '8px 16px', background: '#f8f9fa', border: '1px solid #ddd', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Printer size={16} /> 列印 / 儲存為 PDF
          </button>
        </div>
      </div>

      {/* ① Basic Info */}
      {basic && (
        <OverviewSection title="📋 基本資料">
          <div className="info-grid">
            <InfoRow label="全名" value={basic.fullName || basic.name} />
            <InfoRow label="電話" value={basic.phone} />
            <InfoRow label="電郵" value={basic.email || '-'} />
            <InfoRow label="角色" value={basic.role} />
            <InfoRow label="狀態" value={statusLabels[basic.status] || basic.status} />
            <InfoRow label="入職日" value={basic.joinDate} />
            <InfoRow label="長駐店" value={basic.homeClinic ? `${basic.homeClinic.shortName || basic.homeClinic.name}` : '-'} />
            <InfoRow label="可派診所" value={basic.clinics.map((c: any) => c.shortName || c.name).join(', ') || '-'} />
          </div>
        </OverviewSection>
      )}

      {/* ② Pay Rules */}
      {payRules && (
        <OverviewSection title="💰 薪酬設定（現行）">
          <div className="info-grid">
            <InfoRow label="類型" value={payTypeLabels[payRules.configJson?.base_type] || payRules.payType || '-'} />
            {payRules.monthlySalary && <InfoRow label="月薪" value={fmtCurrency(payRules.monthlySalary)} />}
            {payRules.hourlyRate && <InfoRow label="時薪" value={fmtCurrency(payRules.hourlyRate)} />}
            {payRules.dailyRate && <InfoRow label="日薪" value={fmtCurrency(payRules.dailyRate)} />}
            {payRules.splitRatio != null && <InfoRow label="拆帳比例" value={`${payRules.splitRatio}%`} />}
            {adw && <InfoRow label="ADW" value={fmtCurrency(adw.adw)} />}
            <InfoRow
              label="Effective ADW"
              value={
                effectiveADW
                  ? `${fmtCurrency(effectiveADW.adw)}${
                      effectiveADW.policyApplied === 'floor' ? '（已按現薪保底）'
                      : effectiveADW.policyApplied === 'cap' ? '（已按現薪封頂）'
                      : ''
                    }`
                  : '—'
              }
            />
            {effectiveADW && effectiveADW.policyApplied !== 'none' && (
              <InfoRow label="ADW（政策前）" value={fmtCurrency(effectiveADW.adwRaw)} />
            )}
            <InfoRow label="扣薪日率" value={fmtCurrency(deductionDailyRate)} />
          </div>
        </OverviewSection>
      )}

      {/* ③ Leave Balances */}
      <OverviewSection title="🏖️ 假期結餘">
        {leaveBalances.length === 0 ? (
          <div style={{ color: '#888', fontSize: 13 }}>未設定假期額度</div>
        ) : (
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>假期類型</th>
                <th style={{ textAlign: 'right', padding: '4px 8px' }}>額度</th>
                <th style={{ textAlign: 'right', padding: '4px 8px' }}>已用</th>
                <th style={{ textAlign: 'right', padding: '4px 8px' }}>餘額</th>
              </tr>
            </thead>
            <tbody>
              {leaveBalances.map((b: any) => (
                <tr key={b.id}>
                  <td style={{ padding: '4px 8px' }}>
                    {b.leaveTypeName}
                    {b.entitled === 0 && zeroEntitledHint(b.systemKey) && (
                      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>
                        {zeroEntitledHint(b.systemKey)}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{b.entitled}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{b.used}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', color: b.remaining >= 0 ? '#4CAF50' : '#dc3545' }}>
                    {b.remaining}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {leaveBalances.some((b: any) => b.remaining < 0) && (
          <div style={{ fontSize: 12, color: '#c2410c', marginTop: 8 }}>
            ⚠️ 有假期類型已放超出已賺取額度
          </div>
        )}
      </OverviewSection>

      {/* History sections (④-⑧) with loading state */}
      {historyLoading ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>
          <div className="animate-spin" style={{ display: 'inline-block', width: 24, height: 24, border: '3px solid #e5e7eb', borderTop: '3px solid #0d6efd', borderRadius: '50%' }} />
          <div style={{ marginTop: 8 }}>載入近 12 個月記錄中…（可能需要數秒）</div>
        </div>
      ) : history ? (
        <>
          {/* ④ Time Account */}
          <OverviewSection title="⏱️ 時間帳戶">
            {timeAccount ? (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'monospace', color: timeAccount.minutes >= 0 ? '#198754' : '#dc3545' }}>
                  {timeAccount.minutes != null
                    ? `${timeAccount.minutes >= 0 ? '+' : ''}${timeAccount.minutes} 分鐘`
                    : '不適用（時薪／兼職）'}
                </div>
                {timeAccount.compLeaveDays != null && (
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                    可換假：{timeAccount.compLeaveDays} 天（按每日 {timeAccount.compLeaveDayMinutes} 分鐘）
                  </div>
                )}
                {timeAccount.status === 'not_applicable' && (
                  <div style={{ fontSize: 12, color: '#888' }}>時薪／兼職員工不設時間帳戶</div>
                )}
              </div>
            ) : (
              <div style={{ color: '#888', fontSize: 13 }}>無時間帳戶資料</div>
            )}
          </OverviewSection>

          {/* ⑤ Payroll Monthly Summary */}
          <OverviewSection title="💰 計糧月度摘要">
            {history.attendance.length === 0 ? (
              <div style={{ color: '#888', fontSize: 13 }}>未有計糧記錄 — 出糧後此處顯示月度統計</div>
            ) : (
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>月份</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>工時</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>加班</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>請假</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>缺勤</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>病假</th>
                  </tr>
                </thead>
                <tbody>
                  {history.attendance.map((a: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '4px 6px' }}>{a.periodMonth}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right' }}>{a.workedHours.toFixed(1)}h</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right' }}>{a.otHours.toFixed(1)}h</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right' }}>{a.leaveDays.toFixed(1)}d</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', color: a.absentDays > 0 ? '#dc3545' : 'inherit' }}>{a.absentDays.toFixed(1)}d</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', color: (a.sickDays ?? 0) > 0 ? '#dc3545' : 'inherit' }}>{(a.sickDays ?? 0).toFixed(1)}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </OverviewSection>

          {/* ⑤b Attendance Detail (打卡記錄) */}
          <OverviewSection title="📊 考勤明細（打卡記錄）">
            <AttendanceDetail empId={empId} />
          </OverviewSection>

          {/* ⑥ Payroll History */}
          <OverviewSection title="💵 計糧記錄（近 12 個月）">
            {history.payroll.length === 0 ? (
              <div style={{ color: '#888', fontSize: 13 }}>無計糧記錄</div>
            ) : (
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>月份</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>基本</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>加班</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>扣款</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>病假扣減</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>MPF</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>實發</th>
                  </tr>
                </thead>
                <tbody>
                  {history.payroll.map((p: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '4px 6px' }}>{p.periodMonth}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(p.basePay)}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(p.otPay)}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: (p.deduction ?? 0) > 0 ? '#dc3545' : 'inherit' }}>{fmtCurrency(p.deduction)}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: (p.sickDeduction ?? 0) > 0 ? '#dc3545' : 'inherit' }}>{fmtCurrency(p.sickDeduction)}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(p.mpfEmployee)}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{fmtCurrency(p.totalPayable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </OverviewSection>

          {/* ⑦ Leave Records */}
          <OverviewSection title="🏖️ 假期記錄（近 12 個月）">
            {history.leaves.length === 0 ? (
              <div style={{ color: '#888', fontSize: 13 }}>無假期記錄</div>
            ) : (
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>類型</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>開始</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>結束</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>天數</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {history.leaves.map((l: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '4px 6px' }}>{l.leaveType}</td>
                      <td style={{ padding: '4px 6px' }}>{l.startDate}</td>
                      <td style={{ padding: '4px 6px' }}>{l.endDate}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right' }}>{l.days}</td>
                      <td style={{ padding: '4px 6px' }}>{l.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </OverviewSection>

          {/* ⑧ Wage History */}
          <OverviewSection title="📈 工資歷史（ADW 來源）">
            {history.wageHistory.length === 0 ? (
              <div style={{ color: '#888', fontSize: 13 }}>無工資歷史記錄</div>
            ) : (
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>月份</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>工資總額</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>剔除日數</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>剔除款額</th>
                  </tr>
                </thead>
                <tbody>
                  {history.wageHistory.map((w: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '4px 6px' }}>{w.periodMonth}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(w.totalWage)}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right' }}>{w.excludedDays}d</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(w.excludedWage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </OverviewSection>
        </>
      ) : null}

      {/* ⑨ Resignation Section (disabled placeholder) */}
      <div style={{ border: '1px dashed #d1d5db', borderRadius: 10, padding: 16, background: '#fafafa', marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>👋 離職結算</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          ⚠️ 功能開發中。年假結算已可預覽，代通知金同時間帳戶結算口徑待確認（需法律意見）。
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={async () => {
            setResignLoading(true)
            try {
              const res = await api(`/api/employees/${empId}/resign-preview?lastDay=${new Date().toISOString().split('T')[0]}`)
              if (res.ok) {
                setResignPreview(await res.json())
                setShowResignPreview(true)
              }
            } catch {}
            finally { setResignLoading(false) }
          }} disabled={resignLoading}
            style={{ padding: '8px 16px', background: '#f8f9fa', border: '1px solid #ddd', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            {resignLoading ? '載入中...' : '預覽年假結算'}
          </button>
          <button disabled
            style={{ padding: '8px 16px', background: '#e5e7eb', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'not-allowed', opacity: 0.5, fontSize: 13 }}>
            辦理離職（未開放）
          </button>
        </div>
      </div>

      {/* Resign Preview Modal */}
      {showResignPreview && resignPreview && (
        <div className="no-print"
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowResignPreview(false)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '520px', maxWidth: '90vw', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px', fontSize: 18 }}>離職年假結算預覽</h3>
            {resignPreview.leaveSettlement ? (() => {
              const s = resignPreview.leaveSettlement
              return (
                <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>入職日</span><span>{fmtDate(s.joinDate)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>服務年資</span><span>{Math.floor(s.serviceMonths / 12)} 年 {s.serviceMonths % 12} 個月</span>
                  </div>
                  <div style={{ borderTop: '1px dashed #fbbf24', margin: '4px 0' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9ca3af', fontSize: 12 }}>
                    <span>日常可放（已賺取）</span><span>{s.earnedNow} 天</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                    <span>離職累積（含按比例）</span><span>{s.accrued} 天</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>已用</span><span>− {s.used} 天</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                    <span>可結算</span><span>{s.unused} 天</span>
                  </div>
                  {s.payout != null && (
                    <>
                      <div style={{ borderTop: '1px dashed #fbbf24', margin: '4px 0' }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15 }}>
                        <span>應付年假薪酬</span><span>{fmtCurrency(s.payout)}</span>
                      </div>
                    </>
                  )}
                </div>
              )
            })() : (
              <div style={{ color: '#888', fontSize: 13 }}>無法計算年假結算</div>
            )}
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 10 }}>
              「日常可放」按已完成服務年度（EO s.41A）；<br />
              「離職累積」加埋進行中年度按比例（EO s.41D）。
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setShowResignPreview(false)}
                style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ddd', background: '#f5f5f5', cursor: 'pointer', fontSize: 14 }}>
                關閉
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared Components ───

function OverviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overview-section" style={{
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      padding: 16,
      marginBottom: 16,
      background: '#fff',
    }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
      <span style={{ color: '#6b7280' }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value ?? '-'}</span>
    </div>
  )
}

function AttendanceDetail({ empId }: { empId: string }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<any[]>([])
  const [page, setPage] = useState(1)
  const [range, setRange] = useState<{ from?: string; to?: string }>({})
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'done'>('idle')
  const [hasMore, setHasMore] = useState(false)

  const load = useCallback(async (p: number, r: any = range, append = false) => {
    setState('loading')
    try {
      const qs = new URLSearchParams({ page: String(p), pageSize: '20' })
      if (r?.from) qs.set('from', r.from)
      if (r?.to) qs.set('to', r.to)
      const res = await api(`/api/employees/${empId}/overview/attendance-days?${qs}`)
      if (!res.ok) throw new Error(String(res.status))
      const d = await res.json()
      setRows(prev => append ? [...prev, ...d.days] : d.days)
      setHasMore(d.hasMore)
      setState('done')
    } catch (e) {
      console.error('[overview] 考勤明細載入失敗', e)
      setState('error')
    }
  }, [empId, range])

  if (!open) {
    return (
      <button onClick={() => { setOpen(true); load(1) }} style={{ fontSize: 13, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        顯示打卡明細 ▸
      </button>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, fontSize: 12 }}>
        {[['近7日', 7], ['近30日', 30]].map(([label, d]) => (
          <button key={label as string} onClick={() => {
            const to = new Date()
            const from = new Date(Date.now() - (d as number) * 86400000)
            const r = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
            setRange(r); setPage(1); load(1, r)
          }} style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>
      {state === 'error' ? (
        <div style={{ color: '#c2410c', fontSize: 13 }}>
          載入失敗 <button onClick={() => load(page)} style={{ marginLeft: 8 }}>重試</button>
        </div>
      ) : rows.length === 0 && state === 'done' ? (
        <div style={{ color: '#888', fontSize: 13 }}>此範圍內冇打卡記錄</div>
      ) : (
        <>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>日期</th>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>店</th>
              <th style={{ textAlign: 'center', padding: '4px 6px' }}>上班</th>
              <th style={{ textAlign: 'center', padding: '4px 6px' }}>下班</th>
              <th style={{ textAlign: 'right', padding: '4px 6px' }}>工時</th>
              <th style={{ textAlign: 'center', padding: '4px 6px' }}>狀態</th>
            </tr></thead>
            <tbody>{rows.map((r: any, i: number) => (
              <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '4px 6px' }}>{r.date}</td>
                <td style={{ padding: '4px 6px' }}>{r.clinicName}</td>
                <td style={{ textAlign: 'center', padding: '4px 6px' }}>{r.firstIn ?? '—'}</td>
                <td style={{ textAlign: 'center', padding: '4px 6px' }}>{r.lastOut ?? '—'}</td>
                <td style={{ textAlign: 'right', padding: '4px 6px' }}>{r.workedMinutes != null ? (r.workedMinutes / 60).toFixed(1) + 'h' : '—'}</td>
                <td style={{ textAlign: 'center', padding: '4px 6px' }}>
                  {(() => {
                    const tags: string[] = []
                    if (r.flags?.includes('MISSING_OUT')) tags.push('缺下班卡')
                    if (r.lateMin > 0) tags.push(`遲到 ${r.lateMin} 分`)
                    if (r.earlyMin > 0) tags.push(`早退 ${r.earlyMin} 分`)
                    if (r.otMin > 0) tags.push(`OT ${r.otMin} 分`)
                    return tags.length ? tags.join('・') : '✓'
                  })()}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {hasMore && (
            <button onClick={() => { const p = page + 1; setPage(p); load(p, range, true) }}
              style={{ marginTop: 8, fontSize: 13, padding: '2px 12px', borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
              載入更多
            </button>
          )}
          {state === 'loading' && <span style={{ fontSize: 12, color: '#888' }}> 載入中…</span>}
        </>
      )}
    </div>
  )
}
