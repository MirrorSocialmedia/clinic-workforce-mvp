'use client'

/**
 * ★ cwm-mobilemonth-20261003：員工手機「整月總覽」—— 同電腦版排班月視圖同一個表（人 × 日），唯讀。
 *
 * 捲動：成個表喺一個固定高度嘅盒入面左右／上下捲（overscroll-behavior: contain → 捲到盡頭唔會帶動成頁），
 *   表頭（日子）同姓名欄 sticky；頁面本身唔會左右郁。
 * 排列：自己嗰行置頂（藍底）→ 全職 → 兼職（同電腦版 HOURLY = 兼職）。
 * 撳格仔 → 底部彈出當日詳情（時間、診所、更次、假期）。
 */
import { useEffect, useMemo, useState } from 'react'
import { toHKDateStr } from '@/lib/hk-date'
import { isAccumulativeLeave, LEAVE_SYSTEM_KEYS } from '@/lib/leave-types'

const NAME_W = 64
const DAY_W = 44
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

interface OvShift {
  id: string; startTime: string; endTime: string
  templateName: string; templateShortName: string
  clinicName: string; clinicShortName: string
  secondaryClinicName: string | null; secondaryClinicShortName: string | null
  isTransfer: boolean
}
interface OvDay { date: string; shifts: OvShift[]; leaves: string[] }
interface OvEmp { id: string; userId: string; name: string; partTime?: boolean; shifts: OvDay[] }

function leaveTone(name: string): { bg: string; fg: string } {
  if (name.includes('休息')) return { bg: '#e5e7eb', fg: '#374151' }
  if (name.includes('病')) return { bg: '#fecaca', fg: '#7f1d1d' }
  return { bg: '#fde68a', fg: '#78350f' }
}

export default function MonthOverviewTable({ month, currentUserId }: { month: string; currentUserId: string }) {
  const [data, setData] = useState<{ days: string[]; employees: OvEmp[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [detail, setDetail] = useState<{ emp: OvEmp; day: OvDay } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    fetch(`/api/my/company-overview?month=${month}`, { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) { setData(null); setFailed(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [month])

  const today = toHKDateStr(new Date())

  const rows = useMemo(() => {
    if (!data) return []
    const byName = (a: OvEmp, b: OvEmp) => a.name.localeCompare(b.name, 'zh-HK')
    const me = data.employees.filter(e => e.userId === currentUserId)
    const others = data.employees.filter(e => e.userId !== currentUserId)
    const full = others.filter(e => !e.partTime).sort(byName)
    const part = others.filter(e => e.partTime).sort(byName)
    const out: ({ kind: 'emp'; emp: OvEmp; me: boolean } | { kind: 'group'; label: string })[] = []
    me.forEach(emp => out.push({ kind: 'emp', emp, me: true }))
    if (full.length) { out.push({ kind: 'group', label: '全職' }); full.forEach(emp => out.push({ kind: 'emp', emp, me: false })) }
    if (part.length) { out.push({ kind: 'group', label: '兼職' }); part.forEach(emp => out.push({ kind: 'emp', emp, me: false })) }
    return out
  }, [data, currentUserId])

  if (loading) return <div className="text-xs text-muted-foreground py-6 text-center">載入整月總覽...</div>
  if (failed || !data) return <div className="text-xs text-muted-foreground py-6 text-center">載入失敗，請稍後再試</div>
  if (!data.employees.length) return <div className="text-xs text-muted-foreground py-6 text-center">本月冇總覽資料</div>

  const dowOf = (d: string) => new Date(`${d}T12:00:00+08:00`).getUTCDay()
  const isWeekend = (d: string) => { const w = dowOf(d); return w === 0 || w === 6 }

  return (
    <div>
      {/* ★ 捲動盒：只喺盒入面捲；overscroll contain 防止捲到盡頭帶動成頁 */}
      <div
        style={{
          overflow: 'auto',
          maxHeight: 'calc(100dvh - 230px)',
          minHeight: 280,
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          background: '#fff',
        }}
      >
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed', fontSize: 11, width: NAME_W + DAY_W * data.days.length }}>
          <colgroup>
            <col style={{ width: NAME_W }} />
            {data.days.map(d => <col key={d} style={{ width: DAY_W }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{
                position: 'sticky', top: 0, left: 0, zIndex: 3, background: '#f3f5f8',
                textAlign: 'left', padding: '4px 4px', borderBottom: '1px solid #d9dee4', borderRight: '1px solid #d9dee4', fontWeight: 600,
              }}>員工</th>
              {data.days.map(d => (
                <th key={d} style={{
                  position: 'sticky', top: 0, zIndex: 2, padding: '3px 0', textAlign: 'center',
                  background: d === today ? '#dbeafe' : isWeekend(d) ? '#fff4e5' : '#f3f5f8',
                  color: isWeekend(d) ? '#b45309' : undefined,
                  borderBottom: d === today ? '3px solid #1F4E79' : '1px solid #d9dee4', borderRight: '1px solid #eef1f4',
                }}>
                  <div style={{ fontWeight: 700 }}>{Number(d.slice(8, 10))}</div>
                  <div style={{ fontWeight: 400, fontSize: 10 }}>{WEEK[dowOf(d)]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              if (r.kind === 'group') {
                return (
                  <tr key={`g-${r.label}-${idx}`}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#eef1f4', color: '#52606d', fontWeight: 700, padding: '3px 4px', borderBottom: '1px solid #d9dee4', borderRight: '1px solid #d9dee4' }}>{r.label}</td>
                    <td colSpan={data.days.length} style={{ background: '#eef1f4', borderBottom: '1px solid #d9dee4' }} />
                  </tr>
                )
              }
              const { emp, me } = r
              const rowBg = me ? '#e8f0fa' : '#fff'
              return (
                <tr key={emp.id}>
                  <td style={{
                    position: 'sticky', left: 0, zIndex: 1, background: rowBg,
                    padding: '4px 4px', borderBottom: '1px solid #eef1f4', borderRight: '1px solid #d9dee4',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontWeight: me ? 700 : 500, color: me ? '#1F4E79' : undefined,
                    boxShadow: me ? 'inset 3px 0 0 #1F4E79' : undefined,
                  }}>{emp.name}</td>
                  {emp.shifts.map(day => {
                    const has = day.shifts.length > 0 || day.leaves.length > 0
                    return (
                      <td
                        key={day.date}
                        onClick={has ? () => setDetail({ emp, day }) : undefined}
                        style={{
                          padding: '2px 1px', verticalAlign: 'top', textAlign: 'center', height: 34,
                          borderBottom: '1px solid #eef1f4', borderRight: '1px solid #eef1f4',
                          background: me ? rowBg : day.date === today ? '#f5f9ff' : isWeekend(day.date) ? '#fffaf2' : '#fff',
                          cursor: has ? 'pointer' : undefined,
                        }}
                      >
                        {day.shifts.map(s => (
                          <div key={s.id} style={{
                            borderRadius: 4, padding: '1px 1px', marginBottom: 1, lineHeight: 1.2,
                            background: s.isTransfer ? '#fef3c7' : '#dbeafe', color: s.isTransfer ? '#92400e' : '#1e3a8a',
                            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'clip',
                          }}>
                            <div style={{ fontSize: 10, fontWeight: 600 }}>{s.isTransfer && s.secondaryClinicShortName ? `${s.clinicShortName}→` : s.clinicShortName}</div>
                            {s.templateShortName && <div style={{ fontSize: 9 }}>{s.templateShortName}</div>}
                          </div>
                        ))}
                        {day.leaves.map((l, li) => {
                          const t = leaveTone(l)
                          return <div key={li} style={{ borderRadius: 4, padding: '1px 1px', fontSize: 10, background: t.bg, color: t.fg, overflow: 'hidden', whiteSpace: 'nowrap' }}>{l.slice(0, 2)}</div>
                        })}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '8px 2px 0', fontSize: 11, color: '#52606d' }}>
        <span><span style={{ padding: '0 4px', borderRadius: 4, background: '#dbeafe', color: '#1e3a8a' }}>店 更</span> 診所＋更次</span>
        <span><span style={{ padding: '0 4px', borderRadius: 4, background: '#fef3c7', color: '#92400e' }}>店→</span> 調鋪</span>
        <span><span style={{ padding: '0 4px', borderRadius: 4, background: '#fde68a', color: '#78350f' }}>年假</span> 假期</span>
        <span>撳格仔睇詳情</span>
      </div>

      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 60 /* ★ 蓋過底部導航（z-50） */, display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: '100%', borderRadius: '12px 12px 0 0', padding: '16px 16px calc(24px + env(safe-area-inset-bottom))', maxHeight: '60vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{detail.emp.name} · {detail.day.date}（{WEEK[dowOf(detail.day.date)]}）</div>
              <button type="button" onClick={() => setDetail(null)} style={{ width: 36, height: 36, fontSize: 18 }} aria-label="關閉">✕</button>
            </div>
            {detail.day.shifts.map(s => (
              <div key={s.id} style={{ padding: '8px 0', borderTop: '1px solid #f1f1f1', fontSize: 14 }}>
                <div style={{ fontWeight: 600 }}>{s.startTime}–{s.endTime} {s.templateName}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  {s.clinicName}{s.isTransfer && s.secondaryClinicName ? ` → ${s.secondaryClinicName}（調鋪）` : ''}
                </div>
              </div>
            ))}
            {detail.day.leaves.map((l, i) => (
              <div key={i} style={{ padding: '8px 0', borderTop: '1px solid #f1f1f1', fontSize: 14 }}>🏖 {l}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 我嘅假期結餘（同 /my/leave 同一個 API；病假無上限唔顯示） */
export function MyLeaveBalanceStrip() {
  const [items, setItems] = useState<{ id: string; name: string; remaining: number }[] | null>(null)
  useEffect(() => {
    const year = Number(toHKDateStr(new Date()).slice(0, 4))
    fetch('/api/leave-balance?mine=1', { credentials: 'include', cache: 'no-store' }) // ★ 只要自己（老闆／經理唔加會攞晒全公司）
      .then(r => (r.ok ? r.json() : { leaveBalances: [] }))
      .then(d => {
        const list = (d.leaveBalances || [])
          .filter((b: any) => b.leaveType?.systemKey !== LEAVE_SYSTEM_KEYS.SICK)
          .filter((b: any) => (isAccumulativeLeave(b.leaveType?.systemKey) ? true : b.year === year))
          .map((b: any) => ({ id: b.id, name: b.leaveType?.name ?? '', remaining: Number(b.remaining) }))
        setItems(list)
      })
      .catch(() => setItems([]))
  }, [])
  if (!items || items.length === 0) return null
  return (
    <div style={{ marginTop: 10, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>我嘅假期結餘</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 8, textAlign: 'center' }}>
        {items.map(b => (
          <div key={b.id} style={{ background: '#f3f5f8', borderRadius: 6, padding: '6px 4px' }}>
            <div style={{ fontSize: 11, color: '#52606d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: b.remaining < 0 ? '#dc2626' : undefined }}>
              {b.remaining < 0 ? `欠 ${Math.abs(b.remaining).toFixed(1)}` : b.remaining.toFixed(1)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
