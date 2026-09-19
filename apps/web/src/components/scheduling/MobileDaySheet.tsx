'use client'
import { useMemo, useState } from 'react'

type Tpl = { id: string; name: string; shortName?: string | null; startHour: number; startMinute: number; endHour: number; endMinute: number }
type Emp = { id: string; homeClinicId?: string | null; user?: { name?: string | null } | null }
type LT = { id: string; name: string; color?: string | null }
type ClinicOpt = { id: string; name: string; shortName?: string | null }

export type MobileSheetState =
  | { kind: 'add'; date: string }
  | { kind: 'shift'; date: string; shiftId: string; title: string }
  | { kind: 'leave'; date: string; leaveId: string; title: string }
  | null

export type ConflictState = { empId: string; tpl: Tpl; kind: 'shift' | 'leave'; existing: Array<{ id: string; label: string }> } | null

const pad = (n: number) => String(n).padStart(2, '0')

export function MobileDaySheet(p: {
  state: MobileSheetState
  conflict: ConflictState
  homeEmployees: Emp[]
  otherEmployees: Emp[]
  templates: Array<{ template: Tpl; label: string; color: string }>
  leaveTypes: LT[]
  // ★ cwm-mobilefix-20260918 D2：走鋪診所清單 —— 跨公司全清單（排班係 companyWide），
  //   唔好用收窄咗嘅 clinic 名單；primaryClinicId 只係俾「揀診所」排除走本舖。
  allClinics: ClinicOpt[]
  primaryClinicId?: string | null
  onClose: () => void
  // ★ D2：onAddShift 第三參 = 走鋪診所（null = 唔走鋪，合法值唔係「未設」）
  onAddShift: (empId: string, tpl: Tpl, secondaryClinicId: string | null) => Promise<void>
  // ★ D2：取代原有時唔應該丟失走鋪設定
  onReplace: (c: NonNullable<ConflictState>, secondaryClinicId: string | null) => Promise<void>
  onAddLeave: (empId: string, leaveTypeId: string) => Promise<void>
  onDeleteShift: (shiftId: string) => Promise<void>
  onDeleteLeave: (leaveId: string) => Promise<void>
}) {
  const [empId, setEmpId] = useState<string | null>(null)
  const [showOthers, setShowOthers] = useState(false)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  // ★ cwm-mobilefix-20260918 D2：② 揀完更次唔即刻建 —— 落第三步「走鋪？」先
  const [pendingTpl, setPendingTpl] = useState<{ template: Tpl; label: string; color: string } | null>(null)
  const [wantSecondary, setWantSecondary] = useState(false)
  const [secondary, setSecondary] = useState<string | null>(null)
  const s = p.state
  const filter = (list: Emp[]) => list.filter(e => (e.user?.name ?? '').toLowerCase().includes(q.trim().toLowerCase()))
  const home = useMemo(() => filter(p.homeEmployees), [p.homeEmployees, q])
  const others = useMemo(() => filter(p.otherEmployees), [p.otherEmployees, q])
  if (!s) return null
  const run = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); try { await fn() } finally { setBusy(false) } }
  const close = () => { setEmpId(null); setQ(''); setShowOthers(false); setPendingTpl(null); setWantSecondary(false); setSecondary(null); p.onClose() }
  const btn = 'w-full text-left rounded-lg border px-3 py-3 text-sm active:bg-muted disabled:opacity-50'
  const secClinics = p.allClinics.filter(c => c.id !== p.primaryClinicId)
  const effSecondary = wantSecondary ? (secondary ?? null) : null

  return (
    <div className="fixed inset-0 z-[120] bg-black/40 md:hidden" onClick={close}>
      <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl p-4 max-h-[80vh] overflow-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <span className="font-semibold">{s.date.slice(5).replace('-', '月')}日</span>
          <button className="text-2xl leading-none px-2" onClick={close} aria-label="關閉">×</button>
        </div>

        {s.kind === 'shift' && (
          <>
            <p className="text-sm mb-3">{s.title}</p>
            <button disabled={busy} className={`${btn} text-red-600 border-red-200`}
              onClick={() => run(async () => { if (window.confirm('確定刪除呢張更？')) { await p.onDeleteShift(s.shiftId); close() } })}>
              🗑 刪除呢張更
            </button>
          </>
        )}

        {s.kind === 'leave' && (
          <>
            <p className="text-sm mb-3">{s.title}</p>
            <button disabled={busy} className={`${btn} text-red-600 border-red-200`}
              onClick={() => run(async () => { if (window.confirm('確定刪除呢個假期？已批假期會退返額度。')) { await p.onDeleteLeave(s.leaveId); close() } })}>
              🗑 刪除呢個假期
            </button>
          </>
        )}

        {s.kind === 'add' && p.conflict && (
          <div className="space-y-2">
            <p className="text-sm">該員工當日已有{p.conflict.kind === 'shift' ? '更' : '假期'}：
              <strong>{p.conflict.existing.map(x => x.label).join('、')}</strong></p>
            <button disabled={busy} className={`${btn} bg-amber-50 border-amber-300`}
              onClick={() => run(async () => { await p.onReplace(p.conflict!, effSecondary); close() })}>取代原有</button>
            <button disabled={busy} className={btn} onClick={close}>取消</button>
          </div>
        )}

        {s.kind === 'add' && !p.conflict && !empId && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">① 揀員工</p>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜尋姓名"
              className="w-full rounded-lg border px-3 py-2 text-base" />
            {home.map(e => (
              <button key={e.id} className={btn} onClick={() => setEmpId(e.id)}>{e.user?.name ?? '—'}</button>
            ))}
            <button className="text-xs underline text-muted-foreground" onClick={() => setShowOthers(v => !v)}>
              {showOthers ? '收起其他店員工' : `其他店員工（${others.length}）`}
            </button>
            {showOthers && others.map(e => (
              <button key={e.id} className={btn} onClick={() => setEmpId(e.id)}>{e.user?.name ?? '—'}（外援）</button>
            ))}
          </div>
        )}

        {s.kind === 'add' && !p.conflict && empId && !pendingTpl && (
          <div className="space-y-2">
            <button className="text-xs underline text-muted-foreground" onClick={() => setEmpId(null)}>‹ 重新揀員工</button>
            <p className="text-xs text-muted-foreground">② 揀更次</p>
            {p.templates.map(it => (
              <button key={it.template.id} disabled={busy} className={`${btn} flex items-center gap-2`}
                onClick={() => setPendingTpl(it)}>
                <span style={{ width: 22, height: 14, borderRadius: 3, background: it.color }} />
                {it.label}
                <span className="ml-auto text-xs text-muted-foreground">
                  {pad(it.template.startHour)}:{pad(it.template.startMinute)}–{pad(it.template.endHour)}:{pad(it.template.endMinute)}
                </span>
              </button>
            ))}
            <p className="text-xs text-muted-foreground pt-2">或者設為假期</p>
            {p.leaveTypes.map(lt => (
              <button key={lt.id} disabled={busy} className={btn}
                onClick={() => run(async () => { await p.onAddLeave(empId, lt.id); close() })}>
                <span style={{ color: lt.color ?? undefined }}>🏖 {lt.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* ★ cwm-mobilefix-20260918 D2：第三步 走鋪？（可跳過）—— 撳「確定」先建 */}
        {s.kind === 'add' && !p.conflict && empId && pendingTpl && (
          <div className="space-y-2">
            <button className="text-xs underline text-muted-foreground" onClick={() => setPendingTpl(null)}>‹ 重新揀更次</button>
            <div className="rounded-lg border px-3 py-2 flex items-center gap-2">
              <span style={{ width: 22, height: 14, borderRadius: 3, background: pendingTpl.color }} />
              <span className="text-sm font-medium">{pendingTpl.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {pad(pendingTpl.template.startHour)}:{pad(pendingTpl.template.startMinute)}–{pad(pendingTpl.template.endHour)}:{pad(pendingTpl.template.endMinute)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">③ 走鋪？（可跳過）</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                className={`${btn} text-center ${!wantSecondary ? 'bg-brand text-white border-brand' : 'text-muted-foreground'}`}
                onClick={() => { setWantSecondary(false); setSecondary(null) }}>
                ○ 唔走鋪
              </button>
              <button
                className={`${btn} text-center ${wantSecondary ? 'bg-brand text-white border-brand' : 'text-muted-foreground'}`}
                onClick={() => { setWantSecondary(true); setSecondary(prev => prev && secClinics.some(c => c.id === prev) ? prev : null) }}>
                ○ 下午去 ▸
              </button>
            </div>
            {wantSecondary && (
              <select
                className="w-full rounded-lg border px-3 py-2 text-base"
                value={secondary ?? ''}
                onChange={e => setSecondary(e.target.value || null)}
              >
                <option value="">揀診所（跨公司）</option>
                {secClinics.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
            <button
              disabled={busy || (wantSecondary && !secondary)}
              className={`${btn} bg-brand text-white border-brand text-center font-medium`}
              onClick={() => run(async () => { if (pendingTpl) await p.onAddShift(empId, pendingTpl.template, effSecondary) })}>
              確定（{effSecondary ? `走鋪 → ${p.allClinics.find(c => c.id === effSecondary)?.name ?? ''}` : '唔走鋪'}）
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
