'use client'

// ============================================================
// ★ cwm-dailycheck-20261006：每日大數 —— 護士核對（每店每日一次）
//   單日：揀護士 + 剔已核對 → 記低核對時金額；之後數字變咗 → 紅框「要重新核對」
//   範圍：逐日核對狀態一覽（預設只顯示未核對／有變），撳「睇呢日」跳去單日做核對
// ============================================================
import { Fragment, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { todayHK } from '@/lib/hk-date'
import type { DayCheckState } from '@/lib/payout/daily-check'
import { InlineDayCheck } from './InlineDayCheck'

// 唔好 import daily-report（佢 import prisma，會入 client bundle）—— 同 dayLabel 一樣嘅格式
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const dayLabel = (d: string) => `${d}（${WEEK[new Date(`${d}T12:00:00+08:00`).getUTCDay()]}）`

interface Nurse { employeeId: string; name: string; onShift: boolean }
interface CheckData { days: DayCheckState[]; nurses: Nurse[] | null; canCheck: boolean }

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (n: number) => (n >= 0 ? '+' : '−') + money(Math.abs(n))
const hhmm = (iso: string) => new Date(iso).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

export function DailyCheckPanel({ clinicId, clinicLabel, from, to, currentRows, reloadKey, onPickDate, cellProgress }: {
  clinicId: string
  clinicLabel: string
  from: string
  to: string
  /** 而家逐醫生金額（單日先用；同核對時快照比較，標出邊個醫生變咗） */
  currentRows: Array<{ key: string; label: string; storeTotal: number }>
  reloadKey: number
  onPickDate: (date: string) => void
  /** ★ cwm-dailyv2-20261007 ④：逐格 tick 進度（只係提示，唔擋「確認核對」）；null = 非單日/冇格 */
  cellProgress?: { done: number; total: number } | null
}) {
  const [data, setData] = useState<CheckData | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [nurseId, setNurseId] = useState('')
  const [ticked, setTicked] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [reason, setReason] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(true)
  // ★ cwm-dailyv3-20261010 §4：多日列表就地核對 —— 同一時間只開一行（inlineDate）
  const [inlineDate, setInlineDate] = useState<string | null>(null)
  const [localReload, setLocalReload] = useState(0) // 核對成功 → 重新 GET 本 panel 狀態
  const [justChecked, setJustChecked] = useState<Set<string>>(new Set()) // 啱啱核對嘅行留在「只顯示未核對／有變」
  const single = from === to
  const today = todayHK()
  // ★ cwm-dailyv2-20261007 ④：「逐格已對 n/總有數格」— 全部對晒先綠字
  const cellHint = cellProgress && cellProgress.total > 0 ? (
    <div className={`text-xs ${cellProgress.done === cellProgress.total ? 'text-green-700 font-semibold' : 'text-gray-500'}`}>
      逐格已對 {cellProgress.done}/{cellProgress.total}{cellProgress.done === cellProgress.total ? ' ✓' : ''}
    </div>
  ) : null

  async function load() {
    setError('')
    try {
      const q = new URLSearchParams({ clinicId, from, to })
      setData(await apiFetch<CheckData>(`/api/payout-runs/daily/check?${q}`))
    } catch (e: any) { setError(e.message); setData(null) }
  }
  useEffect(() => { setNurseId(''); setTicked(false); setRevoking(false); setReason(''); setInlineDate(null); setJustChecked(new Set()); load() // eslint-disable-line react-hooks/exhaustive-deps
  }, [clinicId, from, to, reloadKey, localReload])

  if (error) return <div className="p-3 mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md">⚠️ 護士核對：{error}</div>
  if (!data) return null

  // ─── 範圍：逐日一覽 ───────────────────────────────────────────
  if (!single) {
    const n = (s: string) => data.days.filter(d => d.status === s).length
    const rows = onlyOpen ? data.days.filter(d => d.status !== 'CHECKED' || justChecked.has(d.date)) : data.days
    return (
      <div className="border rounded-lg mb-4 overflow-hidden bg-white" role="region" aria-label="護士核對一覽">
        <div className="flex flex-wrap justify-between items-center gap-2 px-4 py-3">
          <b>{clinicLabel} · {from} 至 {to} · 護士核對</b>
          <span className="text-sm text-gray-600">有收款 {data.days.length} 日 · <b className="text-green-700">已核對 {n('CHECKED')}</b> · <b className="text-red-700">有變 {n('CHANGED')}</b> · <b className="text-amber-700">未核對 {n('UNCHECKED')}</b></span>
        </div>
        <div className="px-4 pb-1 text-xs text-gray-500">逐格剔要揀單日（撳上面「睇呢日 →」）</div>
        <label className="flex items-center gap-2 px-4 pb-2 text-sm"><input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} />只顯示未核對／有變</label>
        <table className="w-full text-sm">
          <thead className="bg-[#1F4E79] text-white">
            <tr><th className="text-left p-2">日期</th><th className="text-right p-2">收款</th><th className="text-left p-2">核對</th><th className="text-left p-2">護士 · 時間</th><th className="p-2"></th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-gray-500">{onlyOpen ? '全部已核對 ✓' : '呢段日子冇收款'}</td></tr>}
            {rows.map(d => {
              const future = d.date > today // 未到嘅日子唔出掣（client 端 HK 日期字串比較）
              return (
                <Fragment key={d.date}>
                  <tr className={`border-t ${d.status === 'CHANGED' ? 'bg-red-50' : d.status === 'UNCHECKED' ? 'bg-amber-50' : justChecked.has(d.date) ? 'bg-green-50' : ''}`}>
                    <td className="p-2">{dayLabel(d.date).slice(5)}</td>
                    <td className="p-2 text-right tabular-nums">{money(d.storeTotal)}</td>
                    <td className={`p-2 font-semibold ${d.status === 'CHECKED' ? 'text-green-700' : d.status === 'CHANGED' ? 'text-red-700' : 'text-amber-800'}`}>
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {d.status === 'CHECKED' ? `✓ 已核對${justChecked.has(d.date) ? '（啱啱核對）' : ''}` : d.status === 'CHANGED' ? '⚠ 核對後有變' : '未核對'}
                        {d.status === 'UNCHECKED' && !future && d.storeTotal > 0 && data.canCheck && (
                          <button type="button" onClick={() => setInlineDate(inlineDate === d.date ? null : d.date)}
                            className="h-6 px-2 rounded border border-green-600 text-green-700 text-xs bg-white hover:bg-green-50">核對</button>
                        )}
                        {d.status === 'CHANGED' && !future && d.storeTotal > 0 && data.canCheck && (
                          <button type="button" onClick={() => setInlineDate(inlineDate === d.date ? null : d.date)}
                            className="h-6 px-2 rounded border border-red-600 text-red-700 text-xs bg-white hover:bg-red-50">重新核對</button>
                        )}
                      </span>
                    </td>
                    <td className="p-2 text-gray-600">{d.check ? `${d.check.nurseName} · ${hhmm(d.check.checkedAt)}${d.status === 'CHANGED' ? `（核對時 ${money(d.check.amount)}）` : ''}` : '—'}</td>
                    <td className="p-2 text-right"><button type="button" onClick={() => onPickDate(d.date)} className="text-blue-700 underline text-xs">睇呢日 →</button></td>
                  </tr>
                  {/* ★ cwm-dailyv3-20261010 §4：撳【核對】→ 嗰行下面展開 InlineDayCheck（同一時間只開一行） */}
                  {inlineDate === d.date && (
                    <tr className="border-t bg-white">
                      <td colSpan={5} className="p-3">
                        <InlineDayCheck
                          clinicId={clinicId}
                          clinicLabel={clinicLabel}
                          date={d.date}
                          storeTotal={d.storeTotal}
                          status={d.status === 'CHANGED' ? 'CHANGED' : 'UNCHECKED'}
                          onSuccess={() => {
                            setJustChecked(s => new Set(s).add(d.date)) // 啱啱核對嗰行留住
                            setInlineDate(null)
                            setLocalReload(k => k + 1) // 重新 load 呢個 panel 核對狀態
                          }}
                          onAlreadyChecked={() => setLocalReload(k => k + 1)}
                          onClose={() => setInlineDate(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  // ─── 單日 ─────────────────────────────────────────────────────
  const day = data.days[0]
  const total = day?.storeTotal ?? 0
  if (!day) {
    return <div className="mb-4 p-3 text-sm text-gray-600 border rounded-md bg-gray-50">護士核對：{clinicLabel} {from} 冇收款，唔使核對。</div>
  }

  async function submit() {
    setBusy(true)
    try {
      await apiFetch('/api/payout-runs/daily/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clinicId, date: from, nurseEmployeeId: nurseId, expectedAmount: total }),
      })
      await load(); setNurseId(''); setTicked(false)
    } catch (e: any) { alert(e.message || '核對失敗'); await load() } finally { setBusy(false) }
  }
  async function revoke() {
    setBusy(true)
    try {
      await apiFetch('/api/payout-runs/daily/check/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clinicId, date: from, reason }),
      })
      setRevoking(false); setReason(''); await load()
    } catch (e: any) { alert(e.message || '取消失敗'); await load() } finally { setBusy(false) }
  }

  const form = (label: string) => (
    <div className="flex flex-wrap gap-4 items-end">
      <label className="flex flex-col gap-1 text-sm text-gray-700">核對護士
        <select value={nurseId} onChange={e => setNurseId(e.target.value)} disabled={busy || !data.canCheck}
          className="h-10 px-2 border rounded-md text-sm min-w-[220px] bg-white" aria-label="核對護士">
          <option value="">— 請揀護士 —</option>
          {(data.nurses ?? []).some(n => n.onShift) && (
            <optgroup label={`今日喺 ${clinicLabel} 返工`}>
              {(data.nurses ?? []).filter(n => n.onShift).map(n => <option key={n.employeeId} value={n.employeeId}>{n.name}</option>)}
            </optgroup>
          )}
          <optgroup label={`其他 ${clinicLabel} 員工`}>
            {(data.nurses ?? []).filter(n => !n.onShift).map(n => <option key={n.employeeId} value={n.employeeId}>{n.name}</option>)}
          </optgroup>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm pb-2">
        <input type="checkbox" className="w-5 h-5" checked={ticked} onChange={e => setTicked(e.target.checked)} disabled={busy || !data.canCheck} />
        已核對：系統收款 <b className="tabular-nums">{money(total)}</b> 同 Apricot 日結／收銀一致
      </label>
      <button type="button" onClick={submit} disabled={busy || !nurseId || !ticked || !data.canCheck}
        className="h-10 px-4 rounded-md bg-teal-700 text-white text-sm font-semibold disabled:opacity-40 ml-auto">{busy ? '處理中…' : label}</button>
    </div>
  )

  if (day.status === 'UNCHECKED') {
    return (
      <div className="border-2 border-amber-500 rounded-lg bg-amber-50/60 p-4 mb-4 flex flex-col gap-3" role="region" aria-label="護士核對">
        <div className="flex justify-between items-center">
          <b>護士核對 · {clinicLabel} {dayLabel(from)}</b>
          <span className="text-xs px-3 py-0.5 rounded-full border border-amber-500 bg-amber-100 text-amber-900">未核對</span>
        </div>
        {form('確認核對')}
        {!data.canCheck && <div className="text-xs text-red-700">店舖帳號只可以核對自己間店。</div>}
        <div className="text-xs text-gray-500">確認後記低：護士、核對時間、操作人、核對時嘅金額。之後數字變咗，會自動標「要重新核對」。</div>
        {cellHint}
      </div>
    )
  }

  const c = day.check!
  if (day.status === 'CHANGED') {
    const snap = new Map(c.byProvider.map(p => [p.key, p]))
    const keys = [...new Set([...currentRows.map(r => r.key), ...c.byProvider.map(p => p.key)])]
    const diffs = keys.map(k => {
      const now = currentRows.find(r => r.key === k)
      const was = snap.get(k)
      return { label: now?.label ?? was?.label ?? k, was: was?.amount ?? 0, now: now?.storeTotal ?? 0 }
    }).filter(d => Math.abs(d.now - d.was) > 0.005)
    return (
      <div className="border-2 border-red-600 rounded-lg bg-red-50 p-4 mb-4 flex flex-col gap-3" role="region" aria-label="護士核對">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <b className="text-red-800">⚠ 核對後數字有變 · 要重新核對</b>
          <span className="text-xs text-gray-600">之前由 {c.nurseName} {hhmm(c.checkedAt)} 核對</span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="bg-white border rounded p-2">核對時<br /><b className="tabular-nums text-lg">{money(c.amount)}</b></div>
          <div className="bg-white border rounded p-2">而家<br /><b className="tabular-nums text-lg">{money(total)}</b></div>
          <div className="bg-white border rounded p-2">差額<br /><b className="tabular-nums text-lg text-red-700">{signed(total - c.amount)}</b></div>
        </div>
        {diffs.length > 0 && (
          <div className="text-sm text-red-900">變咗嘅醫生：{diffs.map(d => `${d.label} ${money(d.was)} → ${money(d.now)}`).join('；')}</div>
        )}
        {form('重新核對')}
        {cellHint}
      </div>
    )
  }

  return (
    <div className="border-2 border-green-600 rounded-lg bg-green-50 p-4 mb-4 flex flex-col gap-3" role="region" aria-label="護士核對">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex flex-col">
          <b className="text-green-800">✓ 已核對 · {clinicLabel} {from}</b>
          <span className="text-sm text-gray-700">核對護士 <b>{c.nurseName}</b> · {hhmm(c.checkedAt)} · 核對時金額 <b className="tabular-nums">{money(c.amount)}</b>{c.checkedByName ? ` · 操作：${c.checkedByName}` : ''}</span>
        </div>
        {!revoking && data.canCheck && (
          <button type="button" onClick={() => setRevoking(true)} className="h-9 px-3 rounded-md border bg-white text-sm">取消核對</button>
        )}
      </div>
      {cellHint}
      {revoking && (
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col gap-1 text-sm text-gray-700 flex-1 min-w-[240px]">原因（必填，入審計紀錄）
            <input value={reason} onChange={e => setReason(e.target.value)} className="h-10 px-2 border rounded-md text-sm" placeholder="例：揀錯護士" />
          </label>
          <button type="button" onClick={() => setRevoking(false)} disabled={busy} className="h-10 px-3 rounded-md border bg-white text-sm">返回</button>
          <button type="button" onClick={revoke} disabled={busy || !reason.trim()} className="h-10 px-3 rounded-md bg-red-700 text-white text-sm font-semibold disabled:opacity-40">確認取消</button>
        </div>
      )}
    </div>
  )
}
