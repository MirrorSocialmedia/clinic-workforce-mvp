'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { BackButton } from '@/components/BackButton'
import { Wallet, Trash2 } from 'lucide-react'
import { periodMonthKey, toHKDateStr, addDaysStr } from '@/lib/hk-date'

// ★ 讀取類 fetch 一律繞過瀏覽器快取。
// PUT 同 GET 用同一個 URL，唔加就會喺寫入之後攞返舊 response
// （確認計糧「冇反應」就係咁嚟）。
const api = (url: string, init?: RequestInit) =>
  fetch(url, { credentials: 'include', cache: 'no-store', ...init })

type RunStatus = 'DRAFT' | 'FINALIZED' | 'EXPORTED'

interface PayrollItem {
  id: string
  employeeId: string
  workedHours: number
  otHours: number
  leaveDays: number
  absentDays: number
  basePay: number | null
  otPay: number | null
  splitPay: number | null
  deduction: number | null
  totalPayable: number | null
  miscAmount: number | null
  miscDetailJson: string | null
  sickDeduction: number | null
  detailJson: string | null
  confidential?: boolean
  employee: {
    user: { name: string; phone: string }
    clinics: { clinicId: string; clinic: { name: string } }[]
    payRules: Array<{ payType: string }>
    status: string
    resignedAt: string | null
  }
}

interface PayrollRun {
  id: string
  clinicId: string | null
  periodMonth: string
  status: RunStatus
  payDate: string | null
  generatedAt: string
  notes: string | null
  clinic: { id: string; name: string } | null
  items: PayrollItem[]
}

interface Summary {
  totalEmployees: number
  totalBasePay: number | null
  totalOTPay: number | null
  totalSplitPay: number | null
  totalDeduction: number | null
  totalPayable: number | null
  totalWorkedHours: number
  totalOTHours: number
  totalLeaveDays: number
  totalAbsentDays: number
  // ★ 2026-09-10 cwm-payrollui：API 側 reduce（保密員工 miscAmount 可能前端見不到 — 唔好前端算，#18）
  totalMisc?: number | null
  totalAttendanceBonus?: number | null
  confidential?: boolean
}

interface PayrollCompany {
  id: string
  name: string
  payrollViewJson: string | null
}

// ★ 2026-09-10 cwm-payrollui 拍板⑤：自訂顯示（全公司統一設定 — Company.payrollViewJson）
//   存【要顯示】嘅 key；DB null = 預設。🔒 強制項 API 會補回，前端 disabled 唔俾撳。
const CARD_OPTIONS: Array<{ key: string; label: string; required?: boolean }> = [
  { key: 'employeeCount', label: '員工數' },
  { key: 'totalBase', label: '總基本薪資' },
  { key: 'totalExtra', label: '額外收入（拆帳＋勤工）' },
  { key: 'totalDeduction', label: '總扣款' },
  { key: 'totalMisc', label: '雜項總額' },
  { key: 'payableExMisc', label: '應付（不含雜費）' },
  { key: 'totalPayable', label: '應付總額', required: true },
  { key: 'totalHours', label: '總工時' },
  { key: 'totalOTHours', label: '總加班時數' },
  { key: 'totalLeaveAbsent', label: '總請假/缺勤' },
]
// ★ 預設（MD §4.2）：totalMisc 預設關；其餘全開
const CARD_DEFAULTS = ['employeeCount', 'totalBase', 'totalExtra', 'totalDeduction', 'payableExMisc', 'totalPayable', 'totalHours', 'totalOTHours', 'totalLeaveAbsent']

const COL_OPTIONS: Array<{ key: string; label: string; required?: boolean }> = [
  { key: 'employee', label: '員工', required: true },
  { key: 'clinic', label: '診所' },
  { key: 'payType', label: '薪酬類型' },
  { key: 'hours', label: '工時' },
  { key: 'otHours', label: '加班' },
  { key: 'leaveDays', label: '請假' },
  { key: 'absentDays', label: '缺勤' },
  { key: 'baseSalary', label: '基本薪資' },
  { key: 'extraIncome', label: '額外收入（拆帳／勤工）' },
  { key: 'deduction', label: '扣款' },
  { key: 'sickDeduction', label: '病假扣減' },
  { key: 'misc', label: '雜項($)' },
  { key: 'totalPayable', label: '應付總額', required: true },
  { key: 'detail', label: '明細', required: true },
]
// ★ 預設（MD §4.2）：absentDays / deduction / sickDeduction 預設關
const COL_DEFAULTS = ['employee', 'clinic', 'payType', 'hours', 'otHours', 'leaveDays', 'baseSalary', 'extraIncome', 'misc', 'totalPayable', 'detail']

function parsePayrollView(json: string | null | undefined): { cards: string[]; columns: string[] } {
  if (!json) return { cards: CARD_DEFAULTS, columns: COL_DEFAULTS }
  try {
    const d = JSON.parse(json)
    // ★ 白名單過濾 + 強制項補回（同 API 側同一套 key）
    const cards = Array.isArray(d.cards) ? d.cards.filter((k: any) => CARD_OPTIONS.some(o => o.key === k)) : []
    const columns = Array.isArray(d.columns) ? d.columns.filter((k: any) => COL_OPTIONS.some(o => o.key === k)) : []
    for (const o of CARD_OPTIONS) if (o.required && !cards.includes(o.key)) cards.push(o.key)
    for (const o of COL_OPTIONS) if (o.required && !columns.includes(o.key)) columns.push(o.key)
    return { cards: cards.length ? cards : CARD_DEFAULTS, columns: columns.length ? columns : COL_DEFAULTS }
  } catch {
    return { cards: CARD_DEFAULTS, columns: COL_DEFAULTS }
  }
}

export default function PayrollDetailPage() {
  const params = useParams()
  const router = useRouter()
  const runId = (params?.id || '') as string

  const [run, setRun] = useState<PayrollRun | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [company, setCompany] = useState<PayrollCompany | null>(null)
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState<string>('')
  const [exporting, setExporting] = useState<string | null>(null)
  const [updateNote, setUpdateNote] = useState('')
  const [statusAction, setStatusAction] = useState<string | null>(null)

  // ★ 2026-08-25：發薪日期（人手填；只准 DRAFT 改，同已鎖定唔准改同一原則）
  const [payDateInput, setPayDateInput] = useState('')
  useEffect(() => {
    setPayDateInput(run?.payDate ? toHKDateStr(run.payDate) : '')
  }, [run?.id, run?.payDate])

  const handlePayDateChange = async (val: string) => {
    setPayDateInput(val)
    if (!run || run.status !== 'DRAFT') return
    try {
      const res = await api(`/api/payroll-runs/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payDate: val }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || `保存發薪日期失敗（${res.status}）`)
        fetchRun() // 回滾輸入框
      } else {
        fetchRun()
      }
    } catch (err) {
      console.error('Failed to save payDate:', err)
      fetchRun()
    }
  }

  // ★ C2: Preflight modal state
  const [showPreflight, setShowPreflight] = useState(false)
  const [preflight, setPreflight] = useState<{ periodMonth: string; itemCount: number; blockers: string[]; warnings: string[] } | null>(null)
  const [confirming, setConfirming] = useState(false)

  // ★ 2026-09-10 cwm-payrollui 拍板⑤：⚙️ 顯示欄位 modal — draft 先改，撳「儲存」先 PUT（唔即改即存）
  const [viewSettingOpen, setViewSettingOpen] = useState(false)
  const [draftCards, setDraftCards] = useState<string[]>(CARD_DEFAULTS)
  const [draftCols, setDraftCols] = useState<string[]>(COL_DEFAULTS)
  const [viewSaving, setViewSaving] = useState(false)

  const payrollView = useMemo(
    () => parsePayrollView(company?.payrollViewJson),
    [company?.payrollViewJson],
  )

  const openViewSetting = () => {
    setDraftCards(payrollView.cards)
    setDraftCols(payrollView.columns)
    setViewSettingOpen(true)
  }

  const handleSaveView = async () => {
    if (!company) return
    setViewSaving(true)
    try {
      const res = await api(`/api/companies/${company.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: company.name, payrollView: { cards: draftCards, columns: draftCols } }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || `儲存失敗（${res.status}）`)
        return
      }
      setViewSettingOpen(false)
      fetchRun() // 重新載入 → 頁面即刻反映新設定
    } catch (err) {
      console.error('Failed to save payroll view setting:', err)
      alert('儲存失敗，請重試')
    } finally {
      setViewSaving(false)
    }
  }

  const fetchRun = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api(`/api/payroll-runs/${runId}`)
      if (!res.ok) {
        if (res.status === 404) router.push('/payroll')
        return
      }
      const data = await res.json()
      setRun(data.run)
      setSummary(data.summary)
      setCompany(data.company ?? null)
    } catch (err) {
      console.error('Failed to fetch payroll run:', err)
    } finally {
      setLoading(false)
    }
  }, [runId, router])

  useEffect(() => {
    fetchRun()
    api('/api/me').then(async r => {
      if (!r.ok) return { user: { role: '' } }
      const d = await r.json()
      setUserRole(d.user?.role || '')
    })
  }, [fetchRun])

  const isOwner = userRole === 'OWNER' // ROLE-OK: 保密員工薪金隔離，刻意用 role 唔用權限

  const handleStatusChange = async (newStatus: string) => {
    try {
      const res = await api(`/api/payroll-runs/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        fetchRun()
      } else {
        const err = await res.json()
        alert(err.error || '更新失敗')
      }
    } catch (err) {
      console.error('Failed to update status:', err)
    } finally {
      setStatusAction(null)
    }
  }

  // ★ B2: 退回草稿
  const handleRevert = async () => {
    const reason = prompt(
      '退回草稿之後可以重新生成計糧。\n' +
      '⚠️ 呢個動作會記入審計日誌。\n\n' +
      '請填寫原因（至少 5 個字）：'
    )
    if (!reason || reason.trim().length < 5) return
    const res = await api(`/api/payroll-runs/${runId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'DRAFT', reason: reason.trim() }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      alert(err.error || `退回失敗（${res.status}）`)
      return
    }
    await fetchRun()
  }

  // ★ C2: 確認前檢查 (加 try/catch + Array.isArray fallback 防止白畫面)
  const handleConfirmClick = async () => {
    try {
      const res = await api(`/api/payroll-runs/${runId}/preflight`)
      if (!res.ok) { alert('檢查失敗，請重試'); return }
      const d = await res.json()
      setPreflight({
        periodMonth: d.periodMonth ?? '',
        itemCount: d.itemCount ?? 0,
        blockers: Array.isArray(d.blockers) ? d.blockers : [],
        warnings: Array.isArray(d.warnings) ? d.warnings : [],
      })
      setShowPreflight(true)
    } catch (e) {
      console.error('[preflight]', e)
      alert(`檢查失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const doConfirm = async () => {
    setConfirming(true)
    try {
      const res = await api(`/api/payroll-runs/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'FINALIZED' }),
      })
      if (res.ok) {
        setShowPreflight(false)
        await fetchRun()
      } else {
        let msg = '確認失敗'
        try { msg = (await res.json())?.error ?? msg } catch { /* 空 body */ }
        alert(msg)
      }
    } catch (err) {
      console.error('Confirm failed:', err)
      alert('確認失敗')
    } finally {
      setConfirming(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('確定刪除？此操作不可復原。')) return
    try {
      const res = await api(`/api/payroll-runs/${runId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        router.push('/payroll')
      } else {
        let msg = '刪除失敗'
        try { msg = (await res.json())?.error ?? msg } catch { /* 空 body */ }
        alert(msg)
      }
    } catch (err) {
      console.error('Failed to delete:', err)
    }
  }

  const handleExport = async (format: 'xlsx' | 'pdf') => {
    setExporting(format)
    try {
      const res = await api(`/api/payroll-runs/${runId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format }),
      })
      if (!res.ok) throw new Error('匯出失敗')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `payroll_${periodMonthKey(run?.periodMonth || '')}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export failed:', err)
      alert('匯出失敗')
    } finally {
      setExporting(null)
    }
  }

  const handleUpdateNotes = async () => {
    try {
      const res = await api(`/api/payroll-runs/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: updateNote }),
      })
      if (res.ok) fetchRun()
    } catch (err) {
      console.error('Failed to update notes:', err)
    }
  }

  const statusBadge = (status: RunStatus) => {
    const colors: Record<RunStatus, string> = {
      DRAFT: '#ffc107',
      FINALIZED: '#0d6efd',
      EXPORTED: '#198754',
    }
    const labels: Record<RunStatus, string> = {
      DRAFT: '草稿',
      FINALIZED: '已確認',
      EXPORTED: '已匯出',
    }
    return (
      <span style={{
        background: colors[status],
        color: status === 'DRAFT' ? '#333' : '#fff',
        padding: '4px 10px',
        borderRadius: 4,
        fontSize: 13,
        fontWeight: 600,
      }}>
        {labels[status]}
      </span>
    )
  }

  // ★ null 有兩種意思：保密（item.confidential）同「計算失敗／未生成」。
  //   混埋一齊會令計糧錯誤扮成保密（2026-08-03 Kathy 撞到）。
  const fmtCurrency = (v: number | null | undefined, isConfidential = false) => {
    if (isConfidential) return '🔒 保密'
    if (v == null) return '—' // ★ 冇資料
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const fmtPM = () => periodMonthKey(run!.periodMonth)

  const parseAttendanceBonus = (item: PayrollItem) => {
    if (!item.detailJson) return { amount: 0, cancelled: false, reason: '' }
    try {
      const detail = JSON.parse(item.detailJson)
      const bonus = (detail as any)?.attendanceBonus
      // ★ 2026-09-10 cwm-payrollui：engine 寫入係 number（+ 平欄 attendanceBonusCancelled/Reason），
      //   舊代碼淨認 object 形 → number 永遠回 0。雙兼容。
      if (typeof bonus === 'number') {
        return {
          amount: bonus,
          cancelled: !!detail.attendanceBonusCancelled,
          reason: detail.attendanceBonusReason || '',
        }
      }
      if (bonus && typeof bonus === 'object') {
        return {
          amount: bonus.amount ?? 0,
          cancelled: !!bonus.cancelled,
          reason: bonus.reason || '',
        }
      }
    } catch {}
    return { amount: 0, cancelled: false, reason: '' }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>載入中...</div>
  }

  if (!run) {
    return <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>找不到計糧記錄</div>
  }

  const periodMonth = fmtPM()

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <BackButton to="/payroll" label="返回計糧列表" />
          <h1 style={{ margin: 0, fontSize: 24 }}>
            <span className="flex items-center gap-2"><Wallet size={20} /> 計糧詳情 — {periodMonth}</span>
          </h1>
          <div style={{ fontSize: 13, color: '#888', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{run.clinic?.name || '全部診所'} | {statusBadge(run.status)}</span>
            {/* ★ 2026-08-25：發薪日期（薪俸結算書 Pay Date；非 DRAFT 鎖住） */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              發薪日期
              <input type="date" value={payDateInput} disabled={run.status !== 'DRAFT'}
                onChange={e => handlePayDateChange(e.target.value)}
                style={{ fontSize: 12, padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 4,
                       background: run.status !== 'DRAFT' ? '#f3f4f6' : '#fff' }} />
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {run.status === 'DRAFT' && isOwner && (
            <button onClick={handleConfirmClick} disabled={statusAction !== null}
              style={{ padding: '8px 16px', background: '#0d6efd', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
              確認計糧
            </button>
          )}
          {run.status === 'FINALIZED' && isOwner && (
            <>
              <button onClick={() => handleStatusChange('EXPORTED')} disabled={statusAction !== null}
                style={{ padding: '8px 16px', background: '#198754', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
                標記已匯出
              </button>
              {/* ★ B2: 退回草稿 */}
              <button
                onClick={handleRevert}
                style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #f59e0b', background: '#fff', color: '#b45309', fontSize: 14, cursor: 'pointer' }}
              >
                退回草稿
              </button>
            </>
          )}
          <button onClick={() => handleExport('xlsx')} disabled={exporting !== null}
            style={{ padding: '8px 16px', background: '#198754', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            {exporting === 'xlsx' ? '匯出中...' : '📊 Excel'}
          </button>
          <button onClick={() => handleExport('pdf')} disabled={exporting !== null}
            style={{ padding: '8px 16px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            {exporting === 'pdf' ? '匯出中...' : '📄 PDF'}
          </button>
          {/* ★ 2026-09-10 cwm-payrollui 拍板⑤：⚙️ 顯示欄位（全公司統一設定）
              跨店 run（clinicId null）冇 company 可存 → disabled */}
          <button onClick={openViewSetting} disabled={!company}
            title={company ? '自訂顯示（全公司統一）' : '跨店計糧單無公司設定'}
            style={{ padding: '8px 16px', background: '#6c757d', color: '#fff', border: 'none', borderRadius: 6,
                     cursor: company ? 'pointer' : 'not-allowed', opacity: company ? 1 : 0.5 }}>
            ⚙️ 顯示欄位
          </button>
          {run.status === 'DRAFT' && isOwner && (
            <button onClick={handleDelete}
              style={{ padding: '8px 16px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              <span className="flex items-center gap-1"><Trash2 size={16} /> 刪除</span>
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div>
          {summary.confidential && (
            <div style={{
              padding: '10px 16px', marginBottom: 16,
              background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6,
              fontSize: 13, color: '#856404',
            }}>
              ⚠️ 含保密員工，總額僅老闆可見
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
            {/* ★ 2026-09-10 cwm-payrollui 拍板④/⑤：
                - 剷「總加班費」卡（總加班時數保留 — 時數唔係費用，OT 換假制下仍然有意义）
                - 新「額外收入（拆帳＋勤工）」/「雜項總額」/「應付（不含雜費）」= totalPayable − totalMisc（API 側算）
                - 按自訂顯示設定過濾（全公司統一） */}
            {(() => {
              const cardValues: Record<string, { value: React.ReactNode; color: string; bold?: boolean }> = {
                employeeCount: { value: summary.totalEmployees, color: '#0d6efd' },
                totalBase: { value: fmtCurrency(summary.totalBasePay, summary.confidential), color: '#6c757d' },
                totalExtra: { value: fmtCurrency((summary.totalSplitPay ?? 0) + (summary.totalAttendanceBonus ?? 0), summary.confidential), color: '#7c3aed' },
                totalDeduction: { value: fmtCurrency(summary.totalDeduction, summary.confidential), color: '#dc3545' },
                totalMisc: { value: fmtCurrency(summary.totalMisc ?? 0, summary.confidential), color: '#0d9488' },
                payableExMisc: { value: fmtCurrency((summary.totalPayable ?? 0) - (summary.totalMisc ?? 0), summary.confidential), color: '#1d4ed8' },
                totalPayable: { value: fmtCurrency(summary.totalPayable, summary.confidential), color: '#0d6efd', bold: true },
                totalHours: { value: `${summary.totalWorkedHours.toFixed(1)}h`, color: '#6c757d' },
                totalOTHours: { value: `${(summary.totalOTHours || 0).toFixed(1)}h`, color: '#6c757d' },
                totalLeaveAbsent: { value: `${summary.totalLeaveDays.toFixed(1)} / ${summary.totalAbsentDays.toFixed(1)} 天`, color: '#6c757d' },
              }
              return CARD_OPTIONS
                .filter(o => payrollView.cards.includes(o.key))
                .map(o => {
                  const card = { label: o.label, ...cardValues[o.key] }
                  return (
                    <div key={o.key} style={{
                      padding: '12px 16px',
                      background: card.color + '10',
                      borderLeft: `3px solid ${card.color}`,
                      borderRadius: 4,
                    }}>
                      <div style={{ fontSize: 12, color: '#888' }}>{card.label}</div>
                      <div style={{ fontSize: 20, fontWeight: card.bold ? 700 : 600, color: card.color }}>
                        {card.value}
                      </div>
                    </div>
                  )
                })
            })()}
          </div>
        </div>
      )}

      {/* Notes */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', marginBottom: 4, fontSize: 13, color: '#888' }}>備註</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={updateNote || run.notes || ''}
            onChange={e => setUpdateNote(e.target.value)}
            placeholder="添加備註..."
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 4,
              border: '1px solid #ddd',
              fontSize: 14,
            }}
          />
          {isOwner && (
            <button onClick={handleUpdateNotes}
              style={{ padding: '8px 16px', background: '#f8f9fa', border: '1px solid #ddd', borderRadius: 4, cursor: 'pointer' }}>
              儲存
            </button>
          )}
        </div>
      </div>

      {/* Employee Table — Desktop */}
      <div className="hidden md:block" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          {/* ★ 2026-09-10 cwm-payrollui 拍板③④⑤：
              - 剷「加班費」欄（拍板④；「總加班時數」卡保留 — 時數唔係費用）
              - 「勤工獎」+「拆帳」併「額外收入」一欄（上下兩行）
              - 16 欄 → 14 欄，按自訂顯示設定過濾（全公司統一） */}
          <thead>
            <tr style={{ borderBottom: '2px solid #dee2e6' }}>
              {COL_OPTIONS.filter(o => payrollView.columns.includes(o.key)).map(o => (
                <th key={o.key} style={{
                  textAlign: (o.key === 'employee' || o.key === 'clinic' || o.key === 'payType') ? 'left' : (o.key === 'detail' ? 'center' : 'right'),
                  padding: '8px 6px',
                }}>
                  {o.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.items.map(item => {
              const confidential = item.confidential
              // ★ 2026-09-10 cwm-payrollui 拍板③⑤：per-key cell builder —
              //   自訂顯示只係決定「顯示邊幾個 key」，金額計算零改（#25 生死格）
              const colCells: Record<string, React.ReactNode> = {
                employee: (
                  <td key="employee" style={{ padding: '8px 6px' }}>
                    <div style={{ fontWeight: 600 }}>
                      {confidential && <span title="薪資保密">🔒 </span>}
                      {item.employee.user.name}
                      {item.employee.status === 'RESIGNED' && (
                        <span style={{ marginLeft: 6, background: '#f59e0b', color: '#fff', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 600 }}>離職</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>
                      {item.employee.user.phone}
                      {item.employee.resignedAt && (
                        <span style={{ color: '#d97706' }}> · 最後 {addDaysStr(toHKDateStr(item.employee.resignedAt), -1)}</span>
                      )}
                    </div>
                  </td>
                ),
                clinic: (
                  <td key="clinic" style={{ padding: '8px 6px', fontSize: 12 }}>
                    {item.employee.clinics.map(c => c.clinic.name).join(', ')}
                  </td>
                ),
                payType: (
                  <td key="payType" style={{ padding: '8px 6px', fontSize: 12 }}>
                    {item.employee.payRules[0]?.payType || '-'}
                  </td>
                ),
                hours: (
                  <td key="hours" style={{ padding: '8px 6px', textAlign: 'right' }}>{item.workedHours.toFixed(1)}</td>
                ),
                otHours: (
                  <td key="otHours" style={{ padding: '8px 6px', textAlign: 'right' }}>
                    {confidential ? '🔒' : (() => { try { const d = JSON.parse(item.detailJson || '{}'); return ((d?.timebank?.otMinutes ?? 0) / 60).toFixed(1) } catch { return item.otHours.toFixed(1) } })()}
                  </td>
                ),
                leaveDays: (
                  <td key="leaveDays" style={{ padding: '8px 6px', textAlign: 'right' }}>{item.leaveDays.toFixed(1)}</td>
                ),
                absentDays: (
                  <td key="absentDays" style={{ padding: '8px 6px', textAlign: 'right', color: item.absentDays > 0 ? '#dc3545' : 'inherit' }}>
                    {item.absentDays.toFixed(1)}
                  </td>
                ),
                baseSalary: (
                  <td key="baseSalary" style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                    {fmtCurrency(item.basePay, confidential)}
                  </td>
                ),
                extraIncome: (
                  <td key="extraIncome" style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                    {/* ★ 2026-09-10 拍板③：拆帳＋勤工獎 合併一欄，上下兩行；兩者都冇先顯示「—」。
                        ⚠️ 雜項【唔併入】— 「不含雜費」總額要排除佢。
                        ★ CEO 拍板（設計預留）：未來第三種額外收入（花紅/佣金）只係喺 rows 多 push 一行，唔使改結構。 */}
                    {confidential ? (
                      <span style={{ color: '#888', fontSize: 12 }}>🔒 保密</span>
                    ) : (() => {
                      const rows: React.ReactNode[] = []
                      if ((item.splitPay ?? 0) !== 0) {
                        rows.push(<div key="split" style={{ color: '#7c3aed' }}>拆帳 {fmtCurrency(item.splitPay, confidential)}</div>)
                      }
                      const ab = parseAttendanceBonus(item)
                      if (ab.cancelled) {
                        rows.push(<div key="bonus" style={{ color: '#dc3545', fontSize: 11, whiteSpace: 'nowrap' }}>勤工 ⚠️ {ab.reason || '遲到超30分取消'}</div>)
                      } else if (ab.amount > 0) {
                        rows.push(<div key="bonus" style={{ color: '#059669' }}>勤工 {fmtCurrency(ab.amount, confidential)}</div>)
                      }
                      return rows.length === 0 ? <span style={{ color: '#ccc' }}>—</span> : rows
                    })()}
                  </td>
                ),
                deduction: (
                  <td key="deduction" style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: (item.deduction ?? 0) > 0 ? '#dc3545' : 'inherit' }}>
                    {fmtCurrency(item.deduction, confidential)}
                  </td>
                ),
                sickDeduction: (
                  <td key="sickDeduction" style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: (item.sickDeduction ?? 0) > 0 ? '#dc3545' : 'inherit' }}>
                    {fmtCurrency(item.sickDeduction ?? 0, confidential)}
                  </td>
                ),
                misc: (
                  <td key="misc" style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: '#059669' }}
                    title={item.miscDetailJson ? JSON.parse(item.miscDetailJson).map((d: any) => `${d.description} $${d.amount}`).join('\n') : undefined}>
                    {item.miscAmount ? `+${item.miscAmount.toLocaleString()}` : '+0'}
                  </td>
                ),
                totalPayable: (
                  <td key="totalPayable" style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>
                    {fmtCurrency(item.totalPayable, confidential)}
                  </td>
                ),
                detail: (
                  <td key="detail" style={{ padding: '8px 6px', textAlign: 'center' }}>
                    {confidential ? (
                      <span style={{ color: '#888', fontSize: 12, cursor: 'not-allowed' }} title="此員工薪資已設保密">🔒 保密</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                        <Link href={`/payroll/${runId}/employee/${item.employeeId}`}
                          style={{ color: '#0d6efd', textDecoration: 'none', fontSize: 12 }}>
                          查看
                        </Link>
                        <Link href={`/accounts/${item.employeeId}/wage-history`}
                          style={{ color: '#059669', textDecoration: 'none', fontSize: 12 }}>
                          工資歷史
                        </Link>
                      </div>
                    )}
                  </td>
                ),
              }
              return (
                <tr key={item.id} style={{
                  borderBottom: '1px solid #f0f0f0',
                  background: confidential ? '#fff9f0' : 'transparent',
                }}>
                  {COL_OPTIONS.filter(o => payrollView.columns.includes(o.key)).map(o => colCells[o.key])}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Employee Cards — Mobile */}
      <div className="md:hidden space-y-3" style={{ marginTop: 16 }}>
        {run.items.map(item => {
          const confidential = item.confidential
          return (
            <div key={item.id} style={{
              background: confidential ? '#fff9f0' : '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '12px 14px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}>
              {/* Employee name + clinic */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>
                    {confidential && <span title="薪資保密">🔒 </span>}
                    {item.employee.user.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                    {item.employee.clinics.map(c => c.clinic.name).join(', ')} · {item.employee.payRules[0]?.payType || '-'}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>{item.employee.user.phone}</div>
              </div>

              {/* Hours row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#888' }}>工時</div>
                  <div style={{ fontSize: 14, fontFamily: 'monospace' }}>{item.workedHours.toFixed(1)}h</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#888' }}>加班</div>
                  <div style={{ fontSize: 14, fontFamily: 'monospace' }}>
                    {confidential ? '🔒' : (() => { try { const d = JSON.parse(item.detailJson || '{}'); return ((d?.timebank?.otMinutes ?? 0) / 60).toFixed(1) + 'h' } catch { return item.otHours.toFixed(1) + 'h' } })()}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#888' }}>請假</div>
                  <div style={{ fontSize: 14, fontFamily: 'monospace' }}>{item.leaveDays.toFixed(1)}d</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#888' }}>缺勤</div>
                  <div style={{ fontSize: 14, fontFamily: 'monospace', color: item.absentDays > 0 ? '#dc3545' : 'inherit' }}>{item.absentDays.toFixed(1)}d</div>
                </div>
              </div>

              {/* Salary row */}
              <div style={{ borderTop: '1px dashed #e5e7eb', paddingTop: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#888' }}>基本薪資</span>
                  <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{fmtCurrency(item.basePay, confidential)}</span>
                </div>
                {/* ★ 2026-09-10 cwm-payrollui 拍板④：加班費完全剷走（同桌面表一致；時數睇上面「加班」格） */}
                {item.deduction && item.deduction > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: '#dc3545' }}>扣款</span>
                    <span style={{ fontSize: 13, fontFamily: 'monospace', color: '#dc3545' }}>-{fmtCurrency(item.deduction, confidential)}</span>
                  </div>
                )}
                {item.sickDeduction && item.sickDeduction > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: '#dc3545' }}>病假扣減</span>
                    <span style={{ fontSize: 13, fontFamily: 'monospace', color: '#dc3545' }}>-{fmtCurrency(item.sickDeduction, confidential)}</span>
                  </div>
                )}
                {item.miscAmount && item.miscAmount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}
                    title={item.miscDetailJson ? JSON.parse(item.miscDetailJson).map((d: any) => `${d.description} $${d.amount}`).join('\n') : undefined}>
                    <span style={{ fontSize: 12, color: '#059669' }}>雜項報銷</span>
                    <span style={{ fontSize: 13, fontFamily: 'monospace', color: '#059669' }}>+${item.miscAmount.toLocaleString()}</span>
                  </div>
                )}
              </div>

              {/* Net pay + action */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace' }}>
                  {fmtCurrency(item.totalPayable, confidential)}
                </span>
                <div>
                  {confidential ? (
                    <span style={{ color: '#888', fontSize: 12, cursor: 'not-allowed' }} title="此員工薪資已設保密">🔒 保密</span>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Link href={`/accounts/${item.employeeId}/wage-history`}
                        style={{ color: '#059669', textDecoration: 'none', fontSize: 12 }}>
                        工資歷史
                      </Link>
                      <Link href={`/payroll/${runId}/employee/${item.employeeId}`}
                        style={{ color: '#0d6efd', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>
                        明細 →
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
    {/* ★ C2: Preflight Modal — 改用 portal render 到 document.body，
            避開 md:hidden 父層 display:none 導致桌面版彈窗消失 */}
    {showPreflight && preflight && typeof document !== 'undefined' && createPortal(
      <div
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}
        onClick={() => setShowPreflight(false)}
      >
        <div
          style={{
            background: '#fff', borderRadius: 12, padding: 24,
            width: '520px', maxWidth: '90vw', maxHeight: '80vh',
            overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          }}
          onClick={e => e.stopPropagation()}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>確認計糧前檢查 —— {preflight.periodMonth}</h3>
          <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 12px' }}>共 {preflight.itemCount} 位員工</p>

          {preflight.blockers.length > 0 && (
            <div style={{ background: '#fee2e2', padding: 12, borderRadius: 8, marginTop: 12 }}>
              <strong style={{ color: '#b91c1c' }}>必須先處理</strong>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {preflight.blockers.map((b: string) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          )}

          {preflight.warnings.length > 0 && (
            <div style={{ background: '#fef3c7', padding: 12, borderRadius: 8, marginTop: 12 }}>
              <strong style={{ color: '#b45309' }}>請確認</strong>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {preflight.warnings.map((w: string) => <li key={w}>{w}</li>)}
              </ul>
            </div>
          )}

          <p style={{ fontSize: 13, color: '#6b7280', marginTop: 16 }}>
            確認之後計糧單會鎖定，工資記錄會用於日後 ADW 計算。
            如需修改，OWNER 可以「退回草稿」（會記入審計日誌）。
          </p>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button onClick={() => setShowPreflight(false)}
              style={{ flex: 1, padding: '8px 16px', borderRadius: 6, border: '1px solid #ddd', background: '#f5f5f5', cursor: 'pointer', fontSize: 14 }}>
              取消
            </button>
            <button
              onClick={doConfirm}
              disabled={preflight.blockers.length > 0 || confirming}
              title={preflight.blockers.length > 0 ? '請先處理上面紅色項目' : ''}
              style={{
                flex: 1, padding: '8px 16px', borderRadius: 6, border: 'none',
                background: preflight.blockers.length > 0 ? '#9ca3af' : '#2563eb',
                color: '#fff', cursor: preflight.blockers.length > 0 ? 'not-allowed' : 'pointer',
                fontSize: 14, fontWeight: 600,
                opacity: preflight.blockers.length > 0 ? 0.7 : 1,
              }}
            >
              {confirming ? '處理中…' : preflight.blockers.length > 0 ? '有項目未處理' : '確認計糧'}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )}

    {/* ★ 2026-09-10 cwm-payrollui 拍板⑤：⚙️ 顯示欄位 modal — 10 卡 + 14 欄 checkbox；
        強制項 disabled 灰底 🔒（唔隱藏，免得用戶以為漏咗）；「儲存」掣先 PUT（唔即改即存） */}
    {viewSettingOpen && company && createPortal(
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => setViewSettingOpen(false)}>
        <div style={{ background: '#fff', borderRadius: 8, padding: 20, maxWidth: 560, width: '92%', maxHeight: '82vh', overflow: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}
          onClick={e => e.stopPropagation()}>
          <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>⚙️ 顯示欄位</h3>
          <p style={{ fontSize: 12, color: '#888', margin: '0 0 12px' }}>
            全公司統一設定 — 儲存後所有員工睇呢條計糧單嘅顯示都一樣。🔒 = 強制顯示，關唔到。匯出 Excel/PDF 唔跟呢個設定（照舊完整資料）。
          </p>
          <div style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 6px', color: '#444' }}>總覽卡（{CARD_OPTIONS.length}）</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
            {CARD_OPTIONS.map(o => (
              <label key={o.key} style={{
                display: 'flex', gap: 8, alignItems: 'center',
                opacity: o.required ? 0.5 : 1,
                background: o.required ? '#f3f4f6' : 'transparent',
                padding: '4px 6px', borderRadius: 4,
              }}>
                <input type="checkbox" checked={draftCards.includes(o.key)} disabled={o.required}
                  onChange={e => setDraftCards(prev => e.target.checked ? [...prev, o.key] : prev.filter(k => k !== o.key))} />
                <span style={{ fontSize: 13 }}>{o.label}{o.required && ' 🔒'}</span>
              </label>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, margin: '14px 0 6px', color: '#444' }}>表格欄（{COL_OPTIONS.length}）</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
            {COL_OPTIONS.map(o => (
              <label key={o.key} style={{
                display: 'flex', gap: 8, alignItems: 'center',
                opacity: o.required ? 0.5 : 1,
                background: o.required ? '#f3f4f6' : 'transparent',
                padding: '4px 6px', borderRadius: 4,
              }}>
                <input type="checkbox" checked={draftCols.includes(o.key)} disabled={o.required}
                  onChange={e => setDraftCols(prev => e.target.checked ? [...prev, o.key] : prev.filter(k => k !== o.key))} />
                <span style={{ fontSize: 13 }}>{o.label}{o.required && ' 🔒'}</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end', alignItems: 'center' }}>
            {viewSaving && <span style={{ fontSize: 12, color: '#888', marginRight: 'auto' }}>儲存中…</span>}
            <button onClick={() => setViewSettingOpen(false)}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ddd', background: '#f5f5f5', cursor: 'pointer', fontSize: 14 }}>
              取消
            </button>
            <button onClick={handleSaveView} disabled={viewSaving}
              style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff',
                       cursor: viewSaving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
              儲存
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )}
    </div>
    </div>
  )
}
