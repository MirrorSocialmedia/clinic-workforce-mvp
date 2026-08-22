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

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  bandBg,
  buildDays,
  cardText,
  computeAxis,
  dayEmptyText,
  defaultClinicId,
  fmtMin,
  hkNowMin,
  hkTodayStr,
  isWeekEmpty,
  layoutBookings,
  mergeRuns,
  providerColor,
  soft,
  syncChip,
  buildShortNames,
  addDays,
  weekdayOf,
  WEEKDAY,
  type AvailabilityResp,
  type BookingRun,
  type ClinicOpt,
  type DayProvider,
  type ScheduleDay,
} from '@/lib/provider-availability-view'
import { buildStaffByDate, shouldLoadStaffShifts, type StaffCell } from '@/lib/staff-by-date'

const REFRESH_MS = 5 * 60 * 1000 // ★ 後端 10 分鐘 sync 一次 → 前端 5 分鐘 refetch（§6.2 #7）
const SYNC_COOLDOWN_MS = 60_000 // ★ 同後端一致（拍板②）；正常情況由 429 retryAfterMs 為準

export default function ProviderAvailabilityPage() {
  const [clinics, setClinics] = useState<ClinicOpt[]>([])
  const [clinicsLoaded, setClinicsLoaded] = useState(false)
  const [clinicId, setClinicId] = useState<string>('')
  const [from, setFrom] = useState(hkTodayStr()) // ★ 滾動 7 日（拍板③，§6.2 #3）
  const [data, setData] = useState<AvailabilityResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoomDate, setZoomDate] = useState<string | null>(null)

  // ★ 2026-08-22 restyle §0.3 #3：而家線（今日 column 紅線 + 時間 label，60s interval tick 更新）
  const [nowMin, setNowMin] = useState(() => hkNowMin())
  useEffect(() => {
    const t = setInterval(() => setNowMin(hkNowMin()), 60_000)
    return () => clearInterval(t)
  }, [])

  // ★ cw-pta：「立即同步」掣（拍板②③）+ 員工當值列（拍板④）
  const [userRole, setUserRole] = useState<string>('')
  const [staffShifts, setStaffShifts] = useState<any[]>([])
  const [staffError, setStaffError] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [cooldownLeft, setCooldownLeft] = useState(0)

  // ★ cw-lanes-20260821-a3 §2.1/§2.2 醫生篩選 chip：預設只顯示「該週有預約」嘅醫生。
  // shown=null = 未初始化（首次渲染全顯示，effect 落定先 filter）。
  // ★#9：只初始化一次 —— data 每 5 分鐘 refetch 唔可以覆蓋用戶選擇（守衛 shown !== null）；
  //   用 useEffect 唔好用 useMemo（useMemo 會每次 data 變就重置）。
  const [shown, setShown] = useState<Set<string> | null>(null)
  const [showIdle, setShowIdle] = useState(false) // 零預約醫生摺埋，撳「+N 位只開診冇預約」展開

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

  // ★ 篩選初始化：只跑一次（#9 refetch 唔重置）；換診所時由 select onChange 將 shown 設返 null 觸發重初始化（#10）
  useEffect(() => {
    if (!data || shown !== null) return      // ★ 只初始化一次
    const withBookings = new Set<string>()
    for (const p of data.providers) {
      if ((p.weekBookings ?? 0) > 0) withBookings.add(p.id)
    }
    setShown(withBookings)
  }, [data, shown])

  // ★ 5 分鐘 auto refetch（離 page clear，§6.2 #7）—— 拍板⑤：唔加「重新載入」掣
  useEffect(() => {
    const t = setInterval(() => { void load() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  // ★ 員工當值列（cw-pta §5）：角色 + /api/shifts（同 provider-schedule 同一條 API，唔寫第二份）
  useEffect(() => {
    let live = true
    fetch('/api/me', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { user: { role: '' } }))
      .then(d => { if (live) setUserRole(d?.user?.role ?? '') })
      .catch(() => { if (live) setUserRole('') })
    return () => { live = false }
  }, [])

  const loadStaffShifts = useCallback(async () => {
    // KIOSK（打卡機）唔送 request — 員工姓名唔應該喺打卡機顯示（§5.1 #2）
    if (!shouldLoadStaffShifts(userRole)) return
    try {
      const r = await fetch(
        `/api/shifts?startDate=${from}&endDate=${addDays(from, 6)}&pageSize=1000`,
        { credentials: 'include', cache: 'no-store' },
      )
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      setStaffShifts(d.shifts ?? [])
      setStaffError(false)
    } catch {
      setStaffShifts([])
      setStaffError(true)
    }
  }, [userRole, from])

  useEffect(() => { void loadStaffShifts() }, [loadStaffShifts])

  const staffByDate = useMemo(
    () => buildStaffByDate(staffShifts, clinicId || null),
    [staffShifts, clinicId],
  )
  const showStaffRow = shouldLoadStaffShifts(userRole)

  // ★ 「立即同步」掣（拍板②③）：60s cooldown 倒數 + 429 retryAfterMs
  useEffect(() => {
    if (cooldownLeft <= 0) return
    const t = setInterval(() => setCooldownLeft(v => Math.max(0, v - 1000)), 1000)
    return () => clearInterval(t)
  }, [cooldownLeft])

  const doSync = useCallback(async () => {
    // ★ disabled 要包 syncing + cooldownLeft —— 淨係其中一個都會俾人狂撳（§3.2）
    if (syncing || cooldownLeft > 0) return
    setSyncing(true)
    try {
      const r = await fetch('/api/provider-availability/sync', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // ★ 2026-08-22（cw-patwk）：傳當前睇緊嘅週首日 —— 唔傳就永遠只拉今日起 7 日，
        //   切去下週會見到「未有資料」但 DB 真係冇嗰一週。
        body: JSON.stringify({ from }),
      })
      if (r.status === 429) {
        const d = await r.json().catch(() => ({}))
        setCooldownLeft(d?.retryAfterMs ?? SYNC_COOLDOWN_MS)
        return
      }
      if (!r.ok) throw new Error(String(r.status))
      setCooldownLeft(SYNC_COOLDOWN_MS)
      await load() // ★ sync 完即刻 refetch
    } catch {
      setError('同步失敗 — 撳重試')
    } finally {
      setSyncing(false)
    }
  }, [syncing, cooldownLeft, load, from])

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
  // ★ cw-lanes-20260821-a3 §四：30 分鐘一刻度；整點（m%60===0）先出字，半點只出線（#19 #20）
  const ticks = useMemo(() => {
    const out: { m: number; label: boolean }[] = []
    for (let m = axisMin; m <= axisMax; m += 30) out.push({ m, label: m % 60 === 0 })
    return out
  }, [axisMin, axisMax])
  const hourTicks = useMemo(() => ticks.filter(t => t.label), [ticks])

  // ★ 篩選後嘅 7 日（chip toggle 即時生效，#8）；shown=null（未初始化）→ 全顯示
  const visibleDays = useMemo(() => {
    if (shown === null) return days
    return days.map(d => ({ ...d, providers: d.providers.filter(p => shown.has(p.providerId)) }))
  }, [days, shown])

  // ★ §6.5：grid 內緊窄顯示位用簡稱（Dr + 姓；同姓 ≥2 自動兩字）。
  // 用完整醫生列表（data.providers，唔係 filter 後）→ 簡稱同 chip 篩選狀態無關、穩定。
  // 篩選 chip / legend 保持全名（下方渲染位唔查呢個 map）。
  const docShortNames = useMemo(
    () => buildShortNames(data ? data.providers.map(p => p.name) : []),
    [data],
  )
  const shortName = (full: string) => docShortNames.get(full) ?? full

  // ★ 2026-08-22 MD §3.1：欄頂 chip 空間細 —— 單姓（Dr 譚 → 譚；英文名前 3 字）。
  //   同姓會撞 —— chip 有底色（按醫生）配合預約塊同色可分辨；hover title 有全名。
  const shortSurname = (name: string): string => {
    const s = name.replace(/^Dr\s*/i, '').replace(/醫生$/, '').trim()
    return /^[\u4e00-\u9fa5]/.test(s) ? s.charAt(0) : s.slice(0, 3)
  }

  const cur = clinics.find(c => c.id === clinicId)
  const zoomDay = zoomDate ? visibleDays.find(d => d.date === zoomDate) ?? null : null

  // ─── 預約塊（2026-08-22 restyle §0.3）：run 卡 + spine + 深字；名唔入塊；102 虛線；過咗淡化 ───
  // mini（手機週概覽）：唔分 lane、全闊色條疊住、冇文字、minHeight 3（§五，拍板①理由）— 邏輯零改動。
  // 非 mini（桌面週視圖 + 手機放大單日）：layoutBookings 橫向分欄（上限 3 lane，拍板①）→ mergeRuns 相鄰合併（§0.3 #1）。
  function renderBookings(pr: DayProvider, c: string, mini: boolean, date: string) {
    if (mini) {
      return pr.busy.map((b, i) => (
        <div key={`b${i}`} style={{ position: 'absolute', left: 1, right: 1, zIndex: 2,
          top: pct(b.s), height: pctH(b.s, b.e), minHeight: 3,
          background: c, opacity: 0.85, borderRadius: 2 }} />
      ))
    }
    const laid = layoutBookings(pr.busy.map(b => ({
      s: b.s, e: b.e, status: b.status ?? 0,
      providerId: pr.providerId, name: pr.name, color: c,
    })))
    const runs = mergeRuns(laid)
    const txt = cardText(c)
    // 過咗淡化（§0.3 #4）：date < today，或今日且 run 尾 e <= nowMin；跨住而家嘅 run 唔淡
    const past = (s: BookingRun) =>
      date < today || (date === today && s.e <= nowMin)

    return runs.map((r, i) => {
      const w = 100 / r.lanes
      const isResch = r.status === 102
      // 門檻照舊：太矮（<30 分鐘）/ 3 lane 唔印字，齋 tooltip
      const showText = (r.e - r.s) >= 30 && r.lanes < 3
      // 多筆 = 「HH:MM–HH:MM · N 個」；單筆 102 = 「HH:MM 改期」；單筆正常 = 「HH:MM–HH:MM」
      const label = r.parts.length > 1
        ? `${fmtMin(r.s)}–${fmtMin(r.e)} · ${r.parts.length} 個`
        : isResch ? `${fmtMin(r.s)} 改期` : `${fmtMin(r.s)}–${fmtMin(r.e)}`
      return (
        <Fragment key={`r${i}`}>
          {/* §0.1：白卡 + 3px spine（醫生色唯一 100% 飽和位）+ 深字 cardText(c)；塊內唔印名（名嘅唯一位置 = 欄頂 chip）。
              102 = 虛線邊 + 75% 透明；未知 status → 正常卡 + tooltip 帶（status=N）。 */}
          <div
            title={`${pr.name} ${fmtMin(r.s)}–${fmtMin(r.e)}${r.parts.length > 1 ? `（${r.parts.length} 個預約）` : ''}${isResch ? '（已改期）' : r.status !== 0 && r.status !== 4 ? `（status=${r.status}）` : ''}`}
            style={{ position: 'absolute', zIndex: 2,
              left: `calc(${r.lane * w}% + 2px)`,
              width: `calc(${w}% - 4px)`,
              top: pct(r.s), height: pctH(r.s, r.e),
              minHeight: 24, boxSizing: 'border-box', overflow: 'hidden',
              background: '#ffffff',
              borderLeft: `3px solid ${c}`,
              border: isResch ? `1.5px dashed ${c}` : undefined,
              borderLeftWidth: 3, borderLeftStyle: isResch ? 'dashed' : 'solid', borderLeftColor: c,
              borderRadius: '0 5px 5px 0',
              opacity: past(r) ? 0.55 : isResch ? 0.75 : 1,
              padding: '1px 4px' }}>
            {showText && (
              <span style={{ fontSize: 12, color: txt, fontWeight: 600, display: 'block',
                             lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden',
                             textOverflow: 'ellipsis' }}>{label}</span>
            )}
            {/* 內部髮絲線：逐筆邊界（第一筆頂唔畫） */}
            {r.parts.slice(1).map((p2, j) => (
              <div key={`hl${j}`} style={{ position: 'absolute', left: 0, right: 0,
                top: `${(((p2.s - r.s) / (r.e - r.s)) * 100).toFixed(2)}%`,
                borderTop: '0.5px solid #e5e7eb' }} />
            ))}
          </div>
          {/* §3.4 overflow：cluster 超過 3 個重疊，右邊 16px 窄條「+N」（restyle：闊 14→16、字 10→11）。
              條件 overflow>0 && lane===0 —— cluster 每個 item 都帶同一個 overflow，
              唔加 lane 條件會畫多次（#13）。 */}
          {r.overflow > 0 && r.lane === 0 && (
            <div title={`仲有 ${r.overflow} 個預約`}
              style={{ position: 'absolute', zIndex: 3, right: 0, top: pct(r.s),
                       height: pctH(r.s, r.e), width: 16, minHeight: 18,
                       background: '#475569', borderRadius: '3px 0 0 3px',
                       display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 11, color: '#fff', writingMode: 'vertical-rl' }}>+{r.overflow}</span>
            </div>
          )}
        </Fragment>
      )
    })
  }

  // ─── 一條日 column（桌面 + 手機放大共用；mini = 手機週概覽縮版）───
  function DayColumn({ day, mini }: { day: ScheduleDay; mini: boolean }) {
    if (day.providers.length === 0) {
      return (
        <div style={{ position: 'relative', height: '100%', borderRadius: 6, background: '#f1f5f9',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#94a3b8', fontSize: mini ? 11 : 12,
                         writingMode: mini ? 'vertical-rl' : undefined }}>
            {dayEmptyText(data?.sync.lastSyncAt ?? null)}
          </span>
        </div>
      )
    }
    return (
      <div style={{ position: 'relative', height: '100%', borderRadius: 6,
                    background: '#f1f5f9', overflow: 'hidden' }}>
        {/* ★ 2026-08-22 MD §3.1（#15）：欄頂醫生 chip —— 名嘅唯一位置（restyle §0.1）；band 唔再畫名。
            高 26（restyle：22→26）、最多 3 個 ＋「+N」（restyle §0.2：字 8→12，放唔低 4 個）、hover title 全名；
            mini（手機週概覽）唔顯示（太細，#22）。 */}
        {!mini && (
          <div style={{ position: 'relative', zIndex: 4, height: 26, display: 'flex', gap: 2,
                        alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', overflow: 'hidden' }}>
            {day.providers.slice(0, 3).map(p => {
              const pc = providerColor(p.providerId, p.color)
              return (
                <span key={p.providerId} title={p.name} style={{
                  fontSize: 12, borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap',
                  background: soft(pc), color: pc,
                }}>{shortSurname(p.name)} {p.total || ''}</span>
              )
            })}
            {day.providers.length > 3 && (
              <span style={{ fontSize: 12, color: '#94a3b8' }}>+{day.providers.length - 3}</span>
            )}
          </div>
        )}
        {/* ★ §四 30 分鐘橫線：repeating-linear-gradient 一次過畫（唔逐條 div）。
            週期 = 1 小時（100%/n60，% 由瀏覽器解析成【實際像素高度】→ rowH 唔寫死 px，
            同 pct() 軸文字同一條公式 → ★#21 橫線同軸文字對齊，resize 都唔會漂移）。
            整點深（#d1d5db 1px）、半點淺（#e5e7eb 0.5px）（#19）。mini 唔畫（§五矮版）。 */}
        {!mini && (() => {
          const n60 = (axisMax - axisMin) / 60
          return (
            <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
              background: `repeating-linear-gradient(to bottom,
                #d1d5db 0, #d1d5db 1px,
                transparent 1px,
                transparent calc(100% / ${n60} / 2 - 0.25px),
                #e5e7eb calc(100% / ${n60} / 2 - 0.25px), #e5e7eb calc(100% / ${n60} / 2 + 0.25px),
                transparent calc(100% / ${n60} / 2 + 0.25px),
                transparent calc(100% / ${n60}))` }} />
          )
        })()}
        {day.providers.map(pr => {
          const c = providerColor(pr.providerId, pr.color)
          return (
            <div key={pr.providerId} style={{ position: 'absolute', inset: 0 }}>
              {/* ★ 休假斜紋做【底】—— zIndex 最低，開診/預約照樣畫喺上面（拍板①；cw-pta §4.3） */}
              {pr.onLeave && (
                <div style={{
                  position: 'absolute', inset: 0, zIndex: 0,
                  background: 'repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0 5px,#f1f5f9 5px,#f1f5f9 10px)',
                  // 衝突紅框用 inset boxShadow 唔用 border（border 會令 div 尺寸變、同 inset:0 打交）
                  ...(pr.leaveConflict ? { boxShadow: 'inset 0 0 0 2px #dc2626' } : {}),
                }} />
              )}
              {pr.open.map((o, i) => (
                <div key={`o${i}`} style={{ position: 'absolute', left: 0, right: 0, zIndex: 1,
                       background: bandBg(c), top: pct(o.s), height: pctH(o.s, o.e) }}>
                  {/* ★ 2026-08-22 restyle §0.1：醫生淡色 tint（14% alpha）— 空閒一眼睇到；名已喺欄頂 chip */}
                </div>
              ))}
              {renderBookings(pr, c, mini, day.date)}
              {/* ★ 休假 label（底部）；衝突 → 紅 + 警告（拍板①） */}
              {pr.onLeave && (
                <span style={{ position: 'absolute', bottom: 2, left: 3, zIndex: 3,
                               fontSize: 12, fontWeight: 600,
                               color: pr.leaveConflict ? '#dc2626' : '#64748b' }}>
                  {pr.leaveConflict ? '⚠️ 休假但有開診' : '休假'}
                </span>
              )}
            </div>
          )
        })}
        {/* ★ 2026-08-22 restyle §0.3 #3：而家線 — 今日 column 1.5px 紅橫線 + 右側 11px 時間 label；
            60s interval 更新（nowMin state）；zIndex 5 喺 chip 之上、pointerEvents none 唔擋 hover */}
        {!mini && day.date === today && nowMin > axisMin && nowMin < axisMax && (
          <>
            <div style={{ position: 'absolute', left: 0, right: 0, zIndex: 5, pointerEvents: 'none',
                          top: pct(nowMin), borderTop: '1.5px solid #dc2626' }} />
            <span style={{ position: 'absolute', right: 2, zIndex: 5, fontSize: 11, color: '#dc2626',
                           top: `calc(${pct(nowMin)} - 13px)` }}>{fmtMin(nowMin)}</span>
          </>
        )}
      </div>
    )
  }

  // ─── 日 column 渲染（含「🚫 冇醫生當值」全灰判斷）───
  // ★ 2026-08-22 拍板⑤ ＋ #20 鐵律：hasPattern 保護唔可省 ——
  //   未建 pattern 嘅診所（六間店而家全部）照顯示 Apricot 資料，唔會成週灰晒。
  // 顯示優先：全灰 > 休假斜紋 > 開診＋預約（全灰係成欄取代）。
  function renderDay(day: ScheduleDay, mini: boolean) {
    if (day.hasPattern && day.onDutyCount === 0) {
      return (
        <div style={{
          position: 'relative', height: '100%', borderRadius: 5,
          border: '0.5px dashed #cbd5e1',
          background: 'repeating-linear-gradient(45deg,#e9edf2,#e9edf2 6px,#f1f5f9 6px,#f1f5f9 12px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 3,
        }}>
          <span style={{ fontSize: 14 }}>🚫</span>
          <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>冇醫生當值</span>
        </div>
      )
    }
    return <DayColumn day={day} mini={mini} />
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

  // ─── 員工當值 cell（桌面七欄 / 手機單日放大共用；cw-pta §5，拍板④）───
  function renderStaffList(list: StaffCell[]) {
    if (list.length === 0) return <span style={{ color: '#cbd5e1' }}>—</span>
    return list.map((s, i) => (
      <div key={`${s.id}-${i}`} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span style={s.transfer ? { color: '#b45309' } : undefined}>{s.name}</span>
        {s.transfer && <span style={{ color: '#d97706' }}>·調</span>}
        <span style={{ color: '#94a3b8', marginLeft: 3 }}>{s.start}–{s.end}</span>
      </div>
    ))
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
        <span style={{ fontSize: 16, fontWeight: 600 }}>醫生時間表</span>

        <select value={clinicId}
          onChange={e => { setClinicId(e.target.value); setZoomDate(null); setShown(null); setShowIdle(false) }}
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
          {/* ★ 「立即同步」（拍板②③）：disabled 包 syncing + cooldown 倒數；唔加「重新載入」（拍板⑤） */}
          <button onClick={() => void doSync()} disabled={syncing || cooldownLeft > 0}
            aria-label="立即同步" title="打 Apricot 同步所有已接通診所（同 cron 同一條鏈）"
            style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 6, border: 'none',
              background: (syncing || cooldownLeft > 0) ? '#cbd5e1' : '#2563eb',
              color: '#fff', cursor: (syncing || cooldownLeft > 0) ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}>
            {syncing ? '同步中…' : cooldownLeft > 0 ? `↻ ${Math.ceil(cooldownLeft / 1000)}s` : '↻ 立即同步'}
          </button>
          {chip && (
            <span title={chip.tone === 'warn' ? '上次同步超過 30 分鐘' : undefined}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                       ...chipStyle[chip.tone] }}>
              {chip.tone === 'warn' ? '⚠️ ' : ''}{chip.label}
            </span>
          )}
        </span>
      </div>

      {/* ═══ header 第二行：醫生篩選 chip（2026-08-22 restyle §0.4：由頁底搬上，sticky 跟 header 唔跟 scroll）═══
          shown/showIdle 邏輯零改動（cw-lanes-20260821-a3 §2.1/§2.2）：只搬位置 + 字 9→12 + 選中 border 1px +「+N 位」dashed ghost */}
      {cur?.connected && data && (
        <div style={{ flexShrink: 0, background: '#f8fafc', borderBottom: '1px solid #e5e7eb',
                      padding: '6px 12px', display: 'flex', alignItems: 'center',
                      gap: 6, flexWrap: 'wrap' }}>
          {data.providers.map(p => {
            const idle = (p.weekBookings ?? 0) === 0
            if (idle && !showIdle) return null
            const on = shown?.has(p.id) ?? false
            const pc = providerColor(p.id, p.color)
            const hasData = weekProviderIds.has(p.id)
            return (
              <button key={p.id}
                aria-pressed={on}
                onClick={() => setShown(prev => {
                  const next = new Set(prev ?? [])
                  if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
                  return next
                })}
                style={{
                  fontSize: 12, padding: '2px 8px', borderRadius: 999,
                  border: on ? `1px solid ${pc}` : '1px solid #e5e7eb',
                  background: on ? soft(pc) : '#fff', color: on ? pc : '#9ca3af',
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}>
                {on ? '✓ ' : ''}{p.name}{p.weekBookings ? ` ${p.weekBookings}` : ''}{!hasData ? '（無數據）' : ''}
              </button>
            )
          })}
          {data.providers.filter(p => (p.weekBookings ?? 0) === 0).length > 0 && (
            <button onClick={() => setShowIdle(v => !v)}
              style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999,
                       background: '#fff', color: '#9ca3af', border: '1px dashed #cbd5e1',
                       cursor: 'pointer' }}>
              {showIdle ? '收起' : `+ ${data.providers.filter(p => (p.weekBookings ?? 0) === 0).length} 位只開診冇預約`}
            </button>
          )}
        </div>
      )}

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
                {/* ★ GET 200 但全空 → 「未有資料」（cur.connected 已喺上面擋咗真未接通；行到呢度一定接通咗） */}
                {weekEmpty ? (
                  <div style={{ textAlign: 'center', padding: '48px 0' }}>
                    <div style={{ fontSize: 14, color: '#b45309', marginBottom: 6 }}>未有資料</div>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>
                      {data?.sync?.lastSyncAt
                        ? '已同步但呢一週冇開診時段 — 撳「↻ 立即同步」再試，或者確認 Apricot 嗰邊有排開診'
                        : '仲未同步過 — 撳右上角「↻ 立即同步」拉第一次資料'}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* ═══ 桌面：時間軸 × 七日 ═══ */}
                    {/* ★ §6.5（2026-08-21 拍板③）：fixed height（唔係 minHeight — 要滾動就要固定高）；
                        超高時由 body（overflowY: auto）出 scrollbar；手機唔跟（維持矮版）。
                        ★ 2026-08-22：軸 11h → 12h（21:00）＋ 字體放大 — 高度 1085 → 1400（每 30 分鐘格 ≈ 58px） */}
                    <div className="hidden md:flex" style={{ gap: 4, height: 1400 }}>
                      <div style={{ width: 44, flexShrink: 0, position: 'relative', marginTop: 24 }}>
                        {hourTicks.map(t => (
                          <span key={t.m} style={{ position: 'absolute', right: 6, transform: 'translateY(-50%)',
                                                 fontSize: 12, color: '#94a3b8', top: pct(t.m) }}>
                            {fmtMin(t.m)}
                          </span>
                        ))}
                      </div>
                      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
                        {visibleDays.map(day => (
                          <div key={day.date} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            <div style={{ height: 24, textAlign: 'center', fontSize: 13 }}>
                              <DayHead date={day.date} mini={false} />
                            </div>
                            <div style={{ flex: 1, ...(day.date === today
                              ? { boxShadow: '0 0 0 1px #2563eb', borderRadius: 6 }
                              : {}) }}>
                              {renderDay(day, false)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ★ 員工當值（表底；cw-pta §5 拍板④）—— 同 provider-schedule 同一條 /api/shifts，
                        KIOSK 收起（showStaffRow），provider-schedule 原有嗰行保留（§5.1 #4） */}
                    {showStaffRow && (
                      <div className="hidden md:flex" style={{ gap: 4, marginTop: 8 }}>
                        <div style={{ width: 44, flexShrink: 0, padding: '6px 4px', fontSize: 11,
                                      color: '#94a3b8', textAlign: 'right', lineHeight: 1.3 }}>
                          員工<br />當值
                        </div>
                        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6,
                                       padding: '5px 0', borderTop: '1.5px solid #e5e7eb',
                                       background: '#fafbfc', borderRadius: 6 }}>
                          {days.map(day => (
                            <div key={`staff-${day.date}`} style={{ fontSize: 11, lineHeight: 1.6, padding: '0 3px' }}>
                              {staffError
                                ? <span style={{ color: '#94a3b8' }}>載入失敗</span>
                                : renderStaffList(staffByDate.get(day.date) ?? [])}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ═══ 手機：週概覽 / 單日放大 ═══ */}
                    <div className="md:hidden" style={{ height: '100%', minHeight: 380 }}>
                      {zoomDay ? (
                        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                          <div style={{ textAlign: 'center', fontSize: 13, color: '#334155', marginBottom: 6 }}>
                            {zoomDay.date}（{weekdayOf(zoomDay.date)}）
                          </div>
                          <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
                            <div style={{ width: 44, flexShrink: 0, position: 'relative' }}>
                              {hourTicks.map(t => (
                                <span key={t.m} style={{ position: 'absolute', right: 4, transform: 'translateY(-50%)',
                                                       fontSize: 12, color: '#94a3b8', top: pct(t.m) }}>
                                  {fmtMin(t.m)}
                                </span>
                              ))}
                            </div>
                            <div style={{ flex: 1 }}>{renderDay(zoomDay, false)}</div>
                          </div>
                          {/* ★ 員工當值 —— 手機只喺放大單日時顯示（§5.1 #3，七欄擠唔低） */}
                          {showStaffRow && (
                            <div style={{ flexShrink: 0, borderTop: '1.5px solid #e5e7eb', background: '#fafbfc',
                                           marginTop: 6, padding: '5px 6px', fontSize: 11, borderRadius: 6 }}>
                              <div style={{ color: '#94a3b8', marginBottom: 2 }}>員工當值</div>
                              {staffError
                                ? <span style={{ color: '#94a3b8' }}>載入失敗</span>
                                : renderStaffList(staffByDate.get(zoomDay.date) ?? [])}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, height: '100%' }}>
                          <div style={{ width: 32, flexShrink: 0, position: 'relative', marginTop: 28 }}>
                            {hourTicks.map(t => (
                              <span key={t.m} style={{ position: 'absolute', right: 2, transform: 'translateY(-50%)',
                                                     fontSize: 12, color: '#94a3b8', top: pct(t.m) }}>
                                {fmtMin(t.m).slice(0, 2)}
                              </span>
                            ))}
                          </div>
                          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
                            {visibleDays.map(day => (
                              <button key={day.date} onClick={() => setZoomDate(day.date)}
                                style={{ display: 'flex', flexDirection: 'column', minHeight: 0,
                                         textAlign: 'left', background: 'none', border: 'none', padding: 0 }}>
                                <div style={{ height: 28, textAlign: 'center', fontSize: 11,
                                              lineHeight: 1.2, width: '100%' }}>
                                  <DayHead date={day.date} mini />
                                </div>
                                <div style={{ flex: 1, width: '100%',
                                              ...(day.date === today
                                                ? { boxShadow: '0 0 0 1px #2563eb', borderRadius: 6 }
                                                : {}) }}>
                                  {renderDay(day, true)}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ★ 2026-08-22 restyle §0.4：篩選 chip 已搬去 header 第二行（見上）；呢度只留 legend */}
                    {/* legend
                        ★ 2026-08-22：PWA 安裝 banner 固定畫面底部 — legend 加底 padding 令
                        滾到底時唔被遮（§3.2）；restyle §0.4：縮做 micro 一行（11px）*/}
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                                  fontSize: 11, color: '#64748b', paddingBottom: 60 }}>
                      <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                        background: '#6366f124', marginRight: 4 }} />開診＝可約（醫生色）</span>
                      <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                        background: '#fff', borderLeft: '3px solid #6366f1',
                                        boxShadow: '0 0 0 0.5px #e5e7eb', marginRight: 4 }} />已約（· N 個）</span>
                      <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                        border: '1px dashed #94a3b8', marginRight: 4 }} />改期</span>
                      <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                        background: 'repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0 3px,#f1f5f9 3px,#f1f5f9 6px)',
                                        marginRight: 4 }} />休假／冇醫生當值</span>
                      <span><i style={{ display: 'inline-block', width: 10, borderTop: '1.5px solid #dc2626',
                                        marginRight: 4, verticalAlign: 'middle' }} />而家</span>
                      <span>過咗嘅時段自動淡化</span>
                      <span className="md:hidden" style={{ marginLeft: 'auto' }}>撳日子放大</span>
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
