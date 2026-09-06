'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { hkTodayStr, fmtDate } from '@/lib/hk-date'
import { calcTimebankDebtAmount, prefillTbDeduction, calcMpfDisplay } from '@/lib/settlement-utils'
import { TIMEBANK_MINUTES_PER_DAY } from '@/lib/timebank-constants'

/**
 * 離職結算 Modal（共用元件）— cwm-resigpay-20260904（MD §七）
 *
 * 拍板 B：MANAGER 睇得到預覽（API 已開 OWNER+MANAGER），但「確認離職」＋「確認結算」
 * 只 OPEN OWNER 先見到（POST /resign、/resign-settle 兩邊都 OWNER-only）。
 *
 * 布局（拍板）：max-h-[85vh] flex flex-col，內容 overflow-y-auto，掣固定底部。
 * PDF：離職結算書版式 ＋ 簽名欄，同薪俸結算書共用 printRef ＋ html2canvas。
 * 兩個入口（accounts ＋ overview）同一份。
 */
export interface ResignEmployee {
  employeeId: string
  name: string
  phone?: string
  role?: string
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: '老闆', MANAGER: '經理', ACCOUNTANT: '會計', EMPLOYEE: '員工', KIOSK: 'Kiosk',
}

interface Props {
  employee: ResignEmployee
  userRole: string
  onClose: () => void
  onResigned?: () => void   // 辦理離職成功後（refresh 列表）
  onSettled?: () => void    // 確認結算成功後
}

export default function ResignSettlementModal({ employee, userRole, onClose, onResigned, onSettled }: Props) {
  const [lastDay, setLastDay] = useState(hkTodayStr())
  const [noticeSel, setNoticeSel] = useState('') // '' 未揀 | '0' | '7' | '30' | 'custom'
  const [noticeCustom, setNoticeCustom] = useState('')
  const [tbDeduction, setTbDeduction] = useState('') // ★ cwm-resigv3：預填 min(欠款,1/4上限)，仍可改
  const tbTouchedRef = useRef(false) // 用戶動過掣 → 預填唔好再覆蓋
  const [preview, setPreview] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [resignLoading, setResignLoading] = useState(false)
  const [settleLoading, setSettleLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [settled, setSettled] = useState<any>(null) // 已寫入嘅結算（顯示「已確認」）
  const [punches, setPunches] = useState<Array<{ date: string; in: string | null; out: string | null }>>([])
  const printRef = useRef<HTMLDivElement>(null)

  // ★ 2026-09-05 [cwm-resignroster]：當月打卡記錄 — 純顯示做證明（老細拍板：打卡零計算影響）
  const fetchPunches = useCallback(async () => {
    const m = (lastDay || '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(m)) { setPunches([]); return }
    const [yy, mm] = m.split('-').map(Number)
    const monthEnd = `${m}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`
    const end = lastDay < monthEnd ? lastDay : monthEnd // ★ 證明窗口 = 最後工作日為止
    try {
      const res = await fetch(`/api/punches?employeeId=${employee.employeeId}&startDate=${m}-01&endDate=${end}&pageSize=100`, { credentials: 'include' })
      if (!res.ok) { setPunches([]); return }
      const data = await res.json()
      const byDay: Record<string, { in: string | null; out: string | null }> = {}
      for (const p of data.records ?? []) {
        const k = new Date(p.punchTime).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' })
        // 已批更鐘記錄優先（純顯示）
        const corr = (p.corrections ?? [])[0]
        const t = new Date((corr?.correctedTime ?? p.punchTime))
        const hm = t.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Hong_Kong' })
        if (!byDay[k]) byDay[k] = { in: null, out: null }
        if (p.punchType === 'CLOCK_IN' && !byDay[k].in) byDay[k].in = hm
        else if (p.punchType === 'CLOCK_OUT' && !byDay[k].out) byDay[k].out = hm
      }
      setPunches(Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })))
    } catch { setPunches([]) }
  }, [employee.employeeId, lastDay])
  useEffect(() => { fetchPunches() }, [fetchPunches])

  const isOwner = userRole === 'OWNER' // ROLE-OK: 離職／結算寫入薪金，API 側 resign-settle:25 同 resign:16 都係 OWNER-only，前端 gate 只係唔顯示掣（真正防線喺 API）。冇對應 permission key。
  const s = preview?.leaveSettlement ?? null
  const st = preview?.settlement ?? null
  const tb = st?.timebank

  // Fetch preview（OWNER+MANAGER 都可以）
  const fetchPreview = useCallback(async () => {
    if (!lastDay) return
    setLoading(true)
    try {
      const noticeVal = noticeSel === 'custom' ? Number(noticeCustom || 0)
        : noticeSel === '' ? null : Number(noticeSel)
      const noticeQ = noticeVal == null ? '' : `&noticeDays=${noticeVal}`
      const res = await fetch(
        `/api/employees/${employee.employeeId}/resign-preview?lastDay=${lastDay}${noticeQ}`,
        { credentials: 'include' },
      )
      if (res.ok) {
        const data = await res.json()
        setPreview({ futureShifts: data.futureShifts, futureApprovedLeaves: data.futureApprovedLeaves, leaveSettlement: data.leaveSettlement ?? null, settlement: data.settlement ?? null })
        // ★ cwm-resigv3 拍板②：預填 min(欠款, 1/4 上限)（用戶動過掣就唔覆蓋；lib 純函數同一來源）
        const t = data.settlement?.timebank
        const adv = data.settlement?.adw?.value ?? 0
        if (t && t.debtMinutes > 0 && adv > 0 && !tbTouchedRef.current) {
          const pre = prefillTbDeduction(calcTimebankDebtAmount(t.debtMinutes, adv).tbAmount, t.caps.quarter)
          setTbDeduction(pre > 0 ? pre.toFixed(2) : '')
        }
      } else if (res.status !== 404) {
        const err = await res.json().catch(() => ({}))
        if (err.error) alert(err.error)
      }
    } catch { /* 網絡錯誤 */ }
    finally { setLoading(false) }
  }, [employee.employeeId, lastDay, noticeSel, noticeCustom])

  useEffect(() => { fetchPreview() }, [fetchPreview])

  const noticeDaysVal: number | null = noticeSel === 'custom' ? Number(noticeCustom || 0)
    : noticeSel === '' ? null : Number(noticeSel)

  // ── 辦理離職（OWNER-only）──────────────────────────────
  const handleResign = async () => {
    if (!lastDay) return
    if (!confirm(`確定為「${employee.name}」辦理離職？最後工作日：${lastDay}`)) return
    setResignLoading(true)
    try {
      const res = await fetch(`/api/employees/${employee.employeeId}/resign`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastDay }),
      })
      if (res.ok) {
        onResigned?.()
        onClose()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error || '離職操作失敗')
      }
    } catch { alert('網絡錯誤') }
    finally { setResignLoading(false) }
  }

  // ── 確認離職結算（OWNER-only）寫入 PayrollItem ──────────
  const handleSettle = async () => {
    if (!lastDay) return
    if (noticeDaysVal == null) { alert('請先揀通知期'); return }
    if (st?.monthWage?.source === 'none') { alert('攞唔到當月工資 — 請先生成該月計糧'); return } // 掣已 disabled，雙重防線
    // ★ cwm-resigv3 拍板②：預填即實扣 → 二次確認要明文寫「將扣除 $X」
    const amt = tbDeductionVal ?? 0
    if (!confirm(
      `確定為「${employee.name}」確認離職結算？\n\n` +
      `最後工作日：${lastDay}\n` +
      `應付：$${estPayable.toFixed(2)}\n` +
      (amt > 0 ? `⚠️ 將由尾糧扣除 $${amt.toFixed(2)}（時間帳戶欠款）\n` : '') +
      `寫入之後，月底計糧會直接讀呢份結算。`,
    )) return
    setSettleLoading(true)
    try {
      const body: any = { lastDay, noticeDays: noticeDaysVal }
      if (tbDeduction !== '' && Number.isFinite(Number(tbDeduction))) body.tbDeduction = Number(tbDeduction)
      const res = await fetch(`/api/employees/${employee.employeeId}/resign-settle`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setSettled(data.settlement)
        onSettled?.()
      } else {
        alert(data.error || '結算失敗')
      }
    } catch { alert('網絡錯誤') }
    finally { setSettleLoading(false) }
  }

  // ── PDF 匯出（離職結算書 + 簽名欄）────────────────────
  const exportPdf = async () => {
    if (!printRef.current) return
    setExporting(true)
    try {
      const { default: html2canvas } = await import('html2canvas')
      const { jsPDF } = await import('jspdf')
      const canvas = await html2canvas(printRef.current, {
        scale: 2, backgroundColor: '#ffffff',
        onclone: (doc) => doc.querySelectorAll('.no-print').forEach(el => (el as HTMLElement).style.display = 'none'),
      })
      const pdf = new jsPDF('p', 'mm', 'a4')
      const MARGIN = 12
      const pageW = 210, pageH = 297
      const contentW = pageW - MARGIN * 2
      const contentH = pageH - MARGIN * 2
      const imgH = (canvas.height * contentW) / canvas.width
      const imgData = canvas.toDataURL('image/jpeg', 0.92)
      let offset = 0
      while (offset < imgH) {
        if (offset > 0) pdf.addPage()
        pdf.addImage(imgData, 'JPEG', MARGIN, MARGIN - offset, contentW, imgH)
        pdf.setFillColor(255, 255, 255)
        pdf.rect(0, 0, pageW, MARGIN, 'F')
        pdf.rect(0, pageH - MARGIN, pageW, MARGIN, 'F')
        offset += contentH
      }
      pdf.save(`離職結算書_${employee.name}_${lastDay}.pdf`)
    } finally {
      setExporting(false)
    }
  }

  const currency = (n: number | null | undefined) => n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const tbDeductionVal = tbDeduction !== '' && Number.isFinite(Number(tbDeduction)) ? Number(tbDeduction) : null
  // ★ cwm-resigv3 拍板②：欠款金額 + 預填（min(欠款, 1/4 上限)；正數餘額預填 0）— lib 純函數
  const tbDebtAmount = tb && tb.debtMinutes > 0 && st && st.adw.value > 0
    ? calcTimebankDebtAmount(tb.debtMinutes, st.adw.value).tbAmount
    : 0
  const suggestedDeduction = (tb && tb.debtMinutes > 0) ? prefillTbDeduction(tbDebtAmount, tb.caps.quarter) : 0
  // 預估應付 = 當月工資 + 年假薪酬 + 代通知金 + 時間帳戶正數折現 − MPF（僱員） − 扣除
  //   ★ cwm-resigv3：當月工資「讀唔算」（st.monthWage，none → 0 且確認掣 disabled）；
  //   正數餘額 = 公司欠員工 → 折現（分 ÷ TIMEBANK_MINUTES_PER_DAY 日 × ADW；ADW 攞唔到 → 0）
  const tbPositiveCashout = tb && tb.balanceMinutes > 0 && st && st.adw.value > 0
    ? Math.round((tb.balanceMinutes / TIMEBANK_MINUTES_PER_DAY) * st.adw.value * 100) / 100
    : 0
  // ★ 2026-09-06 [cwm-mpf60] (MD §3.2/§3.3)：MPF 行（僱員 5%）—— 有關入息 = 當月工資＋年假＋通知金＋正數折現（拍板③）；
  //   豁免口徑同 engine 共用 mpf-exemption（60 曆日 + 免供款期）；時間帳戶扣除唔入基數（扣除喺 MPF 之後先扣）
  const mpfRelevantIncome = st
    ? ((st.monthWage?.basePay ?? 0) + (st.unusedLeave?.payout ?? 0) + (st.notice?.pay ?? 0) + tbPositiveCashout)
    : 0
  const mpfDisplay = calcMpfDisplay(s?.joinDate ?? null, lastDay, mpfRelevantIncome)
  const mpfEmployee = st ? mpfDisplay.employee : 0
  const estPayable = (st
    ? ((st.monthWage?.basePay ?? 0) + st.unusedLeave.payout + (st.notice.pay ?? 0) + tbPositiveCashout - mpfEmployee)
    : 0) - (tbDeductionVal || 0)

  // ★ 2026-09-06 [cwm-mpf60] (MD §6.6)：開發期自檢 —— 逐行加起身必須等於預估應付。
  //   今次個 bug 就係「總數有、行冇」—— 下回合加新項目漏行，即刻知。
  if (process.env.NODE_ENV !== 'production' && st) {
    const _lineSum = (st.monthWage?.basePay ?? 0) + (st.unusedLeave?.payout ?? 0) + (st.notice?.pay ?? 0)
      + tbPositiveCashout - (tbDeductionVal ?? 0) - mpfEmployee
    if (Math.abs(_lineSum - estPayable) > 0.01) {
      console.error(`[resign-settlement] ⛔ 逐行加總 ${_lineSum} ≠ 預估應付 ${estPayable}`)
    }
  }

  // ★ cwm-modalfix-20260905：st 未載入（loading / API 失敗）時 footer 嘅 st.xxx 會 throw ——
  //   body 有 {st && (…)} 包住，但 footer 冇。早退一次過解決。
  if (!st && !loading) return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl w-full mx-4 shadow-2xl flex flex-col"
        style={{ maxWidth: 560, maxHeight: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-8">
          <p style={{ fontSize: 14, color: '#333', margin: '0 0 12px' }}>攞唔到結算資料</p>
          <button className="px-4 py-2 rounded-md text-sm" style={{ background: '#eee', color: '#333' }} onClick={onClose}>關閉</button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl w-full mx-4 shadow-2xl flex flex-col"
        style={{ maxWidth: 560, maxHeight: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header（固定） */}
        <div className="px-6 pt-5 pb-3 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-3 shrink-0">
          <div>
            <h3 className="text-lg font-bold text-red-700">👋 辦理離職</h3>
            <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{employee.name}</div>
            <div style={{ fontSize: 11, color: '#888' }}>{employee.phone || ''} {employee.role ? `· ${ROLE_LABELS[employee.role] || employee.role}` : ''}</div>
          </div>
          <button className="text-2xl leading-none text-slate-400 hover:text-slate-600" onClick={onClose} aria-label="關閉">×</button>
        </div>

        {/* Body（可滾動） */}
        <div className="px-6 py-4 overflow-y-auto" style={{ flex: 1 }}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>最後工作日</label>
            <input type="date" value={lastDay} onChange={e => setLastDay(e.target.value)}
              className="px-3 py-2 rounded-md border text-sm w-full" />
          </div>

          {loading && <div style={{ fontSize: 13, color: '#888', marginBottom: 10 }}>載入結算預覽中…</div>}

          {preview && (preview.futureShifts > 0 || preview.futureApprovedLeaves > 0) && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#dc2626', marginBottom: 4 }}>⚠️ 離職後將自動取消：</div>
              <div style={{ fontSize: 12, color: '#7f1d1d' }}>班次：{preview.futureShifts} 個</div>
              <div style={{ fontSize: 12, color: '#7f1d1d' }}>已批假期：{preview.futureApprovedLeaves} 筆</div>
              <div style={{ fontSize: 11, color: '#991b1b', marginTop: 4 }}>（僅取消最後工作日之後的記錄）</div>
            </div>
          )}

          {settled && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: '#166534' }}>
              ✅ 已確認結算（{fmtDate(settled.settledAt)}）—— 已寫入 {settled.lastDay} 當月計糧單。
            </div>
          )}

          {/* ★ 離職結算預覽卡 */}
          {st && (
            <div style={{ padding: 14, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>離職結算預覽</div>
              <div style={{ fontSize: 11, color: '#92400e', marginBottom: 10 }}>
                ⚠️ 純預覽，唔會寫入任何記錄。以最後工作日 {lastDay} 計算。
              </div>

              {/* 通知期 —— 人手輸入（拍板③） */}
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>通知期</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select value={noticeSel} onChange={e => setNoticeSel(e.target.value)}
                    className="px-2 py-1.5 rounded-md border text-sm" style={{ flex: 1 }}>
                    <option value="">請揀……</option>
                    <option value="0">已做足 / 無須通知</option>
                    <option value="7">7 日</option>
                    <option value="30">1 個月</option>
                    <option value="custom">自訂</option>
                  </select>
                  {noticeSel === 'custom' && (
                    <input type="number" min="0" max="365" value={noticeCustom}
                      onChange={e => setNoticeCustom(e.target.value)} placeholder="日數"
                      className="px-2 py-1.5 rounded-md border text-sm" style={{ width: 90 }} />
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>⚠️ 按【合約】填，唔係按 EO 最低。EO 只定下限。</div>
              </div>

              <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                {/* ★ cwm-resigv3：當月工資（讀唔算 — 三態） */}
                {st.monthWage?.source === 'payrollItem' && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                      <span>{lastDay.slice(0, 7)} 當月工資</span><span>{currency(st.monthWage.basePay)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>已生成計糧（讀自計糧單，已按受僱日數 prorate）</div>
                  </>
                )}
                {st.monthWage?.source === 'preview' && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, color: '#b45309' }}>
                      <span>{lastDay.slice(0, 7)} 當月工資</span><span>{currency(st.monthWage.basePay)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#b45309' }}>⚠️ 預覽值，未生成計糧（引擎直算，已 prorate）</div>
                  </>
                )}
                {st.monthWage?.source === 'none' && (
                  <div style={{ fontSize: 12, color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 8px' }}>
                    ⚠️ 攞唔到當月工資 — 請先生成該月計糧（確認結算掣已停用）
                  </div>
                )}
                {/* ★ 2026-09-06 [cwm-caldayratio]：受僱比例拆分（證明 — 分子 = 受僱曆日（含休息日，含頭含尾），分母 = 當月曆日數） */}
                {st.monthWageRatio && st.monthWageRatio.denominator > 0 && (
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    受僱 {st.monthWageRatio.numerator} 日（含休息日）÷ 當月 {st.monthWageRatio.denominator} 日 = {Math.round(st.monthWageRatio.value * 1000) / 10}%
                  </div>
                )}
                {/* ★ cwm-resignroster：當月打卡記錄（純顯示 — 僅供參考，唔影響計算；2026-09-06 [cwm-caldayratio] 保留做參考） */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                  <span>當月打卡記錄（僅供參考，唔影響計算）（{lastDay.slice(0, 7)}，至 {lastDay}）</span>
                  <span>{punches.length} 日</span>
                </div>
                {punches.length > 0 ? (
                  <div style={{ fontSize: 12, color: '#78350f', maxHeight: 96, overflowY: 'auto' }}>
                    {punches.map(p => (
                      <div key={p.date} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{p.date}</span>
                        <span>IN {p.in ?? '—'} · OUT {p.out ?? '—'}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: '#b45309' }}>無打卡記錄（當月工資分子淨係用實際更表＋已批帶薪假，打卡唔計入 — 純證明）</div>
                )}
                {s && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>入職日</span><span>{fmtDate(s.joinDate)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>服務年資</span>
                      <span>{Math.floor(s.serviceMonths / 12)} 年 {s.serviceMonths % 12} 個月{s.serviceMonths < 3 ? ' · 試用期內（年假結算 0 日）' : ''}</span>
                    </div>
                    <div style={{ borderTop: '1px dashed #fbbf24', margin: '4px 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                      <span>年假額度（按月累積，含按比例）</span><span>{s.accrued} 天</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>已用</span><span>− {s.used} 天</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                      <span>未放（可結算）</span><span>{s.unused} 天</span>
                    </div>
                  </>
                )}
                {st.adw.value > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9ca3af', fontSize: 12 }}>
                    <span>Effective ADW{st.adw.source === 'FALLBACK_MONTHLY' ? '（推算：月薪×12÷365）' : ''}</span>
                    <span>${st.adw.value.toLocaleString()}</span>
                  </div>
                )}
                {st.adw.value === 0 && (
                  <div style={{ fontSize: 12, color: '#b45309' }}>
                    ⚠️ 無法計算 ADW（無工資歷史／非月薪制）—— 年假薪酬同代通知金需另行按 ADW 計算
                  </div>
                )}
                {st.adw.value > 0 && (
                  <>
                    <div style={{ borderTop: '1px dashed #fbbf24', margin: '4px 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15 }}>
                      <span>應付年假薪酬（{st.unusedLeave.days} 日 × ADW）</span>
                      <span>{currency(st.unusedLeave.payout)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: st.notice.pay != null ? 600 : 400 }}>
                      <span>代通知金{st.notice.pay != null ? `（${st.notice.days} 日 × ADW）` : '（尚未揀通知期）'}</span>
                      <span>{currency(st.notice.pay)}</span>
                    </div>
                  </>
                )}
                {/* ★ 2026-09-06 [cwm-mpf60] (MD §3.2)：MPF 行（僱員 5%）+ 零理由（拍板②：僱主供款唔顯示） */}
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>強積金（僱員 5%）</span>
                  <span style={{ color: mpfEmployee > 0 ? '#dc2626' : '#94a3b8' }}>
                    {mpfEmployee > 0 ? `−${currency(mpfEmployee)}` : currency(0)}
                  </span>
                </div>
                {mpfEmployee === 0 && mpfDisplay.zeroReason && (
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>{mpfDisplay.zeroReason}</div>
                )}
              </div>

              {/* 時間帳戶（拍板②：人手輸入扣除） */}
              {tb && (
                <div style={{ marginTop: 10, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10, fontSize: 12 }}>
                  {tb.debtMinutes > 0 ? (
                    <>
                      <div style={{ fontWeight: 600, color: '#b91c1c', marginBottom: 4 }}>
                        ⚠️ 時間帳戶欠 {tb.debtMinutes.toLocaleString()} 分（≈ {tb.debtDays} 日）
                        {tb.latestPeriod ? `（截至 ${tb.latestPeriod}）` : ''}
                      </div>
                      {tb.entries?.length > 0 && (
                        <div style={{ color: '#7f1d1d', marginBottom: 6, lineHeight: 1.6 }}>
                          來源（近 {tb.entries.length} 筆出帳）：
                          {tb.entries.slice(0, 3).map((en: any, i: number) => (
                            <span key={i}>{i > 0 && '，'}{fmtDate(en.date)} {en.type} {en.minutes} 分{en.note ? `（${en.note}）` : ''}</span>
                          ))}
                          {tb.entries.length > 3 && ` 等 ${tb.entries.length} 筆`}
                        </div>
                      )}
                      <div style={{ color: '#7f1d1d', display: 'grid', gap: 2 }}>
                        <div>┌ 該工資期工資（prorate 後）${tb.caps.finalPeriodWage.toLocaleString()}</div>
                        <div>│ 四分之一上限（單項扣除法定上限）${tb.caps.quarter.toLocaleString()}</div>
                        <div>│ 一半上限（扣除總額）${tb.caps.half.toLocaleString()}</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>└ 本次扣除（預填，可改）</span>
                          <input type="number" min="0" max={tb.caps.quarter} step="0.01"
                            value={tbDeduction}
                            onChange={e => { tbTouchedRef.current = true; setTbDeduction(e.target.value) }}
                            placeholder="0.00"
                            style={{ width: 110, padding: '3px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, textAlign: 'right' }} />
                        </div>
                      </div>
                      {tbDebtAmount > tb.caps.quarter && (
                        <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                          ⚠️ 欠款 ${tbDebtAmount.toFixed(2)} 超法定上限，預填已按上限 ${tb.caps.quarter.toFixed(2)}，
                          差額 ${(tbDebtAmount - tb.caps.quarter).toFixed(2)} 需另行處理。
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#991b1b', marginTop: 6 }}>{tb.deductionNote}</div>
                    </>
                  ) : (
                    <>
                      <div style={{ color: '#374151' }}>
                        時間帳戶：{tb.balanceMinutes >= 0 ? '+' : ''}{tb.balanceMinutes.toLocaleString()} 分
                        {tb.latestPeriod ? `（截至 ${tb.latestPeriod}）` : ''}
                      </div>
                      {/* ★ 2026-09-06 [cwm-mpf60] (MD §6.3)：正數折現要獨立成行 —— 原本只喺總數入面睇唔到；
                          而「本次唔涉及扣薪」有誤導（佢唔扣薪，但【加落應付】）→ 改寫移除 */}
                      {tbPositiveCashout > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                          <span>時間帳戶折現（{(tb.balanceMinutes / TIMEBANK_MINUTES_PER_DAY).toFixed(2)} 日 × ADW）</span>
                          <span style={{ color: '#059669' }}>+{currency(tbPositiveCashout).slice(1)}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* 預估應付 + EO s.25 */}
              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, borderTop: '1px solid #fbbf24', paddingTop: 8 }}>
                <span>預估應付（當月工資＋年假＋通知金＋正數折現−MPF−扣除）</span>
                <span>{currency(estPayable)}</span>
              </div>
              <div style={{ fontSize: 12, color: '#1d4ed8', marginTop: 8, fontWeight: 600 }}>
                📅 EO s.25：須於 {st.settleByDate} 或之前付清全部尾糧（最後工作日 +7 日）
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 8, lineHeight: 1.5 }}>
                當月工資「讀唔算」：讀自計糧單／引擎預覽（已按受僱日數 prorate），結算卡唔重算。<br />
                年假按月累積（EO s.41D）；未滿 3 個月 = 0 日（EO s.41C）。休息日唔換錢（EO s.17）。
              </div>
            </div>
          )}
        </div>

        {/* Footer（固定底部） */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-end gap-2 shrink-0 flex-wrap">
          <button className="px-4 py-2 rounded-md text-sm" style={{ background: '#eee', color: '#333' }} onClick={onClose}>取消</button>
          <button className="px-4 py-2 rounded-md text-sm" style={{ background: '#1d4ed8', color: '#fff' }}
            onClick={exportPdf} disabled={exporting || !st}>
            {exporting ? '匯出中…' : '📄 離職結算書 PDF'}
          </button>
          {isOwner && (
            <button className="px-4 py-2 rounded-md text-sm" style={{ background: '#7c3aed', color: '#fff' }}
              onClick={handleSettle}
              disabled={settleLoading || !st || settled != null || st.monthWage?.source === 'none'}>
              {settleLoading ? '處理中…' : st?.monthWage?.source === 'none' ? '確認離職結算（缺當月工資）' : '確認離職結算'}
            </button>
          )}
          {isOwner && (
            <button className="px-4 py-2 rounded-md text-sm" style={{ background: '#dc2626', color: '#fff' }}
              onClick={handleResign} disabled={resignLoading || !lastDay}>
              {resignLoading ? '處理中…' : '確認離職'}
            </button>
          )}
        </div>
      </div>

      {/* 隱藏 print 區域：離職結算書（PDF 來源） */}
      <div ref={printRef} style={{ position: 'fixed', left: -9999, top: 0, width: 794, background: '#fff', color: '#000', padding: 32, fontFamily: 'sans-serif' }}>
        <div style={{ fontSize: 22, fontWeight: 700, textAlign: 'center', marginBottom: 4 }}>離職結算書</div>
        <div style={{ fontSize: 11, textAlign: 'center', color: '#555', marginBottom: 20 }}>Resignation Settlement Statement</div>
        <table style={{ width: '100%', fontSize: 13, marginBottom: 16 }}>
          <tbody>
            <tr><td style={{ padding: '3px 0', width: 140, color: '#555' }}>員工姓名</td><td style={{ padding: '3px 0', fontWeight: 600 }}>{employee.name}</td>
                <td style={{ padding: '3px 0', width: 140, color: '#555' }}>電話</td><td style={{ padding: '3px 0' }}>{employee.phone || '—'}</td></tr>
            <tr><td style={{ padding: '3px 0', color: '#555' }}>最後工作日</td><td style={{ padding: '3px 0', fontWeight: 600 }}>{lastDay}</td>
                <td style={{ padding: '3px 0', color: '#555' }}>EO s.25 尾糧期限</td><td style={{ padding: '3px 0' }}>{st?.settleByDate || '—'}</td></tr>
            <tr><td style={{ padding: '3px 0', color: '#555' }}>Effective ADW</td><td style={{ padding: '3px 0' }}>{currency(st?.adw?.value)}{st?.adw?.source === 'FALLBACK_MONTHLY' ? '（推算）' : ''}</td>
                <td style={{ padding: '3px 0', color: '#555' }}>服務年資</td><td style={{ padding: '3px 0' }}>{s ? `${Math.floor(s.serviceMonths / 12)} 年 ${s.serviceMonths % 12} 個月` : '—'}</td></tr>
          </tbody>
        </table>

        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderTop: '2px solid #000', borderBottom: '1px solid #000' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>項目</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>金額 (HK$)</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={{ padding: '6px 8px' }}>當月工資（{lastDay.slice(0, 7)}，已 prorate）</td>
              <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                {st?.monthWage?.source === 'none' ? '—' : currency(st?.monthWage?.basePay)}
                {st?.monthWage?.source === 'preview' && <span style={{ fontSize: 11 }}>（預覽值，未生成計糧）</span>}
              </td></tr>
            <tr><td style={{ padding: '6px 8px' }}>年假薪酬（{st?.unusedLeave?.days ?? 0} 日 × ADW）</td><td style={{ textAlign: 'right', padding: '6px 8px' }}>{currency(st?.unusedLeave?.payout)}</td></tr>
            <tr><td style={{ padding: '6px 8px' }}>代通知金{st?.notice?.pay != null ? `（${st?.notice?.days} 日 × ADW）` : ''}</td><td style={{ textAlign: 'right', padding: '6px 8px' }}>{currency(st?.notice?.pay)}</td></tr>
            {/* ★ 2026-09-06 [cwm-mpf60] (MD §6.4)：正數折現獨立行（同畫面一致）；
                同欠款扣除行互斥 —— 兩行都有條件，唔會出 $0.00 廢行 */}
            {tbPositiveCashout > 0 && tb && (
              <tr>
                <td style={{ padding: '6px 8px' }}>時間帳戶折現（{(tb.balanceMinutes / TIMEBANK_MINUTES_PER_DAY).toFixed(2)} 日 × ADW）</td>
                <td style={{ textAlign: 'right', padding: '6px 8px' }}>{currency(tbPositiveCashout)}</td>
              </tr>
            )}
            {tbDeductionVal != null && tbDeductionVal > 0 && (
              <tr><td style={{ padding: '6px 8px' }}>時間帳戶欠款扣除（人手）</td><td style={{ textAlign: 'right', padding: '6px 8px' }}>−{currency(tbDeductionVal).slice(1)}</td></tr>
            )}
            {/* ★ 2026-09-06 [cwm-mpf60] (MD §6.5)：MPF 行（僱員 5%）—— PDF 係俾員工簽收嘅，
                顯示 $0.00 而唔講原因，員工會以為公司漏供 */}
            <tr>
              <td style={{ padding: '6px 8px' }}>強積金（僱員 5%）</td>
              <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                {mpfEmployee > 0 ? `−${currency(mpfEmployee).slice(1)}` : currency(0)}
              </td>
            </tr>
            {mpfEmployee === 0 && mpfDisplay.zeroReason && (
              <tr><td colSpan={2} style={{ padding: '2px 8px', fontSize: 11, color: '#888' }}>{mpfDisplay.zeroReason}</td></tr>
            )}
            <tr style={{ borderTop: '1px solid #000', fontWeight: 700 }}>
              <td style={{ padding: '6px 8px' }}>預估應付</td><td style={{ textAlign: 'right', padding: '6px 8px' }}>{currency(estPayable)}</td>
            </tr>
          </tbody>
        </table>

        <div style={{ fontSize: 10, color: '#555', marginTop: 12, lineHeight: 1.6 }}>
          當月工資「讀唔算」：讀自計糧單（已按受僱日數 prorate）或引擎預覽；結算書不重算。年假按月累積含按比例（EO s.41D）；服務未滿 3 個月年假結算 0 日（EO s.41C）。
          時間帳戶扣除受 EO s.32 限制（單項 ≤ 該工資期工資 1/4，預填 min(欠款, 上限) 仍可改）。休息日系法定權利，唔換錢（EO s.17）。
        </div>

        {/* 簽名欄 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 48 }}>
          <div style={{ width: '45%' }}>
            <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 12 }}>僱主簽署：____________________</div>
            <div style={{ fontSize: 11, color: '#555', marginTop: 6 }}>日期：______________</div>
          </div>
          <div style={{ width: '45%' }}>
            <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 12 }}>員工簽署：____________________</div>
            <div style={{ fontSize: 11, color: '#555', marginTop: 6 }}>日期：______________</div>
          </div>
        </div>
      </div>
    </div>
  )
}
