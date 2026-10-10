'use client'

// ============================================================
// ★ cwm-dailyv3-20261010 §3：共用「就地核對」組件（由 DailyReviewRow 抽出）
//   caller：
//     - 醫生月結預覽 DailyReviewRow（逐日行內細表，A 區預覽就地核對）
//     - 每日大數 DailyCheckPanel 多日列表（② 全部醫生・多日）
//     - 每日大數頁 ③ 逐日行「全店核對」欄
//   行為（同原 DailyReviewRow 行內細表一樣）：
//     - 開細表 → 逐日 GET /check 攞護士名單（⚠ nurses 係逐日計，唔可以全月共用）
//     - 攞失敗 → 錯誤＋【重試】（nurseKey+1 重新 GET，同 400 機制）
//     - 409「數字啱啱變咗」→ 細表保持打開，提示重新計算
//     - 409「已經核對／有人核對咗」→ onAlreadyChecked()（當成功，上層處理提示）
//     - 400「唔屬於呢間店」→ 護士名單過期，重新 GET
//     - 送出期間掣 disabled
//   client 零 prisma：零 lib import（純 apiFetch）。
// ============================================================
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

interface Nurse { employeeId: string; name: string; onShift: boolean }
interface CheckData { days: unknown[]; nurses: Nurse[] | null; canCheck: boolean }

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function InlineDayCheck({ clinicId, clinicLabel, date, storeTotal, status = 'UNCHECKED', onSuccess, onAlreadyChecked, onClose }: {
  clinicId: string
  clinicLabel: string
  date: string
  /** 嗰日全店收款（全店口徑；同 createCheck 伺服器端比較嘅數同一個） */
  storeTotal: number
  /** UNCHECKED → 【確認核對】；CHANGED → 【確認重新核對】 */
  status?: 'UNCHECKED' | 'CHANGED'
  /** 核對成功（server 200）——上層：預覽 = applyLocalCheck；②③ = 重新 GET 核對狀態 */
  onSuccess: (nurseName: string) => void
  /** 409「已核對／有人核對」——上層提示＋重新攞真實狀態 */
  onAlreadyChecked: () => void
  onClose: () => void
}) {
  const [nurseKey, setNurseKey] = useState(0)
  const [nurses, setNurses] = useState<Nurse[] | null>(null)
  const [canCheck, setCanCheck] = useState<boolean | null>(null)
  const [nurseId, setNurseId] = useState('')
  const [ticked, setTicked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [checkError, setCheckError] = useState('')

  // ── 逐日 GET 護士名單（⚠ nurses 係逐日計，唔可以全月共用）────────────
  useEffect(() => {
    let cancelled = false
    setNurses(null); setCanCheck(null); setNurseId(''); setTicked(false); setCheckError('')
    const q = new URLSearchParams({ clinicId, from: date, to: date })
    apiFetch<CheckData>(`/api/payout-runs/daily/check?${q}`)
      .then(d => { if (!cancelled) { setNurses(d.nurses); setCanCheck(d.canCheck) } })
      .catch(e => { if (!cancelled) setCheckError(e.message || '載入護士名單失敗') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, nurseKey, clinicId])

  // ── 送出 ──────────────────────────────────────────────────────
  async function submitCheck() {
    if (!nurseId || !ticked) return
    setSubmitting(true); setCheckError('')
    try {
      // expectedAmount = 嗰行顯示緊嘅全店收款
      await apiFetch('/api/payout-runs/daily/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clinicId, date, nurseEmployeeId: nurseId, expectedAmount: storeTotal }),
      })
      const nurse = (nurses ?? []).find(n => n.employeeId === nurseId)
      onSuccess(nurse?.name ?? '')
      onClose()
    } catch (e: any) {
      const st = e?.status as number | undefined
      const msg: string = e?.message || '核對失敗'
      if (st === 409) {
        if (msg.includes('數字啱啱變咗')) {
          // 全店數字有更新 → 提示重新計算，表格保持打開
          setCheckError('全店數字有更新，請撳 ↻ 重新計算')
        } else {
          // 「呢日已經核對咗」／「啱啱已經有人核對咗」→ 當成功：上層提示＋重新攞真實狀態
          onAlreadyChecked()
          onClose()
        }
      } else if (st === 400 && msg.includes('唔屬於呢間店')) {
        // 護士名單過期 → 重新 GET
        setCheckError('護士名單已更新，請重新揀')
        setNurseId('')
        setNurseKey(k => k + 1)
      } else {
        setCheckError(msg)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border border-gray-300 rounded-md bg-gray-50 p-3 text-sm" role="region" aria-label={`核對 ${date}`}>
      <div className="font-semibold mb-2 text-gray-800">核對 {date.slice(5)} 全店：{money(storeTotal)}</div>
      {nurses === null && canCheck === null ? (
        checkError ? (
          // 護士名單 GET 失敗 → 顯示錯誤＋【重試】（nurseKey+1 重新 GET，同 400 機制）
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-red-700">⚠ {checkError}</span>
            <button type="button" onClick={() => setNurseKey(k => k + 1)} disabled={submitting}
              className="h-6 px-2 rounded border border-gray-400 bg-white text-xs hover:bg-gray-100 disabled:opacity-50">重試</button>
          </div>
        ) : (
          <div className="text-xs text-gray-500">載入護士名單…</div>
        )
      ) : (
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1 text-xs text-gray-700">核對護士
            <select value={nurseId} onChange={e => setNurseId(e.target.value)} disabled={submitting || canCheck === false}
              className="h-8 px-2 border rounded text-xs min-w-[180px] bg-white">
              <option value="">— 請揀護士 —</option>
              {(nurses ?? []).some(n => n.onShift) && (
                <optgroup label={`今日喺 ${clinicLabel} 返工`}>
                  {(nurses ?? []).filter(n => n.onShift).map(n => <option key={n.employeeId} value={n.employeeId}>{n.name}</option>)}
                </optgroup>
              )}
              <optgroup label={`其他 ${clinicLabel} 員工`}>
                {(nurses ?? []).filter(n => !n.onShift).map(n => <option key={n.employeeId} value={n.employeeId}>{n.name}</option>)}
              </optgroup>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs pb-1">
            <input type="checkbox" className="w-4 h-4" checked={ticked} onChange={e => setTicked(e.target.checked)} disabled={submitting || canCheck === false} />
            已核對：系統收款 <b className="tabular-nums">{money(storeTotal)}</b> 同 Apricot 日結／收銀一致
          </label>
          <button type="button" onClick={submitCheck} disabled={submitting || !nurseId || !ticked || canCheck === false}
            className="h-8 px-3 rounded bg-teal-700 text-white text-xs font-semibold disabled:opacity-40">
            {submitting ? '處理中…' : status === 'CHANGED' ? '確認重新核對' : '確認核對'}
          </button>
          <button type="button" onClick={onClose} disabled={submitting}
            className="h-8 px-3 rounded border bg-white text-xs disabled:opacity-50">取消</button>
        </div>
      )}
      {checkError && nurses !== null && <div className="text-xs text-red-700 mt-2">⚠ {checkError}</div>}
      {canCheck === false && <div className="text-xs text-red-700 mt-2">店舖帳號只可以核對自己間店。</div>}
    </div>
  )
}
