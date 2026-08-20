'use client'

/**
 * ★ cw-pa P4: 醫生時間表（真 busy 時段 — Apricot availability）
 * Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §6 / §6.3 / §6.4
 *
 * 同 /provider-schedule（醫生當值表 — 人手排更）係兩樣嘢：
 * 呢度顯示嘅係 Apricot 同步入嚟嘅「實際開診 + 實際預約」時段（§6.3 真 busy 塊）。
 *
 * 資料：
 * - 診所清單：GET /api/clinics（現有 API，connected = 有冇 apricotClinicId）
 * - 時間表：  GET /api/provider-availability?clinicId=&from=（scheduling perm + clinic scope）
 *   ★ 只食呢兩個 API 嘅返回值 —— 零 DB 直查、零病人資料（§7.1 UI 防線）。
 *
 * 互動：
 * - 桌面：時間軸（行=醫生 band，欄=7 日）grid，hover busy 塊顯示時段 + 預約數
 * - 行動：週總覽（縮版）+ tap 日入單日放大
 * - 5 分鐘 auto refetch（setInterval，離 page clear）
 * - 顏色：Provider.color 優先，冇就 hash palette；只准 inline style（§6.2 #1）；
 *   icon 用 text glyph ‹ › ⚠️（§6.2 #2，唔用 lucide-react）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildDays,
  computeAxis,
  dayEmptyText,
  defaultClinicId,
  fmtMin,
  freeGaps,
  hkTodayStr,
  isWeekEmpty,
  providerColor,
  soft,
  syncChip,
  addDays,
  weekdayOf,
  WEEKDAY,
  type AvailabilityResp,
  type ClinicOpt,
  type ScheduleDay,
} from '@/lib/provider-availability-view'

const REFRESH_MS = 5 * 60 * 1000 // ★ 後端 10 分鐘 sync 一次 → 前端 5 分鐘 refetch（§6.2 #7）

export default function ProviderAvailabilityPage() {
  const [clinics, setClinics] = useState<ClinicOpt[]>([])
  const [clinicsLoaded, setClinicsLoaded] = useState(false)
  const [clinicId, setClinicId] = useState<string>('')
  const [from, setFrom] = useState(hkTodayStr()) // ★ 滾動 7 日（拍板③，§6.2 #3）
  const [data, setData] = useState<AvailabilityResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoomDate, setZoomDate] = useState<string | null>(null)

  // 診所清單（現有 /api/clinics；只載一次 — clinicId 唔好入 deps，會無限 loop）
  useEffect(() => {
    let live = true
    fetch('/api/clinics', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { clinics: [] }))
      .then(d => {
        if (!live) return
        const list: ClinicOpt[] = (d.clinics ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          connected: !!c.apricotClinicId,
        }))
        setClinics(list)
        setClinicId(prev => prev || defaultClinicId(list))
      })
      .catch(() => {
        if (live) setClinics([])
      })
      .finally(() => live && setClinicsLoaded(true))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async () => {
    if (!clinicId) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(
        `/api/provider-availability?clinicId=${encodeURIComponent(clinicId)}&from=${from}`,
        { credentials: 'include', cache: 'no-store' },
      )
      if (!r.ok) {
        throw new Error(r.status === 403 ? '無權查看此診所' : r.status === 404 ? '診所不存在' : `HTTP ${r.status}`)
      }
      setData(await r.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [clinicId, from])

  useEffect(() => { void load() }, [load])

  // ★ 5 分鐘 auto refetch（離 page clear，§6.2 #7）
  useEffect(() => {
    const t = setInterval(() => { void load() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  // flat providers[] → 7 日渲染 shape（純邏輯，已測試）
  const days = useMemo(() => (data ? buildDays(data) : []), [data])
  const weekEmpty = useMemo(() => (data ? isWeekEmpty(data) : false), [data])
  const weekProviderIds = useMemo(() => {
    const s = new Set<string>()
    for (const d of days) for (const p of d.providers) s.add(p.providerId)
    return s
  }, [days])

  // 時間軸範圍：跟資料（floor/ceil 整點），fallback 08:00–21:00（§6.2 #9）
  const [axisMin, axisMax] = useMemo(() => computeAxis(days), [days])
  const span = Math.max(1, axisMax - axisMin)
  const pct = (m: number) => `${(((m - axisMin) / span) * 100).toFixed(2)}%`
  const pctH = (s: number, e: number) => `${(((e - s) / span) * 100).toFixed(2)}%`

  const today = hkTodayStr()
  const axisLabels = useMemo(() => {
    const out: number[] = []
    for (let m = axisMin; m <= axisMax; m += 120) out.push(m)
    return out
  }, [axisMin, axisMax])

  const cur = clinics.find(c => c.id === clinicId)
  const zoomDay = zoomDate ? days.find(d => d.date === zoomDate) ?? null : null

  // ─── 一條日 column（桌面 + 手機放大共用；mini = 手機週概覽縮版）───
  function DayColumn({ day, mini }: { day: ScheduleDay; mini: boolean }) {
    if (day.providers.length === 0) {
      return (
        <div style={{ position: 'relative', height: '100%', borderRadius: 6, background: '#f1f5f9',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#94a3b8', fontSize: mini ? 9 : 12,
                         writingMode: mini ? 'vertical-rl' : undefined }}>
            {dayEmptyText(data?.sync.lastSyncAt ?? null)}
          </span>
        </div>
      )
    }
    return (
      <div style={{ position: 'relative', height: '100%', borderRadius: 6,
                    background: '#f1f5f9', overflow: 'hidden' }}>
        {day.providers.map(pr => {
          const c = providerColor(pr.providerId, pr.color)
          const gaps = mini ? [] : freeGaps(pr.open, pr.busy)
          return (
            <div key={pr.providerId} style={{ position: 'absolute', inset: 0 }}>
              {pr.open.map((o, i) => (
                <div key={`o${i}`} style={{ position: 'absolute', left: 0, right: 0,
                       background: soft(c), top: pct(o.s), height: pctH(o.s, o.e) }}>
                  {!mini && i === 0 && (
                    <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 10,
                                   fontWeight: 600, color: c }}>
                      {pr.name}{pr.total > 0 ? ` · ${pr.total}` : ''}
                    </span>
                  )}
                </div>
              ))}
              {pr.busy.map((b, i) => (
                <div key={`b${i}`}
                  title={`${fmtMin(b.s)}–${fmtMin(b.e)} · ${b.count ?? 1} 個預約`}
                  style={{ position: 'absolute', left: mini ? 1 : 4, right: mini ? 1 : 4,
                           borderRadius: 3, background: c, top: pct(b.s), height: pctH(b.s, b.e) }}>
                  {!mini && (
                    <span style={{ fontSize: 9, color: '#fff', padding: '0 4px',
                                   lineHeight: 1.2, display: 'block', overflow: 'hidden',
                                   textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      已約{b.count ? ` ·${b.count}` : ''}
                    </span>
                  )}
                </div>
              ))}
              {gaps.map((g, i) => (
                <div key={`g${i}`} style={{ position: 'absolute', left: 4, right: 4, borderRadius: 3,
                       border: '1px dashed #cbd5e1', background: 'rgba(255,255,255,.7)',
                       display: 'flex', alignItems: 'center', padding: '0 4px',
                       top: pct(g.s), height: pctH(g.s, g.e) }}>
                  <span style={{ fontSize: 9, color: '#64748b', overflow: 'hidden',
                                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    空閒 {fmtMin(g.s)}–{fmtMin(g.e)}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  // ─── 日頭（桌面 / 手機共用）───
  function DayHead({ date, mini }: { date: string; mini: boolean }) {
    const isToday = date === today
    const dow = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]
    return (
      <span style={isToday
        ? { background: '#2563eb', color: '#fff', borderRadius: 999, padding: mini ? '0 4px' : '2px 8px' }
        : { color: '#94a3b8' }}>
        {mini ? `${dow}\n${Number(date.slice(8))}` : `${dow} ${Number(date.slice(8))}`}
      </span>
    )
  }

  const chip = data ? syncChip(data.sync) : null
  const chipStyle: Record<string, React.CSSProperties> = {
    gray: { background: '#f1f5f9', color: '#64748b' },
    warn: { background: '#fef2f2', color: '#b91c1c' },
    ok: { background: '#f0fdf4', color: '#15803d' },
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* ═══ header ═══ */}
      <div style={{ flexShrink: 0, background: '#fff', borderBottom: '1px solid #e5e7eb',
                    padding: '10px 12px', display: 'flex', alignItems: 'center',
                    gap: 8, flexWrap: 'wrap' }}>
        {zoomDate && (
          <button onClick={() => setZoomDate(null)} className="md:hidden"
            style={{ fontSize: 13, color: '#2563eb', background: 'none', border: 'none', padding: 2 }}>
            ‹ 成週
          </button>
        )}
        <span style={{ fontSize: 15, fontWeight: 600 }}>醫生時間表</span>

        <select value={clinicId}
          onChange={e => { setClinicId(e.target.value); setZoomDate(null) }}
          style={{ fontSize: 12, borderRadius: 999, background: '#eff6ff', color: '#1d4ed8',
                   border: 0, padding: '4px 10px' }}>
          {clinics.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}{c.connected ? '' : '（未接通）'}
            </option>
          ))}
        </select>

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                       border: '1px solid #e5e7eb', borderRadius: 8, padding: '2px 4px' }}>
          <button onClick={() => { setFrom(addDays(from, -7)); setZoomDate(null) }} aria-label="前 7 日"
            style={{ background: 'none', border: 'none', color: '#64748b', padding: 2, fontSize: 14 }}>‹</button>
          <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {from.slice(5).replace('-', '/')}–{addDays(from, 6).slice(5).replace('-', '/')}
          </span>
          <button onClick={() => { setFrom(addDays(from, 7)); setZoomDate(null) }} aria-label="後 7 日"
            style={{ background: 'none', border: 'none', color: '#64748b', padding: 2, fontSize: 14 }}>›</button>
        </span>

        <button onClick={() => { setFrom(hkTodayStr()); setZoomDate(null) }}
          style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 8,
                   padding: '4px 8px', background: '#fff', color: '#64748b' }}>
          今日起
        </button>

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {chip && (
            <span title={chip.tone === 'warn' ? '上次同步超過 30 分鐘' : undefined}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                       ...chipStyle[chip.tone] }}>
              {chip.tone === 'warn' ? '⚠️ ' : ''}{chip.label}
            </span>
          )}
        </span>
      </div>

      {/* ═══ body ═══ */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
        {/* 診所清單攞唔到 */}
        {clinicsLoaded && clinics.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#94a3b8', fontSize: 13 }}>
            冇可用診所（或者載入失敗）
          </div>
        )}

        {/* ★ 青衣：未接通 ≠ 未開診（§6.2 #8 / §7.3 #19） */}
        {cur && !cur.connected && (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <div style={{ fontSize: 14, color: '#b45309', marginBottom: 6 }}>
              ⚠️ {cur.name} 未接通 Apricot
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              請喺診所設定填 Apricot 診所 ID（apricotClinicId）
            </div>
          </div>
        )}

        {cur && cur.connected && (
          <>
            {loading && (
              <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '40px 0' }}>
                載入緊…
              </div>
            )}
            {error && (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 8 }}>載入失敗：{error}</div>
                <button onClick={() => void load()}
                  style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8,
                           background: '#2563eb', color: '#fff', border: 'none' }}>
                  重試
                </button>
              </div>
            )}

            {data && !loading && !error && (
              <>
                {/* ★ GET 200 但全空 → 「未接通 Apricot」（唔好寫「未開診」） */}
                {weekEmpty ? (
                  <div style={{ textAlign: 'center', padding: '48px 0' }}>
                    <div style={{ fontSize: 14, color: '#b45309', marginBottom: 6 }}>未接通 Apricot</div>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>
                      或未同步 — 填好 Apricot 診所 ID 並完成首次同步後，醫生開診時段就會出現
                    </div>
                  </div>
                ) : (
                  <>
                    {/* ═══ 桌面：時間軸 × 七日 ═══ */}
                    <div className="hidden md:flex" style={{ gap: 4, height: '100%', minHeight: 420 }}>
                      <div style={{ width: 44, flexShrink: 0, position: 'relative', marginTop: 24 }}>
                        {axisLabels.map(m => (
                          <span key={m} style={{ position: 'absolute', right: 6, transform: 'translateY(-50%)',
                                                 fontSize: 10, color: '#94a3b8', top: pct(m) }}>
                            {fmtMin(m)}
                          </span>
                        ))}
                      </div>
                      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
                        {days.map(day => (
                          <div key={day.date} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            <div style={{ height: 24, textAlign: 'center', fontSize: 11 }}>
                              <DayHead date={day.date} mini={false} />
                            </div>
                            <div style={{ flex: 1, ...(day.date === today
                              ? { boxShadow: '0 0 0 1px #2563eb', borderRadius: 6 }
                              : {}) }}>
                              <DayColumn day={day} mini={false} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ═══ 手機：週概覽 / 單日放大 ═══ */}
                    <div className="md:hidden" style={{ height: '100%', minHeight: 380 }}>
                      {zoomDay ? (
                        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                          <div style={{ textAlign: 'center', fontSize: 12, color: '#334155', marginBottom: 6 }}>
                            {zoomDay.date}（{weekdayOf(zoomDay.date)}）
                          </div>
                          <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
                            <div style={{ width: 44, flexShrink: 0, position: 'relative' }}>
                              {axisLabels.map(m => (
                                <span key={m} style={{ position: 'absolute', right: 4, transform: 'translateY(-50%)',
                                                       fontSize: 9, color: '#94a3b8', top: pct(m) }}>
                                  {fmtMin(m)}
                                </span>
                              ))}
                            </div>
                            <div style={{ flex: 1 }}><DayColumn day={zoomDay} mini={false} /></div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, height: '100%' }}>
                          <div style={{ width: 32, flexShrink: 0, position: 'relative', marginTop: 28 }}>
                            {axisLabels.map(m => (
                              <span key={m} style={{ position: 'absolute', right: 2, transform: 'translateY(-50%)',
                                                     fontSize: 8, color: '#94a3b8', top: pct(m) }}>
                                {fmtMin(m).slice(0, 2)}
                              </span>
                            ))}
                          </div>
                          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
                            {days.map(day => (
                              <button key={day.date} onClick={() => setZoomDate(day.date)}
                                style={{ display: 'flex', flexDirection: 'column', minHeight: 0,
                                         textAlign: 'left', background: 'none', border: 'none', padding: 0 }}>
                                <div style={{ height: 28, textAlign: 'center', fontSize: 9,
                                              lineHeight: 1.2, width: '100%' }}>
                                  <DayHead date={day.date} mini />
                                </div>
                                <div style={{ flex: 1, width: '100%',
                                              ...(day.date === today
                                                ? { boxShadow: '0 0 0 1px #2563eb', borderRadius: 6 }
                                                : {}) }}>
                                  <DayColumn day={day} mini />
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 醫生圖例：無 data 醫生 → 列名 + 「無數據」空狀態 */}
                    <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6,
                                  fontSize: 11, color: '#475569' }}>
                      {data.providers.map(p => {
                        const c = providerColor(p.id, p.color)
                        const hasData = weekProviderIds.has(p.id)
                        return (
                          <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                                                    background: '#fff', border: '1px solid #e5e7eb',
                                                    borderRadius: 999, padding: '2px 8px' }}>
                            <i style={{ width: 8, height: 8, borderRadius: 2, background: c,
                                        display: 'inline-block' }} />
                            {p.name}{hasData ? '' : '（無數據）'}
                          </span>
                        )
                      })}
                    </div>

                    {/* legend */}
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12,
                                  flexWrap: 'wrap', fontSize: 10, color: '#94a3b8' }}>
                      <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                        background: '#f1f5f9', marginRight: 4 }} />冇開診</span>
                      <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                        background: soft('#6366f1'), marginRight: 4 }} />開診（色按醫生）</span>
                      <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                        background: '#6366f1', marginRight: 4 }} />已約</span>
                      <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                        border: '1px dashed #cbd5e1', marginRight: 4 }} />可約空隙</span>
                      <span className="md:hidden" style={{ marginLeft: 'auto', color: '#64748b' }}>撳日子放大</span>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
