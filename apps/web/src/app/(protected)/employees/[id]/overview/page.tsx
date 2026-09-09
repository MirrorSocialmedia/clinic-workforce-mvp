'use client'

import { useEffect, useState, useCallback, Fragment } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { BackButton } from '@/components/BackButton'
import { User, Printer, Eye } from 'lucide-react'
import { fmtDate, fmtDateTime, toHKDateStr } from '@/lib/hk-date'
import ResignSettlementModal from '@/components/ResignSettlementModal'
import { hasPermission } from '@/lib/permissions'
import { zeroEntitledHint } from '@/lib/leave-types'
import { TIMEBANK_MINUTES_PER_DAY } from '@/lib/timebank-constants'

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

  // Resign settlement (2026-09-04 cwm-resigpay: 共用元件)
  const [showResignModal, setShowResignModal] = useState(false)

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

  // 時間帳戶帳本（cwm-tbledger S4）— 獨立 lazy fetch，預設 6 個月；
  // ★ 唔准塞入 fetchHistory（嗰條「可能需要數秒」，帳本要快出）
  const [tbLedger, setTbLedger] = useState<any>(null)
  const [tbLedgerMonths, setTbLedgerMonths] = useState(6)
  const [tbLedgerLoading, setTbLedgerLoading] = useState(true)
  const [tbLedgerLoadingMore, setTbLedgerLoadingMore] = useState(false)
  const [tbLedgerError, setTbLedgerError] = useState<string | null>(null)

  const fetchTbLedger = useCallback(async (months: number, isMore = false) => {
    if (isMore) setTbLedgerLoadingMore(true)
    else setTbLedgerLoading(true)
    setTbLedgerError(null)
    try {
      const res = await api(`/api/employees/${empId}/timebank-ledger?months=${months}`)
      if (!res.ok) {
        setTbLedger(null)
        setTbLedgerError(res.status === 403 ? '無權查看時間帳戶帳本' : '帳本載入失敗')
        return
      }
      setTbLedger(await res.json())
      setTbLedgerMonths(months)
    } catch (err) {
      console.error('Failed to fetch timebank ledger:', err)
      setTbLedgerError('帳本載入失敗')
    } finally {
      setTbLedgerLoading(false)
      setTbLedgerLoadingMore(false)
    }
  }, [empId])

  useEffect(() => {
    fetchTbLedger(6)
  }, [fetchTbLedger])

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
                {/* ★ 2026-08-31 (cwm-earlyin) 拍板：員工總覽要顯示 OT 換假／退回（有值先顯示，分鐘＋天） */}
                {(timeAccount.leaveConvertMinutes ?? 0) !== 0 && (
                  <div style={{ fontSize: 12, color: '#dc3545', marginTop: 4 }}>
                    OT 換假：{timeAccount.leaveConvertMinutes} 分（{Math.abs(timeAccount.leaveConvertMinutes / TIMEBANK_MINUTES_PER_DAY).toFixed(1)} 天）
                  </div>
                )}
                {(timeAccount.leaveSwapBackMinutes ?? 0) !== 0 && (
                  <div style={{ fontSize: 12, color: '#198754', marginTop: 4 }}>
                    換假退回：+{timeAccount.leaveSwapBackMinutes} 分（{(timeAccount.leaveSwapBackMinutes / TIMEBANK_MINUTES_PER_DAY).toFixed(1)} 天）
                  </div>
                )}
                {timeAccount.status === 'not_applicable' && (
                  <div style={{ fontSize: 12, color: '#888' }}>時薪／兼職員工不設時間帳戶</div>
                )}
              </div>
            ) : (
              <div style={{ color: '#888', fontSize: 13 }}>無時間帳戶資料</div>
            )}
            {/* ★ cwm-tbledger S4：帳本四樣（④對數橫幅 / ①逐月流水表+②running balance 展開 / ③操作記錄） */}
            <TimeBankLedgerSection
              ledger={tbLedger}
              loading={tbLedgerLoading}
              error={tbLedgerError}
              months={tbLedgerMonths}
              loadingMore={tbLedgerLoadingMore}
              onMore={() => fetchTbLedger(Math.min(tbLedgerMonths + 6, 24), true)}
            />
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

      {/* ⑨ Resignation Settlement (2026-09-04 cwm-resigpay-20260904：共用元件，拍板 B MANAGER 可預覽) */}
      <div style={{ border: '1px dashed #d1d5db', borderRadius: 10, padding: 16, background: '#fafafa', marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>👋 離職結算</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          年假薪酬、代通知金、時間帳戶扣除同 EO s.25 尾糧期限，以 Effective ADW 計算。
        </div>
        <button onClick={() => setShowResignModal(true)}
          style={{ padding: '8px 16px', background: '#f8f9fa', border: '1px solid #ddd', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
          查看離職結算
        </button>
      </div>

      {/* 離職結算 Modal（共用元件 — 同 accounts 同一份） */}
      {showResignModal && basic && (
        <ResignSettlementModal
          employee={{ employeeId: empId, name: basic.fullName || basic.name, phone: basic.phone }}
          userRole={userRole}
          onClose={() => setShowResignModal(false)}
          onResigned={fetchBasic}
          onSettled={fetchBasic}
        />
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

// ─── 時間帳戶凍結帳本（cwm-tbledger-20260909 S4 E 章）───
// 數據源 = GET /api/employees/:id/timebank-ledger（snapshot 優先／未凍結即時算）。
// 本組件零改錢：純顯示。行分桶口徑：正數推導 = OT 入帳、負數推導 = 扣減、
// ENTRY 行 = 調整（RECONCILE 補差行同歸調整，令「期初+三欄=期末」恆成立）、informational 計 0。
function monthBuckets(m: any) {
  let otIn = 0, deduct = 0, adjust = 0
  for (const l of m.lines ?? []) {
    if (l.informational) continue // 已抵銷行計 0
    if (l.kind === 'DERIVED') {
      if (l.minutes >= 0) otIn += l.minutes
      else deduct += l.minutes
    } else {
      adjust += l.minutes // ENTRY（調整）+ RECONCILE（補差）
    }
  }
  return { otIn, deduct, adjust }
}

function signMin(n: number): string {
  return n > 0 ? `+${n}` : `${n}`
}

/** beforeJson/afterJson（{"balanceMinutes": N}）→ 顯示餘額；parse 唔到顯示原文 */
function fmtBalanceMin(json: string | null | undefined): string {
  if (json == null || json === '') return '—'
  try {
    const o = JSON.parse(json)
    if (o && typeof o.balanceMinutes === 'number') return `${o.balanceMinutes} 分`
  } catch { /* parse 唔到 → 原文 */ }
  return String(json)
}

/** notes（JSON string）→ 「k: v；k: v」；parse 唔到顯示原文 */
function fmtAuditNotes(notes: string | null | undefined): string {
  if (notes == null || notes === '') return '—'
  try {
    const o = JSON.parse(notes)
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('；')
    }
  } catch { /* parse 唔到 → 原文 */ }
  return String(notes)
}

/** ② 逐筆 running balance：（期初）→ 逐行累計 →（期末）✓/✗ */
function LedgerRunningBalance({ m }: { m: any }) {
  let running = m.opening
  const rows: { key: string; date: string; label: string; minutes: string; bal: number; style: React.CSSProperties; title?: string }[] = []
  rows.push({ key: 'opening', date: '（期初）', label: '', minutes: '—', bal: running, style: { color: '#666' } })
  for (const l of m.lines ?? []) {
    running += l.informational ? 0 : (Number(l.minutes) || 0)
    const style: React.CSSProperties = { borderBottom: '1px solid #f0f0f0' }
    let title: string | undefined
    if (l.kind === 'RECONCILE') style.color = '#dc3545' // RECONCILE 紅字
    else if (l.informational) { style.color = '#9ca3af'; style.background = '#eff6ff'; title = '已抵銷遲到扣減，淨效果為零' } // 灰字
    else if (l.kind === 'ENTRY') style.background = '#eff6ff' // ENTRY 同 DERIVED 底色唔同
    rows.push({
      key: l.entryId ?? `${l.date}-${l.type}-${l.label}-${rows.length}`,
      date: l.date, label: l.label,
      minutes: l.informational ? '0' : signMin(l.minutes),
      bal: running, style, title,
    })
  }
  const ok = running === m.closing
  rows.push({ key: 'closing', date: '（期末）', label: ok ? '✓' : '✗', minutes: '—', bal: m.closing, style: { color: ok ? '#198754' : '#dc3545', fontWeight: 600 } })

  return (
    <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ background: '#f0f1f3' }}>
          <th style={{ textAlign: 'left', padding: '3px 6px', width: 90 }}>日期</th>
          <th style={{ textAlign: 'left', padding: '3px 6px' }}>類型</th>
          <th style={{ textAlign: 'right', padding: '3px 6px', width: 70 }}>分鐘</th>
          <th style={{ textAlign: 'right', padding: '3px 6px', width: 90 }}>結餘</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.key} style={r.style} title={r.title}>
            <td style={{ padding: '3px 6px', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{r.date}</td>
            <td style={{ padding: '3px 6px' }}>{r.label}</td>
            <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{r.minutes}</td>
            <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{r.bal}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function TimeBankLedgerSection({
  ledger, loading, error, months, loadingMore, onMore,
}: {
  ledger: any; loading: boolean; error: string | null
  months: number; loadingMore: boolean; onMore: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (loading) return <div style={{ marginTop: 12, color: '#888', fontSize: 12 }}>帳本載入中…</div>
  if (error) return <div style={{ marginTop: 12, color: '#dc3545', fontSize: 12 }}>{error}</div>
  if (!ledger) return null
  // 時薪／兼職 → 不設時間帳戶，四樣全部唔渲染
  if (ledger.notApplicable) return <div style={{ marginTop: 12, color: '#888', fontSize: 13 }}>不設時間帳戶（時薪／兼職）</div>

  const lsMonths: any[] = ledger.months ?? []
  const lastMonth = lsMonths[lsMonths.length - 1]

  // ④ 對數橫幅 — 任何一項唔夾 → 明寫差幾多、差邊個月
  const problems: string[] = []
  for (const cb of ledger.chainBreaks ?? []) {
    problems.push(`⚠️ ${cb.from} 期末 ${cb.prevClosing} ≠ ${cb.to} 期初 ${cb.thisOpening}（差 ${Math.abs(cb.thisOpening - cb.prevClosing)}）— 請報告`)
  }
  for (const m of lsMonths) {
    if (!m.reconciles) {
      const lineSum = (m.lines ?? []).reduce((s: number, l: any) => s + (Number(l.minutes) || 0), 0)
      problems.push(`⚠️ ${m.periodMonth} 加唔埋：期初 ${m.opening} + 分項合計 ${lineSum} = ${m.opening + lineSum} ≠ 期末 ${m.closing}`)
    }
  }
  if (!ledger.balanceMatchesLatestClosing && lastMonth) {
    problems.push(`⚠️ 顯示餘額 ${ledger.currentBalance ?? 'N/A'} ≠ 最新月（${lastMonth.periodMonth}）期末 ${lastMonth.closing}`)
  }

  return (
    <div style={{ marginTop: 12 }}>
      {/* ④ 對數橫幅（帳本區最頂） */}
      <div style={{
        padding: '8px 10px', borderRadius: 6, fontSize: 12, lineHeight: 1.7,
        background: problems.length ? '#fdecea' : '#e8f5e9',
        color: problems.length ? '#b71c1c' : '#1b5e20',
      }}>
        {problems.length === 0 ? (
          <div>✅ 帳本已對數：{lsMonths.length} 個月逐月加得埋，月與月接得返，最新期末 = 顯示餘額 {ledger.currentBalance ?? 'N/A'} 分鐘</div>
        ) : (
          problems.map((p, i) => <div key={i}>{p}</div>)
        )}
      </div>

      {/* ① 逐月流水表（撳月份展開 ②） */}
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr style={{ background: '#f8f9fa' }}>
            {['月份', '期初', 'OT 入帳', '扣減', '調整', '期末', '狀態'].map(h => (
              <th key={h} style={{ textAlign: h === '月份' || h === '狀態' ? 'left' : 'right', padding: '4px 6px' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lsMonths.map(m => {
            const b = monthBuckets(m)
            const isOpen = expanded === m.periodMonth
            return (
              <Fragment key={m.periodMonth}>
                <tr
                  onClick={() => setExpanded(isOpen ? null : m.periodMonth)}
                  style={{ cursor: 'pointer', background: m.reconciles ? (isOpen ? '#f8f9fa' : '#fff') : '#fdecea' }}
                >
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{isOpen ? '▲' : '▼'} {m.periodMonth}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{m.opening}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: b.otIn > 0 ? '#198754' : undefined }}>{signMin(b.otIn)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: b.deduct < 0 ? '#dc3545' : undefined }}>{signMin(b.deduct)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{signMin(b.adjust)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{m.closing}</td>
                  <td style={{ padding: '4px 6px', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {m.frozen
                      ? <>🔒 已凍結{m.frozenAt ? ` ${toHKDateStr(m.frozenAt)}` : ''}</>
                      : '⏳ 未確認計糧（即時計算）'}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7} style={{ padding: '6px 10px 10px', background: '#fbfbfb', borderLeft: '3px solid #0d6efd' }}>
                      <LedgerRunningBalance m={m} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      {/* ③ 操作記錄（append-only 證明） */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>📋 操作記錄</div>
        {(ledger.audit ?? []).length === 0 ? (
          <div style={{ color: '#888', fontSize: 12 }}>（無操作記錄）</div>
        ) : (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8f9fa' }}>
                {['時間', '操作人', '動作', '餘額變化', '備註'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 6px' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(ledger.audit ?? []).map((a: any) => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{fmtDateTime(a.createdAt)}</td>
                  <td style={{ padding: '4px 6px' }}>{a.actorName ?? a.actorId ?? '系統'}</td>
                  <td style={{ padding: '4px 6px' }}>{a.action}</td>
                  <td style={{ padding: '4px 6px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    {fmtBalanceMin(a.beforeJson)} → {fmtBalanceMin(a.afterJson)}
                  </td>
                  <td style={{ padding: '4px 6px' }}>{fmtAuditNotes(a.notes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 載入更多（route clamp 上限 24 個月） */}
      {months < 24 && (
        <button
          onClick={onMore}
          disabled={loadingMore}
          style={{ marginTop: 8, fontSize: 13, padding: '2px 12px', borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', cursor: loadingMore ? 'wait' : 'pointer' }}
        >
          {loadingMore ? '載入中…' : '載入更多（+6 個月）'}
        </button>
      )}
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
          {rows.some((r: any) => r.otMin > 0) && (
            <div style={{ marginTop: 6, fontSize: 11, color: '#9ca3af' }}>※ 冇更表日（假期／休息日返工）按全日打卡顯示 OT，金額以計糧為準</div>
          )}
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
