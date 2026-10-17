// ★ cwm-tbmanual-20261017 ①：手動調整時間帳戶卡（假期管理頁，OWNER only）
// 同初始化（覆寫基準）唔同：手動調整係【累加】，每次一行，唔會刪舊嘅。
//   · 預覽行：「而家 X 分鐘 → 調整後 Y 分鐘（±h 小時 m 分）」— call /api/timebank/manual-adjust/preview
//   · |分鐘| > 480 → 409 CONFIRM_REQUIRED → 彈確認 modal，撳確定先帶 confirmLarge 再送
//   · 成功後清空欄位、busy=false（PR #81 ManualForm 卡住「儲存中…」嘅教訓）
'use client'

import { useEffect, useState } from 'react'

interface Emp { id: string; user?: { name?: string | null } | null }

export default function TimebankManualAdjustCard({ employees }: { employees: Emp[] }) {
  const [form, setForm] = useState({
    employeeId: '', direction: 'add' as 'add' | 'deduct',
    hours: '', minutes: '', effectiveMonth: new Date().toISOString().slice(0, 7), reason: '',
  })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [preview, setPreview] = useState<{ balance: number } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // 409 CONFIRM_REQUIRED 待確認狀態
  const [pending, setPending] = useState<{ minutes: number; reason: string; effectiveMonth: string; employeeId: string } | null>(null)

  const totalMinutes = (parseInt(form.hours, 10) || 0) * 60 + (parseInt(form.minutes, 10) || 0)
  const signedMinutes = form.direction === 'add' ? totalMinutes : -totalMinutes

  // 預覽：揀咗員工＋月份就 call preview
  useEffect(() => {
    if (!form.employeeId || !form.effectiveMonth) { setPreview(null); return }
    let alive = true
    setPreviewLoading(true)
    fetch(`/api/timebank/manual-adjust/preview?employeeId=${encodeURIComponent(form.employeeId)}&month=${encodeURIComponent(form.effectiveMonth)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setPreview(d ? { balance: d.balance } : null) })
      .catch(() => { if (alive) setPreview(null) })
      .finally(() => { if (alive) setPreviewLoading(false) })
    return () => { alive = false }
  }, [form.employeeId, form.effectiveMonth])

  const doSubmit = async (confirmLarge: boolean) => {
    setBusy(true)
    setResult('')
    try {
      const res = await fetch('/api/timebank/manual-adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          employeeId: form.employeeId, minutes: signedMinutes,
          effectiveMonth: form.effectiveMonth, reason: form.reason,
          ...(confirmLarge ? { confirmLarge: true } : {}),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 409 && d.code === 'CONFIRM_REQUIRED') {
        // 前端彈確認框，再送一次帶 confirmLarge: true
        setPending({ minutes: signedMinutes, reason: form.reason, effectiveMonth: form.effectiveMonth, employeeId: form.employeeId })
        return
      }
      if (!res.ok) {
        setResult(`❌ ${d.error || '提交失敗'}`)
        return
      }
      setResult(`✅ 已記 ${d.balanceBefore} → ${d.balanceAfter} 分鐘（${signedMinutes >= 0 ? '+' : ''}${signedMinutes}）`)
      // ★ 成功後清空欄位、busy=false
      setForm(f => ({ ...f, hours: '', minutes: '', reason: '' }))
    } catch (e: any) {
      setResult(`❌ 網絡錯誤：${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = async () => {
    if (!form.employeeId) { setResult('❌ 請選擇員工'); return }
    if (signedMinutes === 0) { setResult('❌ 小時／分鐘唔可以全為 0'); return }
    if (parseInt(form.minutes, 10) > 59) { setResult('❌ 分鐘必須喺 0–59'); return }
    if (!form.reason.trim()) { setResult('❌ 原因必填'); return }
    await doSubmit(false)
  }

  const onConfirmLarge = async () => {
    if (!pending) return
    const p = pending
    setPending(null)
    // 帶同一份數據再送（confirmLarge: true）
    const savedForm = { ...form }
    setBusy(true)
    try {
      const res = await fetch('/api/timebank/manual-adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          employeeId: p.employeeId, minutes: p.minutes,
          effectiveMonth: p.effectiveMonth, reason: p.reason, confirmLarge: true,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setResult(`❌ ${d.error || '提交失敗'}`); setForm(savedForm); return }
      setResult(`✅ 已記 ${d.balanceBefore} → ${d.balanceAfter} 分鐘（${p.minutes >= 0 ? '+' : ''}${p.minutes}）`)
      setForm(f => ({ ...f, hours: '', minutes: '', reason: '' }))
    } catch (e: any) {
      setResult(`❌ 網絡錯誤：${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  const fmtHM = (n: number) => {
    const a = Math.abs(n)
    const h = Math.floor(a / 60), m = a % 60
    return `${n >= 0 ? '+' : '−'}${h} 小時${m ? ` ${m} 分` : ''}`
  }

  return (
    <section className="card p-4 border border-emerald-200 rounded-lg mb-4" style={{ background: '#f0fdf4' }}>
      <h3 className="font-semibold mb-2">✏️ 手動調整時間帳戶</h3>
      <p className="text-sm text-muted-foreground mb-3">
        累加語義：每次一行，唔會刪舊嘅（同初始化唔同）。錄錯唔准刪除 — 喺帳本行撳「撤銷」，系統自動寫一行相反數（每行只可以撤銷一次）。
      </p>
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">員工</label>
          <select value={form.employeeId} onChange={e => setForm({ ...form, employeeId: e.target.value })}
            className="px-3 py-2 rounded-md border text-sm">
            <option value="">-- 選擇 --</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.user?.name || e.id}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">加／扣</label>
          <div className="flex rounded-md border overflow-hidden">
            <button type="button" onClick={() => setForm({ ...form, direction: 'add' })}
              className={`px-3 py-2 text-sm ${form.direction === 'add' ? 'bg-emerald-600 text-white' : 'bg-white'}`}>加</button>
            <button type="button" onClick={() => setForm({ ...form, direction: 'deduct' })}
              className={`px-3 py-2 text-sm ${form.direction === 'deduct' ? 'bg-red-600 text-white' : 'bg-white'}`}>扣</button>
          </div>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">小時</label>
          <input type="number" min={0} value={form.hours} onChange={e => setForm({ ...form, hours: e.target.value })}
            className="px-3 py-2 rounded-md border text-sm w-20" placeholder="0" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">分鐘（0–59）</label>
          <input type="number" min={0} max={59} value={form.minutes} onChange={e => setForm({ ...form, minutes: e.target.value })}
            className="px-3 py-2 rounded-md border text-sm w-20" placeholder="0" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">計入月份</label>
          <input type="month" value={form.effectiveMonth} onChange={e => setForm({ ...form, effectiveMonth: e.target.value })}
            className="px-3 py-2 rounded-md border text-sm" />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="block text-xs text-muted-foreground mb-1">原因（必填）</label>
          <input type="text" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
            className="px-3 py-2 rounded-md border text-sm w-full" placeholder="如：上個月多計咗" maxLength={200} />
        </div>
        <button
          className="px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors"
          style={{ background: '#059669' }}
          onClick={onSubmit}
          disabled={busy}
        >
          {busy ? '處理中...' : '記入'}
        </button>
      </div>

      {/* 即時預覽 */}
      {form.employeeId && (
        <div className="p-3 bg-emerald-100 rounded-lg text-sm" style={{ marginTop: 8 }}>
          {previewLoading ? '預覽載入中…' : preview ? (
            signedMinutes !== 0 ? (
              <>而家 {preview.balance} 分鐘 → 調整後 {preview.balance + signedMinutes} 分鐘（{fmtHM(signedMinutes)}）</>
            ) : (
              <>而家 {preview.balance} 分鐘</>
            )
          ) : '（預覽不可用）'}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 13,
          background: result.startsWith('✅') ? '#f0fff4' : '#fff5f5',
          color: result.startsWith('✅') ? '#22543d' : '#c53030',
          border: `1px solid ${result.startsWith('✅') ? '#c6f6d5' : '#fed7d7'}` }}>
          {result}
        </div>
      )}

      {/* 超過 8 小時確認 modal */}
      {pending && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 20, maxWidth: 420, width: '90%' }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>⚠️ 確認大額調整</div>
            <div style={{ fontSize: 14, marginBottom: 16 }}>
              今次調整超過 8 小時（{fmtHM(pending.minutes)}），確定？
            </div>
            <div className="flex gap-3 justify-end">
              <button className="px-4 py-2 rounded-md border text-sm" onClick={() => setPending(null)} disabled={busy}>取消</button>
              <button className="px-4 py-2 rounded-md text-sm text-white" style={{ background: '#d97706' }} onClick={onConfirmLarge} disabled={busy}>
                確定
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
