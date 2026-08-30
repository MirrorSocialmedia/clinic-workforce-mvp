'use client'

/**
 * ★ providerslot-20260830 T2: 醫生時間表 — 四態格 redesign
 * Spec: whatsapp-flow-booking.md §六 + 醫生時間表 重新設計.dc.html（3a pixel spec）
 *
 * 同 /provider-schedule（醫生當值表 — 人手排更）係兩樣嘢：
 * 呢度顯示 Apricot 同步入嚟嘅「實際開診 + 實際預約 + 線上 hold」，
 * 以 MD 四態格渲染（3a）：
 *   實心綠＝線上可出 · 虛邊綠＝只人手可插（15m 碎片）· 橙邊＝HELD/IN_APRICOT 已佔 · 灰＝不可出
 *
 * 資料：
 * - 診所清單：GET /api/clinics（現有 API，connected = 有冇 apricotClinicId）
 * - 四態格：  GET /api/provider-availability/grid?clinicId=&from=（internal；scheduling perm + clinic scope）
 *   ★ 只食呢兩個 API 嘅返回值 —— 零 DB 直查、零病人資料。
 *   ★ fragments 只經 internal API（external API 唔出碎片 — MD §一）。
 *
 * 視圖（保留現有 navigation）：
 * - 週視圖（預設）：7 日 × 逐醫生子欄，緊湊四態格；撳日欄 → 日視圖
 * - 日視圖（zoom）：3a 完整格（行高 34px、上下兩 15m 小格 mini seat、文案、圖例、而家線）
 * - 5 分鐘 auto refetch（setInterval，離 page clear）
 * - 顏色：Provider.color 優先（chip 用）；四態色跟 3a pixel spec（GRID_COLORS）
 *   只准 inline style；icon 用 text glyph ‹ ›（唔用 lucide-react）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  GRID_COLORS,
  addDays,
  buildShortNames,
  computeGridAxis,
  defaultClinicId,
  fmtMin,
  gridCellState,
  gridCellStyle,
  gridWeekEmpty,
  hkNowMin,
  hkTodayStr,
  providerColor,
  soft,
  syncChip,
  WEEKDAY,
  type ClinicOpt,
  type GridDay,
  type GridResp,
  type GridSlot,
} from '@/lib/provider-availability-view'
import { buildStaffByDate, shouldLoadStaffShifts, type StaffCell } from '@/lib/staff-by-date'

const REFRESH_MS = 5 * 60 * 1000 // ★ 後端 10 分鐘 sync 一次 → 前端 5 分鐘 refetch
const SYNC_COOLDOWN_MS = 60_000 // ★ 同後端一致；正常情況由 429 retryAfterMs 為準

// ★ MD §六：行高 28px → 34px（3a）
const ROW_H = 34
const ROW_GAP = 3
const ROW_STEP = ROW_H + ROW_GAP
/** 手機週概覽（mini）：緊湊色條，唔印字 */
const MINI_ROW_H = 16
const MINI_ROW_GAP = 2
const MINI_ROW_STEP = MINI_ROW_H + MINI_ROW_GAP

/** 灰底斜紋（未開診 — 3a hatched） */
const HATCH = `repeating-linear-gradient(45deg, color-mix(in srgb, #201e1d 7%, transparent) 0, color-mix(in srgb, #201e1d 7%, transparent) 5px, transparent 5px, transparent 10px)`

/** hold 來源 / 狀態 → 人讀（tooltip 用；零 PII — API 本來就唔回 patientWaId/patientName） */
function holdSrcLabel(src: string): string {
  if (src === 'whatsapp_flow') return 'WhatsApp Flow'
  if (src === 'staff') return '前台人手'
  return src
}
function holdStatusLabel(st: string): string {
  if (st === 'HELD') return 'HELD（等入 Apricot）'
  if (st === 'IN_APRICOT') return 'IN_APRICOT（已入）'
  return st
}
/** createdAt ISO(UTC) → HK 'MM-DD HH:mm' */
function fmtHoldAt(at: string): string {
  try {
    return new Date(at).toLocaleString('en-GB', {
      timeZone: 'Asia/Hong_Kong',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).replace(',', '')
  } catch {
    return ''
  }
}

export default function ProviderAvailabilityPage() {
  const [clinics, setClinics] = useState<ClinicOpt[]>([])
  const [clinicsLoaded, setClinicsLoaded] = useState(false)
  const [clinicId, setClinicId] = useState<string>('')
  const [from, setFrom] = useState(hkTodayStr()) // ★ 滾動 7 日
  const [data, setData] = useState<GridResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoomDate, setZoomDate] = useState<string | null>(null)

  // ★ 而家線（今日 red line + 時間 label，60s interval tick 更新）
  const [nowMin, setNowMin] = useState(() => hkNowMin())
  useEffect(() => {
    const t = setInterval(() => setNowMin(hkNowMin()), 60_000)
    return () => clearInterval(t)
  }, [])

  // ★ 「立即同步」掣 + 員工當值列
  const [userRole, setUserRole] = useState<string>('')
  const [staffShifts, setStaffShifts] = useState<any[]>([])
  const [staffError, setStaffError] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [cooldownLeft, setCooldownLeft] = useState(0)

  // ★ 醫生篩選 chip：預設只顯示「該週有預約」嘅醫生。
  // shown=null = 未初始化（首次渲染全顯示，effect 落定先 filter）。
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
        `/api/provider-availability/grid?clinicId=${encodeURIComponent(clinicId)}&from=${from}`,
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

  // ★ 篩選初始化：只跑一次（refetch 唔重置）；換診所時由 select onChange 將 shown 設返 null 觸發重初始化
  useEffect(() => {
    if (!data || shown !== null) return      // ★ 只初始化一次
    const withBookings = new Set<string>()
    for (const p of data.providers) {
      if ((p.weekBookings ?? 0) > 0) withBookings.add(p.id)
    }
    setShown(withBookings)
  }, [data, shown])

  // ★ 5 分鐘 auto refetch（離 page clear）
  useEffect(() => {
    const t = setInterval(() => { void load() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  // ★ 員工當值列（同 provider-schedule 同一條 API，唔寫第二份）
  useEffect(() => {
    let live = true
    fetch('/api/me', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { user: { role: '' } }))
      .then(d => { if (live) setUserRole(d?.user?.role ?? '') })
      .catch(() => { if (live) setUserRole('') })
    return () => { live = false }
  }, [])

  const loadStaffShifts = useCallback(async () => {
    // KIOSK（打卡機）唔送 request — 員工姓名唔應該喺打卡機顯示
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

  // ★ 「立即同步」掣：60s cooldown 倒數 + 429 retryAfterMs
  useEffect(() => {
    if (cooldownLeft <= 0) return
    const t = setInterval(() => setCooldownLeft(v => Math.max(0, v - 1000)), 1000)
    return () => clearInterval(t)
  }, [cooldownLeft])

  const doSync = useCallback(async () => {
    // ★ disabled 要包 syncing + cooldownLeft —— 淨係其中一個都會俾人狂撳
    if (syncing || cooldownLeft > 0) return
    setSyncing(true)
    try {
      const r = await fetch('/api/provider-availability/sync', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // ★ 傳當前睇緊嘅週首日 —— 唔傳就永遠只拉今日起 7 日
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

  // ─── 派生數據 ───
  const today = hkTodayStr()

  // 逐日 view：{ date, flag, providers: { p, day }[] }（未 filter）
  const daysInfo = useMemo(() => {
    if (!data) return [] as {
      date: string
      flag: { date: string; onDutyCount: number; hasPattern: boolean }
      providers: { p: GridResp['providers'][number]; day: GridDay }[]
    }[]
    return data.dayFlags.map(f => {
      const providers: { p: GridResp['providers'][number]; day: GridDay }[] = []
      for (const p of data.providers) {
        const day = p.days.find(d => d.date === f.date)
        if (day) providers.push({ p, day })
      }
      return { date: f.date, flag: f, providers }
    })
  }, [data])

  // ★ 篩選後（chip toggle 即時生效）；shown=null（未初始化）→ 全顯示
  const visibleDays = useMemo(() => {
    if (shown === null) return daysInfo
    return daysInfo.map(d => ({
      ...d,
      providers: d.providers.filter(x => shown.has(x.p.id)),
    }))
  }, [daysInfo, shown])

  // ★ grid 內緊窄顯示位用簡稱（同姓 ≥2 自動兩字）— 同 chip 篩選狀態無關、穩定
  const docShortNames = useMemo(
    () => buildShortNames(data ? data.providers.map(p => p.name) : []),
    [data],
  )

  // ★ 欄頂 chip 空間細 —— 單姓（Dr 譚 → 譚；英文名前 3 字）
  const shortSurname = (name: string): string => {
    const s = name.replace(/^Dr\s*/i, '').replace(/醫生$/, '').trim()
    return /^[\u4e00-\u9fa5]/.test(s) ? s.charAt(0) : s.slice(0, 3)
  }

  const weekEmpty = useMemo(() => (data ? gridWeekEmpty(data) : false), [data])
  const weekProviderIds = useMemo(() => {
    const s = new Set<string>()
    for (const d of daysInfo) for (const x of d.providers) if (x.day.slots.length > 0) s.add(x.p.id)
    return s
  }, [daysInfo])

  // 時間軸範圍（跟資料 floor/ceil 整點，保底 09:00–21:00 — 同舊 computeAxis 口徑）
  const [axisMin, axisMax] = useMemo(() => (data ? computeGridAxis(data) : [9 * 60, 21 * 60]), [data])
  const rowCount = Math.max(1, Math.round((axisMax - axisMin) / 30))
  const rowMins = useMemo(() => Array.from({ length: rowCount }, (_, k) => axisMin + k * 30), [axisMin, rowCount])

  const ticks = useMemo(() => {
    const out: { m: number; label: boolean }[] = []
    for (let m = axisMin; m <= axisMax; m += 30) out.push({ m, label: m % 60 === 0 })
    return out
  }, [axisMin, axisMax])
  const hourTicks = useMemo(() => ticks.filter(t => t.label), [ticks])

  const cur = clinics.find(c => c.id === clinicId)
  const zoomDay = zoomDate ? visibleDays.find(d => d.date === zoomDate) ?? null : null

  // 而家線 top（px）— 固定行高 34 + gap 3；row k 佔 [k*37, k*37+34]，時間內插用行高
  const nowTop = (min: number): number | null => {
    if (min <= axisMin || min >= axisMax) return null
    const k = Math.floor((min - axisMin) / 30)
    const frac = ((min - axisMin) % 30) / 30
    return k * ROW_STEP + frac * ROW_H
  }

  // ─── 四態格 mini seat（3a：上下兩排 × capacity 粒；深＝已佔，由左填起，唔代表椅號）───
  function MiniSeats({ occ, capacity }: { occ: [number, number]; capacity: number }) {
    const n = Math.max(1, Math.min(capacity, 8))
    return (
      <span style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {occ.map((o, row) => (
          <span key={row} style={{ display: 'flex', gap: 2 }}>
            {Array.from({ length: n }, (_, k) => (
              <span key={k} style={{
                width: 9, height: 11, borderRadius: 3, flex: 'none',
                background: k < o ? GRID_COLORS.seatTaken : GRID_COLORS.seatFree,
              }} />
            ))}
          </span>
        ))}
      </span>
    )
  }

  // ─── 格 tooltip（零 PII；hold 顯示來源 + 狀態 + 時間）───
  function slotTooltip(slot: GridSlot, capacity: number): string {
    const ui = gridCellState(slot)
    const range = `${slot.start}–${slot.end}`
    if (ui.state === 'held') {
      const hs = slot.holds.map(h =>
        `${holdStatusLabel(h.st)} · ${holdSrcLabel(h.src)} · ${h.s}–${h.e}${h.at ? `（${fmtHoldAt(h.at)} 起）` : ''}`
      ).join('；')
      return `${range} · 線上已佔${hs ? `：${hs}` : ''}`
    }
    if (ui.state === 'offerable') return `${range} · 線上可出 · ${slot.seatsFree} 席`
    if (ui.state === 'fragment') {
      return `${range} · 只人手可插 · ${ui.fragCount} × 15 分（30 分鐘位已滿，碎片唔經 Flow 出）`
    }
    if (ui.closedKind === 'on_leave') return `${range} · 休假`
    if (ui.closedKind === 'lead_time') return `${range} · 線上未開（lead time 前）`
    if (ui.closedKind === 'full') return `${range} · 滿（${capacity} 席已佔）`
    return `${range} · 未開診`
  }

  // ─── 日視圖單格（3a 完整：mini seat + 文案；行高 34px）───
  function DayCell({ slot, capacity, precise }: { slot: GridSlot; capacity: number; precise: boolean }) {
    const ui = gridCellState(slot)
    const cs = gridCellStyle(ui.state)
    const hatched = ui.state === 'closed' && ui.closedKind === 'outside_open'
    return (
      <div
        title={slotTooltip(slot, capacity)}
        style={{
          height: ROW_H, borderRadius: 11, boxSizing: 'border-box',
          background: hatched ? `${HATCH}, ${GRID_COLORS.closedBg}` : cs.background,
          border: cs.border !== 'none' ? cs.border : undefined,
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', overflow: 'hidden',
        }}>
        {slot.occ && precise ? <MiniSeats occ={slot.occ} capacity={capacity} /> : null}
        {hatched ? (
          <span style={{ fontSize: 10, color: GRID_COLORS.textMuted, whiteSpace: 'nowrap' }}>{ui.label}</span>
        ) : (
          <span style={{
            fontSize: ui.state === 'fragment' ? 10.5 : 11,
            fontWeight: 700,
            color: cs.color, whiteSpace: 'nowrap',
          }}>{ui.label}</span>
        )}
      </div>
    )
  }

  // ─── 週視圖緊湊格（色塊 + 短文案；mini = 手機概覽色條）───
  function WeekCell({ slot, mini }: { slot: GridSlot | undefined; mini: boolean }) {
    if (!slot) {
      return <div style={{ height: mini ? MINI_ROW_H : ROW_H, borderRadius: mini ? 4 : 11, background: '#f1f5f9' }} />
    }
    const ui = gridCellState(slot)
    const cs = gridCellStyle(ui.state)
    const hatched = ui.state === 'closed' && ui.closedKind === 'outside_open'
    const shortLabel =
      ui.state === 'offerable' ? `${slot.seatsFree} 席`
      : ui.state === 'fragment' ? `${ui.fragCount}×15`
      : ui.state === 'held' ? ''
      : ui.closedKind === 'full' ? '滿'
      : ''
    return (
      <div
        title={slotTooltip(slot, capacityOf)}
        style={{
          height: mini ? MINI_ROW_H : ROW_H, borderRadius: mini ? 4 : 11, boxSizing: 'border-box',
          background: hatched ? `${HATCH}, ${GRID_COLORS.closedBg}` : cs.background,
          border: !mini && cs.border !== 'none' ? cs.border : undefined,
          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        }}>
        {!mini && shortLabel && (
          <span style={{
            fontSize: 10, fontWeight: 600, color: ui.state === 'closed' ? GRID_COLORS.closedText : cs.color,
            whiteSpace: 'nowrap',
          }}>{shortLabel}</span>
        )}
      </div>
    )
  }
  const capacityOf = data?.capacity ?? 3

  // ─── 一列日（週視圖）：逐醫生子欄 × 30m 四態格 ───
  function WeekDayColumn({ date, providers, mini }: {
    date: string
    providers: { p: GridResp['providers'][number]; day: GridDay }[]
    mini: boolean
  }) {
    // 全日冇數據（onDuty 但 slots 全空）→ 休診/未同步
    const anyData = providers.some(x => x.day.slots.length > 0)
    if (providers.length === 0 || !anyData) {
      return (
        <div style={{ position: 'relative', height: '100%', borderRadius: 6, background: '#f1f5f9',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#94a3b8', fontSize: mini ? 11 : 12,
                         writingMode: mini ? 'vertical-rl' : undefined }}>
            {data?.sync.lastSyncAt ? '休診' : '未同步'}
          </span>
        </div>
      )
    }
    return (
      <div style={{ position: 'relative', height: '100%', display: 'flex', gap: 4 }}>
        {providers.map(({ p, day }) => {
          const pc = providerColor(p.id, p.color)
          return (
            <div key={p.id} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {!mini && (
                <div style={{ height: 22, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span title={p.name} style={{
                    fontSize: 11, borderRadius: 3, padding: '0 5px', whiteSpace: 'nowrap', maxWidth: '100%',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    background: soft(pc), color: pc,
                  }}>{shortSurname(p.name)}{day.bookCount ? ` ${day.bookCount}` : ''}</span>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: mini ? MINI_ROW_GAP : ROW_GAP }}>
                {rowMins.map(m => (
                  <WeekCell key={m} slot={day.slots[Math.floor(m / 30)]} mini={mini} />
                ))}
              </div>
            </div>
          )
        })}
        {/* 而家線（今日） */}
        {!mini && date === today && (() => {
          const top = nowTop(nowMin)
          if (top === null) return null
          return (
            <div style={{ position: 'absolute', left: 0, right: 0, zIndex: 5, pointerEvents: 'none',
                          top, borderTop: '1.5px solid #dc2626' }} />
          )
        })()}
      </div>
    )
  }

  // ─── 日視圖（3a 完整格）───
  function DayView({ date, providers }: {
    date: string
    providers: { p: GridResp['providers'][number]; day: GridDay }[]
  }) {
    const anyData = providers.some(x => x.day.slots.length > 0)
    if (!anyData) {
      return (
        <div style={{ textAlign: 'center', padding: '48px 0', color: '#94a3b8', fontSize: 13 }}>
          {data?.sync.lastSyncAt ? '休診' : '未同步'}
        </div>
      )
    }
    const dow = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]
    const isToday = date === today
    // 3a 摘要：今日 = 「HH:MM 之後」由而家起計；非今日 = 全日
    const fromMin = isToday ? nowMin : 0
    let offerableCount = 0
    let fragTotal = 0
    for (const { day } of providers) {
      for (const s of day.slots) {
        if (s.i * 30 < fromMin) continue
        if (s.status === 'offerable') offerableCount++
        const ui = gridCellState(s)
        if (ui.state === 'fragment') fragTotal += ui.fragCount
      }
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 1240 }}>
        {/* 3a header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>
            {Number(date.slice(5, 7))} 月 {Number(date.slice(8))} 日 {dow}
          </span>
          {isToday && (
            <span style={{ padding: '2px 9px', borderRadius: 999, background: '#b2622d', color: '#fff',
                           fontSize: 10.5, fontWeight: 600 }}>今日</span>
          )}
          <span style={{ fontSize: 11, color: GRID_COLORS.textMuted }}>
            每席 {data?.capacity ?? 3} 位 · 上限 {data?.capacity ?? 3}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: '#56633f' }}>
            {isToday ? `${fmtMin(nowMin)} 之後：` : ''}
            線上可出 {offerableCount} 格{fragTotal > 0 ? ` · 人手另有 ${fragTotal} 個碎片` : ''}
          </span>
        </div>

        {/* 圖例（MD §六：必須有，並解釋上下半意思） */}
        <Legend />

        {/* 醫生欄頭 */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ width: 46, flex: 'none' }} />
          {providers.map(({ p }) => (
            <span key={p.id} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: 12.5, fontWeight: 600 }}>
              {p.name}
            </span>
          ))}
        </div>

        {/* 30m 行（行高 34px） */}
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
          {rowMins.map(m => {
            const major = m % 60 === 0
            return (
              <div key={m} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                <span style={{
                  width: 46, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                  fontSize: 11, fontWeight: major ? 600 : 400,
                  color: major ? '#645c50' : GRID_COLORS.textMuted,
                }}>{fmtMin(m)}</span>
                {providers.map(({ p, day }) => (
                  <div key={p.id} style={{ flex: 1, minWidth: 0 }}>
                    <DayCell slot={day.slots[Math.floor(m / 30)]} capacity={data?.capacity ?? 3} precise={day.precise} />
                  </div>
                ))}
              </div>
            )
          })}
          {/* 而家線 */}
          {isToday && (() => {
            const top = nowTop(nowMin)
            if (top === null) return null
            return (
              <>
                <div style={{ position: 'absolute', left: 46, right: 0, zIndex: 5, pointerEvents: 'none',
                              top, borderTop: '1.5px solid #dc2626' }} />
                <span style={{ position: 'absolute', right: 4, zIndex: 5, fontSize: 11, color: '#dc2626',
                               top: top - 15 }}>{fmtMin(nowMin)}</span>
              </>
            )
          })()}
        </div>
      </div>
    )
  }

  // ─── 圖例（MD §六：四態 + 上下半解釋）───
  function Legend() {
    const sw = (style: React.CSSProperties): React.CSSProperties => ({
      display: 'inline-block', width: 16, height: 16, borderRadius: 4, marginRight: 5,
      verticalAlign: '-3px', ...style,
    })
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 11, color: '#645c50' }}>
        <span><i style={sw({ background: GRID_COLORS.offerable })} />實心綠 · 線上可出（Flow 會出呢格）</span>
        <span><i style={sw({ background: GRID_COLORS.fragmentBg, border: `1.5px dashed ${GRID_COLORS.fragmentBorder}` })} />虛邊綠 · 只人手可插（15 分鐘碎片，Flow 唔出）</span>
        <span><i style={sw({ background: GRID_COLORS.heldBg, border: `1.5px solid ${GRID_COLORS.heldBorder}` })} />橙邊 · 線上已佔（HELD / IN_APRICOT，未入 Apricot）</span>
        <span><i style={sw({ background: GRID_COLORS.closedBg })} />灰 · 滿 / 未開診 / 線上未開</span>
        <span>格內上下兩排 ＝ :00–:15 / :15–:30；深塊 ＝ 已佔席位（由左填起，唔代表椅號）</span>
        <span><i style={sw({ background: 'transparent', borderTop: '2px solid #dc2626', height: 0, borderRadius: 0, margin: '0 5px 0 3px' })} />而家</span>
      </div>
    )
  }

  const chip = data ? syncChip(data.sync) : null
  const chipStyle: Record<string, React.CSSProperties> = {
    gray: { background: '#f1f5f9', color: '#64748b' },
    warn: { background: '#fef2f2', color: '#b91c1c' },
    ok: { background: '#f0fdf4', color: '#15803d' },
  }

  // ─── 日頭 ───
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

  // ─── 員工當值 cell ───
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* ═══ header ═══ */}
      <div style={{ flexShrink: 0, background: '#fff', borderBottom: '1px solid #e5e7eb',
                    padding: '10px 12px', display: 'flex', alignItems: 'center',
                    gap: 8, flexWrap: 'wrap' }}>
        {zoomDate && (
          <button onClick={() => setZoomDate(null)}
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

      {/* ═══ header 第二行：醫生篩選 chip ═══ */}
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
                title={p.name}
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
                {on ? '✓ ' : ''}{docShortNames.get(p.name) ?? p.name}{p.weekBookings ? ` ${p.weekBookings}` : ''}{!hasData ? '（無數據）' : ''}
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

        {/* 未接通 ≠ 未開診 */}
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
                {/* GET 200 但全空 → 「未有資料」 */}
                {weekEmpty ? (
                  <div style={{ textAlign: 'center', padding: '48px 0' }}>
                    <div style={{ fontSize: 14, color: '#b45309', marginBottom: 6 }}>未有資料</div>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>
                      {data?.sync?.lastSyncAt
                        ? '已同步但呢一週冇開診時段 — 撳「↻ 立即同步」再試，或者確認 Apricot 嗰邊有排開診'
                        : '仲未同步過 — 撳右上角「↻ 立即同步」拉第一次資料'}
                    </div>
                  </div>
                ) : zoomDay ? (
                  /* ═══ 日視圖（3a 完整格；手機 tap 日 / 桌面撳日欄進入）═══ */
                  <div>
                    <DayView date={zoomDay.date} providers={zoomDay.providers} />
                    {showStaffRow && (
                      <div style={{ marginTop: 10, borderTop: '1.5px solid #e5e7eb', background: '#fafbfc',
                                     padding: '5px 8px', fontSize: 11, borderRadius: 6 }}>
                        <div style={{ color: '#94a3b8', marginBottom: 2 }}>員工當值</div>
                        {staffError
                          ? <span style={{ color: '#94a3b8' }}>載入失敗</span>
                          : renderStaffList(staffByDate.get(zoomDay.date) ?? [])}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {/* ═══ 桌面：四態格 × 七日（撳日欄 → 日視圖）═══ */}
                    <div className="hidden md:flex" style={{ gap: 4, alignItems: 'stretch' }}>
                      <div style={{ width: 44, flexShrink: 0, position: 'relative',
                                    marginTop: 24 + 22, height: rowCount * ROW_STEP - ROW_GAP }}>
                        {hourTicks.map(t => (
                          <span key={t.m} style={{
                            position: 'absolute', right: 6, transform: 'translateY(-50%)',
                            fontSize: 12, color: '#94a3b8',
                            top: ((t.m - axisMin) / 30) * ROW_STEP + ROW_H / 2,
                          }}>
                            {fmtMin(t.m)}
                          </span>
                        ))}
                      </div>
                      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
                        {visibleDays.map(day => (
                          <button key={day.date} onClick={() => setZoomDate(day.date)}
                            title="撳入睇一日四態格"
                            style={{ display: 'flex', flexDirection: 'column', minHeight: 0, textAlign: 'left',
                                     background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                            <div style={{ height: 24, textAlign: 'center', fontSize: 13 }}>
                              <DayHead date={day.date} mini={false} />
                            </div>
                            <div style={{ position: 'relative', borderRadius: 6,
                                          height: 22 + rowCount * ROW_STEP - ROW_GAP + 2,
                                          ...(day.date === today ? { boxShadow: '0 0 0 1px #2563eb' } : {}) }}>
                              {day.flag.hasPattern && day.flag.onDutyCount === 0 ? (
                                <div style={{
                                  position: 'absolute', left: 0, right: 0, top: 24, bottom: 0,
                                  borderRadius: 5,
                                  border: '0.5px dashed #cbd5e1',
                                  background: 'repeating-linear-gradient(45deg,#e9edf2,#e9edf2 6px,#f1f5f9 6px,#f1f5f9 12px)',
                                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                                  justifyContent: 'center', gap: 3,
                                }}>
                                  <span style={{ fontSize: 14 }}>🚫</span>
                                  <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>冇醫生當值</span>
                                </div>
                              ) : (
                                <WeekDayColumn date={day.date} providers={day.providers} mini={false} />
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 員工當值（表底） */}
                    {showStaffRow && (
                      <div className="hidden md:flex" style={{ gap: 4, marginTop: 8 }}>
                        <div style={{ width: 44, flexShrink: 0, padding: '6px 4px', fontSize: 11,
                                      color: '#94a3b8', textAlign: 'right', lineHeight: 1.3 }}>
                          員工<br />當值
                        </div>
                        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6,
                                       padding: '5px 0', borderTop: '1.5px solid #e5e7eb',
                                       background: '#fafbfc', borderRadius: 6 }}>
                          {daysInfo.map(day => (
                            <div key={`staff-${day.date}`} style={{ fontSize: 11, lineHeight: 1.6, padding: '0 3px' }}>
                              {staffError
                                ? <span style={{ color: '#94a3b8' }}>載入失敗</span>
                                : renderStaffList(staffByDate.get(day.date) ?? [])}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ═══ 手機：週概覽（mini 色條）— zoomDay 喺上面 shared DayView 分支（手機桌麵共用）═══ */}
                    <div className="md:hidden" style={{ minHeight: 380 }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                          <div style={{ width: 32, flexShrink: 0, position: 'relative', marginTop: 28 + 2 }}>
                            {hourTicks.map(t => (
                              <span key={t.m} style={{
                                position: 'absolute', right: 2, transform: 'translateY(-50%)',
                                fontSize: 11, color: '#94a3b8',
                                top: ((t.m - axisMin) / 30) * MINI_ROW_STEP + MINI_ROW_H / 2,
                              }}>
                                {fmtMin(t.m).slice(0, 2)}
                              </span>
                            ))}
                          </div>
                          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
                            {visibleDays.map(day => (
                              <button key={day.date} onClick={() => setZoomDate(day.date)}
                                style={{ display: 'flex', flexDirection: 'column', textAlign: 'left',
                                         background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                                <div style={{ height: 28, textAlign: 'center', fontSize: 11,
                                              lineHeight: 1.2, width: '100%' }}>
                                  <DayHead date={day.date} mini />
                                </div>
                                <div style={{ borderRadius: 6,
                                              ...(day.date === today ? { boxShadow: '0 0 0 1px #2563eb' } : {}) }}>
                                  {day.flag.hasPattern && day.flag.onDutyCount === 0 ? (
                                    <div style={{
                                      height: rowCount * MINI_ROW_STEP - MINI_ROW_GAP, borderRadius: 5,
                                      border: '0.5px dashed #cbd5e1',
                                      background: 'repeating-linear-gradient(45deg,#e9edf2,#e9edf2 6px,#f1f5f9 6px,#f1f5f9 12px)',
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    }}>
                                      <span style={{ fontSize: 11 }}>🚫</span>
                                    </div>
                                  ) : (
                                    <div style={{ height: rowCount * MINI_ROW_STEP - MINI_ROW_GAP + 2, paddingTop: 2 }}>
                                      <WeekDayColumn date={day.date} providers={day.providers} mini />
                                    </div>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                    </div>

                    {/* legend（四態 — MD §六 必須有） */}
                    <div style={{ marginTop: 10, paddingBottom: 60 }}>
                      <Legend />
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
