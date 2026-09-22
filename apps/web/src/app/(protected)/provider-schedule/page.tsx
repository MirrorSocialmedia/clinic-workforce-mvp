'use client'

import { useCallback, useEffect, useState, useRef, useMemo } from 'react'
import { apiFetch } from '@/lib/api-client'
import { todayHK, addDays, hkDayOfWeek, toHKDateStr } from '@/lib/hk-date'
import { hasPermission } from '@/lib/permissions'
// ★ cw-patwl §2：每週固定 pattern
import { resolveSlots, type SlotKey } from '@/lib/provider-pattern'
// ★ cw-pta §5：員工當值 mapping 抽咗入 lib（同 provider-availability 共用，唔寫第二份）
import { buildStaffByDate, shouldLoadStaffShifts } from '@/lib/staff-by-date'
// ★ cwm-provroster S2：同醫生時間表共用出入文案
import { mismatchBadge, mismatchText, MISMATCH_COLOR, type GridDay } from '@/lib/provider-availability-view'
// ★ cwm-provroster S3：一格嘅顯示資料（桌面／手機／詳情共用）＋ S4 自動更新
import { buildCellInfo, cellColors, mondayOf, SLOT_TEXT, type CellInfo } from '@/lib/provider-cell'
import { useAutoRefresh } from '@/lib/use-auto-refresh'
import { useLatestRequest } from '@/lib/use-latest-request'
import { notifyDataChanged } from '@/lib/live-refresh' // ★ cwm-provroster B4：mutation 成功後通知同機其他 tab（'provider' topic）
import DayDetailPanel, { type ExceptionInput } from '@/components/provider-schedule/DayDetailPanel'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ChevronLeft, ChevronRight, X, CalendarDays, CalendarPlus } from 'lucide-react'

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
// ★ cwm-provroster S3：統一星期一起（固定表本來就係一…日；本週實況之前由星期日開始）
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const PATTERN_OPTIONS: Array<{ v: SlotKey | ''; label: string }> = [
  { v: 'FULL', label: '全日' }, { v: 'AM', label: 'AM' }, { v: 'PM', label: 'PM' }, { v: '', label: '清除（唔排）' },
]

function mondayStr(d: string): string { return addDays(d, -mondayOf(hkDayOfWeek(d))) }

export default function ProviderSchedulePage() {
  const [weekStart, setWeekStart] = useState(() => mondayStr(todayHK()))
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<any[]>([])
  const [selectedClinicId, setSelectedClinicId] = useState<string | null>(null)
  const [shifts, setShifts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState<string>('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const [scope, setScope] = useState<string[] | null>(null)
  const [scopeLoaded, setScopeLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ★ cw-patwl §2.1：兩個 tab —— 每週固定表（pattern）/ 本週實況
  const [mode, setMode] = useState<'pattern' | 'week'>('week')
  const [patternMap, setPatternMap] = useState<Map<string, string>>(new Map())
  const [patternLoading, setPatternLoading] = useState(false)
  const [patternError, setPatternError] = useState<string | null>(null)
  // ★ cwm-provroster S3：固定表改用「揀」唔再「撳格循環」（循環每撳一下就存一次，又冇得 undo）
  const [patternPick, setPatternPick] = useState<{ providerId: string; weekday: number } | null>(null)
  const patternConfirmedRef = useRef(false) // 拍板：唔留歷史 → 每次開頁第一次改要確認

  // ★ cwm-provroster S2：Apricot 實際（同一週）—— key `${date}|${providerId}`；未接通 Apricot 嘅店唔拉
  const [apricotByKey, setApricotByKey] = useState<Map<string, GridDay>>(new Map())

  // Staff shifts for employee summary row
  const [staffShifts, setStaffShifts] = useState<any[]>([])
  const [staffError, setStaffError] = useState(false)

  const [showAllProviders, setShowAllProviders] = useState(false)

  // ★ Provider leave state
  const [leaves, setLeaves] = useState<any[]>([])
  const [leaveModalOpen, setLeaveModalOpen] = useState(false)
  const [leaveForm, setLeaveForm] = useState({ providerId: '', startDate: '', endDate: '', note: '' })
  const [savingLeave, setSavingLeave] = useState(false)
  // ★ cwm-provroster S1-3：休假可以改／刪
  const [editingLeaveId, setEditingLeaveId] = useState<string | null>(null)
  const [listLeaves, setListLeaves] = useState<any[]>([])

  // ★ cwm-provroster S3：當日詳情面板 + toast（取代 alert）
  const [detail, setDetail] = useState<{ date: string; providerId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showToast(tone: 'ok' | 'err', text: string) {
    setToast({ tone, text })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    if (tone === 'ok') toastTimer.current = setTimeout(() => setToast(null), 3500)
  }
  /** ★ S3：session 過期 → 帶返登入頁（之前 alert「Unauthorized」停喺原頁） */
  function fail(e: any, fallback: string) {
    if (e?.status === 401) { window.location.href = '/login'; return }
    showToast('err', e?.message || fallback)
  }

  const canSchedule = userRole
    ? hasPermission(userRole, 'provider_schedule', grant, deny)
    : false
  // ★ cw-patwl：pattern 編輯只限 OWNER/MANAGER（KIOSK 只讀；本週例外 KIOSK 維持可改 —— 2026-09-20 拍板維持現狀）
  const canManage = userRole === 'OWNER' || userRole === 'MANAGER' // ROLE-OK: MD cw-patwl 拍板 —— 當值表只准 OWNER/MANAGER 改

  // Batch modal state（S3：只做「批量排」—— 單日改動行當日詳情）
  const [modalOpen, setModalOpen] = useState(false)
  const [modalCell, setModalCell] = useState<{ date: string; providerId: string } | null>(null)
  const [modalEntries, setModalEntries] = useState<Array<{
    providerId: string; clinicId: string; start: string; end: string; note: string; slot: string
  }>>([])
  const [modalRepeatWeeks, setModalRepeatWeeks] = useState(1)
  const [modalConflict, setModalConflict] = useState<'skip' | 'overwrite'>('skip')
  const [saving, setSaving] = useState(false)
  const [weekdays, setWeekdays] = useState<number[]>([])

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])
  const weekEnd = weekDays[6]

  const visibleClinics = scope === null ? clinics : clinics.filter((c: any) => scope.includes(c.id))
  const selectedClinic = clinics.find((c: any) => c.id === selectedClinicId)
  const clinicSlots = useMemo(() => resolveSlots(selectedClinic?.config ?? null), [selectedClinic])

  // ★ S3：由醫生時間表「去當值表 ›」帶 ?clinicId=&date= 入嚟 —— 開到嗰間店嗰一週
  const deepLinkRef = useRef<{ clinicId?: string; date?: string } | null>(null)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const date = sp.get('date') ?? undefined
    deepLinkRef.current = { clinicId: sp.get('clinicId') ?? undefined, date }
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setWeekStart(mondayStr(date))
  }, [])

  // ★ Auto-select default clinic once scope + clinics are ready
  useEffect(() => {
    if (!scopeLoaded) return
    if (selectedClinicId) return
    if (!clinics.length) return
    const allowed = scope === null ? clinics : clinics.filter((c: any) => scope.includes(c.id))
    const wanted = deepLinkRef.current?.clinicId
    const pick = allowed.find((c: any) => c.id === wanted) ?? allowed[0]
    if (pick) setSelectedClinicId(pick.id)
  }, [scopeLoaded, scope, clinics, selectedClinicId])

  // ★ shiftByDay: Map<"date|providerId", shift[]>
  const shiftByDay = useMemo(() => {
    const m = new Map<string, any[]>()
    for (const s of shifts) {
      const key = `${toHKDateStr(s.date)}|${s.providerId}`
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(s)
    }
    return m
  }, [shifts])

  const staffByDate = useMemo(
    () => buildStaffByDate(staffShifts, selectedClinicId),
    [staffShifts, selectedClinicId],
  )

  // ★ visibleProviders: filtered by clinic binding (未綁店嘅照顯示)
  const visibleProviders = useMemo(() =>
    providers.filter(p => {
      if (!p.isActive) return false
      if (showAllProviders) return true
      if (!p.clinicIds?.length) return true // ★ IRON RULE: 未綁店嘅照顯示
      return p.clinicIds.includes(selectedClinicId)
    }),
    [providers, selectedClinicId, showAllProviders]
  )

  // ★ leaveByDay: Map<"date|providerId", leave>
  const leaveByDay = useMemo(() => {
    const m = new Map<string, any>()
    for (const l of leaves) {
      let cur = toHKDateStr(l.startDate)
      const end = toHKDateStr(l.endDate)
      let guard = 0
      while (cur <= end && guard < 400) {
        const dk = `${cur}|${l.providerId}`
        if (!m.has(dk)) m.set(dk, l)
        cur = addDays(cur, 1)
        guard += 1
      }
    }
    return m
  }, [leaves])

  /** ★ S3：一格嘅顯示資料 —— 休假 > 例外（含唔返）> 固定表 > 冇排（同 resolveOnDuty 次序一致） */
  const cellInfoOf = useCallback((date: string, providerId: string): CellInfo => buildCellInfo({
    patternSlot: patternMap.get(`${providerId}:${hkDayOfWeek(date)}`) ?? null,
    shift: shiftByDay.get(`${date}|${providerId}`)?.[0] ?? null,
    leave: leaveByDay.get(`${date}|${providerId}`) ?? null,
    slots: clinicSlots,
  }), [patternMap, shiftByDay, leaveByDay, clinicSlots])

  // Load providers, clinics, and user role
  useEffect(() => {
    Promise.all([
      apiFetch<any>('/api/providers').catch(() => ({ providers: [] })),
      apiFetch<any>('/api/clinics').catch(() => ({ clinics: [] })),
      apiFetch<any>('/api/me').catch(() => ({ user: { role: '', grant: [], deny: [] } })),
    ]).then(([provRes, clinicRes, meRes]) => {
      const provs = (provRes.providers || []).filter((p: any) => p.isActive)
      setProviders(provs)
      setClinics(clinicRes.clinics || [])
      setUserRole(meRes.user?.role ?? '')
      setGrant(meRes.user?.grant ?? [])
      setDeny(meRes.user?.deny ?? [])
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadShifts() }, [weekStart, weekEnd, selectedClinicId])
  useEffect(() => {
    if (shouldLoadStaffShifts(userRole)) loadStaffShifts()
  }, [weekStart, weekEnd, selectedClinicId, userRole])
  useEffect(() => {
    if (canSchedule) loadLeaves()
  }, [weekStart, weekEnd, canSchedule])

  async function loadLeaves() {
    try {
      const params = new URLSearchParams({ startDate: weekStart, endDate: weekEnd })
      const res = await apiFetch<any>(`/api/provider-leaves?${params}`)
      setLeaves(res.leaves || [])
    } catch (e) { console.error('[provider-schedule] load leaves failed', e) }
  }

  // ★ V-6：轉週／deep-link 雙載／60s refresh 重疊時，舊回應唔准蓋新（abort + seq）
  const shiftsReqP = useLatestRequest()
  const apricotReqP = useLatestRequest()
  async function loadShifts() {
    const { signal, isLatest } = shiftsReqP()
    try {
      setLoadError(null)
      const params = new URLSearchParams({
        startDate: weekStart, endDate: weekEnd,
        ...(selectedClinicId ? { clinicId: selectedClinicId } : {}),
      })
      const res = await apiFetch<any>(`/api/provider-shifts?${params}`, { signal })
      if (!isLatest()) return
      setShifts(res.shifts || [])
      setScope(res.scope ?? null)
      setScopeLoaded(true)
    } catch (e: any) {
      if (!isLatest() || e?.name === 'AbortError') return
      console.error('[provider-schedule] load shifts failed', e)
      if (e?.status === 401) { window.location.href = '/login'; return }
      if (e?.status === 403 && selectedClinicId) {
        setSelectedClinicId(null)
        setLoadError('已切換至有權限的診所')
        return
      }
      setLoadError(e?.message ?? '載入當值記錄失敗')
    }
  }

  async function loadStaffShifts() {
    try {
      setStaffError(false)
      const res = await apiFetch<any>(
        `/api/shifts?startDate=${weekStart}&endDate=${weekEnd}&pageSize=1000`)
      setStaffShifts(res.shifts || [])
    } catch (e) {
      console.error('[provider-schedule] load staff shifts failed', e)
      setStaffShifts([])
      setStaffError(true)
    }
  }

  // ★ cwm-provroster S2：同一週 Apricot 開診／預約／出入（同醫生時間表同一條 API）
  async function loadApricot() {
    const c = clinics.find((x: any) => x.id === selectedClinicId)
    if (!c?.apricotClinicId) { setApricotByKey(new Map()); return }
    const { signal, isLatest } = apricotReqP()   // ★ V-6
    try {
      const res = await apiFetch<any>(`/api/provider-availability/grid?clinicId=${selectedClinicId}&from=${weekStart}`, { signal })
      if (!isLatest()) return
      const m = new Map<string, GridDay>()
      for (const p of res.providers || []) for (const d of p.days || []) m.set(`${d.date}|${p.id}`, d)
      setApricotByKey(m)
    } catch (e: any) {
      if (!isLatest() || e?.name === 'AbortError') return
      console.error('[provider-schedule] load apricot failed', e)
      setApricotByKey(new Map())
    }
  }
  useEffect(() => {
    if (selectedClinicId && clinics.length) loadApricot()
  }, [selectedClinicId, weekStart, clinics])

  async function loadPatterns() {
    if (!selectedClinicId) { setPatternMap(new Map()); return }
    try {
      setPatternLoading(true)
      setPatternError(null)
      const res = await apiFetch<any>(`/api/provider-patterns?clinicId=${selectedClinicId}`)
      const m = new Map<string, string>()
      for (const p of res.patterns || []) m.set(`${p.providerId}:${p.weekday}`, p.slot)
      setPatternMap(m)
    } catch (e: any) {
      console.error('[provider-schedule] load patterns failed', e)
      setPatternError('載入每週固定表失敗')
    } finally { setPatternLoading(false) }
  }
  useEffect(() => {
    if (canSchedule) loadPatterns()
  }, [selectedClinicId, canSchedule])

  // ★ cwm-provroster S4：開住頁每 60 秒 + 返到頁面即刻更新（前台 iPad 唔會再睇住舊當值表）
  //   有 modal／面板開住就暫停，免得蓋走用戶正在填嘅嘢
  useAutoRefresh(() => {
    loadShifts()
    if (canSchedule) { loadLeaves(); loadPatterns() }
    if (shouldLoadStaffShifts(userRole)) loadStaffShifts()
    loadApricot()
  }, 60_000, !modalOpen && !leaveModalOpen && !detail && !patternPick)

  // ★ S3：Esc 關 modal（之前 Esc 冇反應）—— 詳情面板自己處理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setModalOpen(false); setLeaveModalOpen(false); setPatternPick(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ★ cwm-provroster S3+S4：固定表 —— 揀 slot 先存；第一次確認（改咗即影響所有週，包括過去）；樂觀鎖
  async function savePattern(providerId: string, weekday: number, next: string) {
    if (!selectedClinicId || !canManage) return
    const key = `${providerId}:${weekday}`
    const cur = patternMap.get(key) ?? ''
    setPatternPick(null)
    if (next === cur) return
    if (!patternConfirmedRef.current) {
      if (!confirm('修改「每週固定表」會即時影響所有週，包括已經過去嘅週（系統唔留舊版本）。\n\n只係某一日唔同，請去「本週實況」撳嗰日改。\n\n確定修改固定表？')) return
      patternConfirmedRef.current = true
    }
    setPatternMap(prev => new Map(prev).set(key, next))
    setPatternError(null)
    try {
      await apiFetch<any>('/api/provider-patterns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, clinicId: selectedClinicId, weekday, slot: next || null, expected: cur || null }),
      })
      notifyDataChanged('provider')   // ★ V-3：B4 漏咗固定表 —— 其他 tab 要等 60s 先見到
      const name = providers.find(p => p.id === providerId)?.name ?? ''
      showToast('ok', `已儲存：${name} 逢星期${DAY_LABELS[weekday]} → ${next ? SLOT_TEXT[next as SlotKey] : '唔排'}`)
    } catch (e: any) {
      setPatternMap(prev => new Map(prev).set(key, cur))
      if (e?.status === 409) { await loadPatterns(); showToast('err', e.message); return }
      fail(e, '儲存失敗，已還原')
    }
  }

  // ─── ★ S3：當日詳情動作 ───
  async function saveException(date: string, providerId: string, info: CellInfo, input: ExceptionInput) {
    setBusy(true)
    try {
      if (info.shift) {
        await apiFetch<any>(`/api/provider-shifts/${info.shift.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, expectedUpdatedAt: info.shift.updatedAt }),
        })
      } else {
        // ★ H1-11（P1-11）：唔可以 overwrite —— batch overwrite 按 (醫生, 日期, 開始時間) 跨診所 match，
        //   會將醫生喺其他診所嗰行搬過嚟本店（OWNER）或者靜靜略過但照報「已儲存」（MANAGER／KIOSK）
        const res = await apiFetch<any>('/api/provider-shifts/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entries: [{ providerId, clinicId: selectedClinicId, date, start: input.start, end: input.end, note: input.note, slot: input.slot ?? '' }],
            repeatWeeks: 1, onConflict: 'skip',
          }),
        })
        if (!res?.created) {
          throw Object.assign(new Error(`醫生 ${date} 已經有同一開始時間（${input.start}）嘅當值（可能喺其他診所）—— 請先喺嗰間診所修改或刪除`), { status: 409 })
        }
      }
      await loadShifts()
      notifyDataChanged('provider') // ★ cwm-provroster B4：同機其他 tab 即刻同步
      loadApricot()
      setDetail(null)
      showToast('ok', input.slot === 'OFF' ? `已設為當日唔返（${date}）` : `已儲存 ${date} ${input.slot ? SLOT_TEXT[input.slot] : ''} ${input.start}–${input.end}`)
    } catch (e: any) {
      if (e?.status === 409 || e?.status === 404) { await loadShifts(); setDetail(null) }
      fail(e, '儲存失敗')
    } finally { setBusy(false) }
  }

  async function restorePattern(info: CellInfo) {
    if (!info.shift) return
    setBusy(true)
    try {
      await apiFetch<any>(`/api/provider-shifts/${info.shift.id}`, { method: 'DELETE' })
      await loadShifts()
      notifyDataChanged('provider') // ★ cwm-provroster B4
      loadApricot()
      setDetail(null)
      showToast('ok', info.patternSlot ? '已還原固定表' : '已刪除當日當值')
    } catch (e: any) {
      // ★ V-8：已被人改／刪 → 重載兼關面板（同 saveException 一致），唔好留住舊面板
      if (e?.status === 409 || e?.status === 404) { await loadShifts(); setDetail(null) }
      fail(e, '刪除失敗')
    }
    finally { setBusy(false) }
  }

  // ─── 批量排（多日／多週）───
  function openBatch(date: string, providerId: string) {
    setModalCell({ date, providerId })
    setModalEntries([{ providerId, clinicId: selectedClinicId || '', start: clinicSlots.FULL.start, end: clinicSlots.FULL.end, note: '', slot: 'FULL' }])
    setWeekdays([])
    setModalRepeatWeeks(1)
    setModalConflict('skip')
    setModalOpen(true)
  }

  function changeEntrySlot(i: number, slot: string) {
    setModalEntries(prev => {
      const next = [...prev]
      next[i] = { ...next[i], slot }
      if (slot === 'FULL' || slot === 'AM' || slot === 'PM' || slot === 'OFF') {
        const c = clinics.find((x: any) => x.id === (next[i].clinicId || selectedClinicId))
        const slots = resolveSlots((c as any)?.config ?? null)
        const t = slots[slot === 'OFF' ? 'FULL' : slot]
        next[i] = { ...next[i], start: t.start, end: t.end }
      }
      return next
    })
  }

  async function handleSaveModal() {
    setSaving(true)
    try {
      // ★ S3：星期一起 —— 同一週內嘅目標日 = 週一 + 該星期嘅 offset
      const monday = mondayStr(modalCell!.date)
      const targetDates = weekdays.length
        ? WEEK_ORDER.filter(wd => weekdays.includes(wd)).map(wd => addDays(monday, mondayOf(wd)))
        : [modalCell!.date]
      const entries = targetDates
        .flatMap(date => modalEntries.map(en => ({ ...en, date })))
        .filter(en => en.providerId && en.clinicId && selectedClinicId)
      if (!entries.length) { showToast('err', '缺少必要資訊'); return }

      const res = await apiFetch<any>('/api/provider-shifts/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, repeatWeeks: modalRepeatWeeks, onConflict: modalConflict }),
      })
      showToast(res.skipped > 0 ? 'err' : 'ok', res.skipped > 0
        ? `已新增 ${res.created} 日${res.updated ? `、更新 ${res.updated} 日` : ''}；${res.skipped} 日原本已有當值，冇改到${res.crossClinic ? `（其中 ${res.crossClinic} 日係其他診所嘅當值，唔會搬過嚟）` : '（要改請揀「衝突處理：覆蓋」或者撳嗰日改）'}`
        : `已儲存：新增 ${res.created} 日${res.updated ? `、更新 ${res.updated} 日` : ''}`)
      setModalOpen(false)
      await loadShifts()
      notifyDataChanged('provider') // ★ cwm-provroster B4
      loadApricot()
    } catch (e: any) {
      fail(e, '儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  // ─── 休假 ───
  async function loadListLeaves() {
    try {
      const t = todayHK()
      const params = new URLSearchParams({ startDate: addDays(t, -60), endDate: addDays(t, 180) })
      const res = await apiFetch<any>(`/api/provider-leaves?${params}`)
      setListLeaves(res.leaves || [])
    } catch (e) { console.error('[provider-schedule] load leave list failed', e) }
  }

  function openLeaveModal(leave: any | null, prefill?: { providerId?: string; date?: string }) {
    setEditingLeaveId(leave?.id ?? null)
    setLeaveForm(leave
      ? { providerId: leave.providerId, startDate: toHKDateStr(leave.startDate), endDate: toHKDateStr(leave.endDate), note: leave.note ?? '' }
      : { providerId: prefill?.providerId ?? '', startDate: prefill?.date ?? '', endDate: prefill?.date ?? '', note: '' })
    setLeaveModalOpen(true)
    loadListLeaves()
  }

  async function handleSaveLeave() {
    if (!leaveForm.providerId || !leaveForm.startDate || !leaveForm.endDate) {
      showToast('err', '醫生、開始日、結束日必填')
      return
    }
    setSavingLeave(true)
    try {
      await apiFetch<any>(editingLeaveId ? `/api/provider-leaves/${editingLeaveId}` : '/api/provider-leaves', {
        method: editingLeaveId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leaveForm),
      })
      showToast('ok', editingLeaveId ? '休假已修改' : '休假已新增')
      setLeaveModalOpen(false)
      setEditingLeaveId(null)
      await loadLeaves()
      notifyDataChanged('provider') // ★ cwm-provroster B4
      loadApricot()
    } catch (e: any) { fail(e, '儲存失敗') }
    finally { setSavingLeave(false) }
  }

  async function handleDeleteLeave(leaveId: string) {
    if (!confirm('確定刪除呢個休假？')) return
    try {
      await apiFetch<any>(`/api/provider-leaves/${leaveId}`, { method: 'DELETE' })
      if (editingLeaveId === leaveId) { setEditingLeaveId(null); setLeaveForm({ providerId: '', startDate: '', endDate: '', note: '' }) }
      await Promise.all([loadLeaves(), leaveModalOpen ? loadListLeaves() : Promise.resolve()])
      notifyDataChanged('provider') // ★ cwm-provroster B4
      loadApricot()
      setDetail(null)
      showToast('ok', '休假已刪除')
    } catch (e: any) { fail(e, '刪除失敗') }
  }

  function prevWeek() { setWeekStart(addDays(weekStart, -7)) }
  function nextWeek() { setWeekStart(addDays(weekStart, 7)) }
  function goToday() { setWeekStart(mondayStr(todayHK())) }

  /** ★ S3：格內顯示（桌面表格同手機卡片共用） */
  function CellBody({ date, providerId, compact }: { date: string; providerId: string; compact?: boolean }) {
    const info = cellInfoOf(date, providerId)
    const ap = apricotByKey.get(`${date}|${providerId}`)
    const badge = ap ? mismatchBadge(ap) : null
    const { bg, fg } = cellColors(info)
    return (
      <div className={compact ? 'flex items-center gap-2 flex-wrap' : ''}>
        {info.kind === 'none' ? (
          <span style={{ color: '#cbd5e1', fontSize: 12 }}>{compact ? '冇排' : '·'}</span>
        ) : (
          <span style={{
            display: 'inline-block', padding: '2px 8px', borderRadius: 4, background: bg, color: fg,
            fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
            ...(info.isException && info.kind === 'duty' ? { border: '1.5px solid #f59e0b' } : {}),
          }}>
            {info.label}{info.isException && info.kind === 'duty' ? ' ✎' : ''}
          </span>
        )}
        {info.kind === 'duty' && info.slot && (
          <div style={{ fontSize: 10, color: '#64748b', marginTop: compact ? 0 : 2 }}>{info.time?.replace(/:00/g, '')}</div>
        )}
        {info.note && (
          <div title={info.note} style={{ fontSize: 10, color: '#64748b', marginTop: compact ? 0 : 2, maxWidth: compact ? 'none' : 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {info.note}
          </div>
        )}
        {ap && (
          <div title={mismatchText(ap) ?? undefined}
            style={{ fontSize: 10, marginTop: compact ? 0 : 2, color: badge ? MISMATCH_COLOR : '#94a3b8', fontWeight: badge ? 600 : 400 }}>
            {badge ? `⚠️ ${badge}` : 'Apricot'}{ap.bookCount ? ` · ${ap.bookCount} 約` : ''}
          </div>
        )}
      </div>
    )
  }

  if (loading) return <div className="p-8 text-center text-muted-foreground">載入中...</div>

  const detailInfo = detail ? cellInfoOf(detail.date, detail.providerId) : null
  const detailProvider = detail ? providers.find(p => p.id === detail.providerId) : null
  const today = todayHK()

  return (
    <div className="space-y-4 p-4 pb-[calc(88px+env(safe-area-inset-bottom))] md:pb-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-bold">醫生當值表</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {canManage && (   // ★ V-2：休假只准 OWNER/MANAGER（server 亦擋 KIOSK）
            <button onClick={() => openLeaveModal(null)}
              className="text-xs px-2 py-1.5 border rounded hover:bg-muted flex items-center gap-1">
              <CalendarDays className="w-3 h-3" /> 醫生休假
            </button>
          )}
          {canSchedule && mode === 'week' && (
            <button onClick={() => openBatch(weekStart, visibleProviders[0]?.id ?? '')}
              className="text-xs px-2 py-1.5 border rounded hover:bg-muted flex items-center gap-1">
              <CalendarPlus className="w-3 h-3" /> 批量排
            </button>
          )}
          {visibleClinics.length > 1 && (
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input type="checkbox" checked={showAllProviders} onChange={e => setShowAllProviders(e.target.checked)} />
              顯示全部醫生
            </label>
          )}
          {visibleClinics.length === 1
            ? <span className="text-sm font-medium">{visibleClinics[0].name}</span>
            : <select value={selectedClinicId || ''} onChange={e => setSelectedClinicId(e.target.value)} className="border rounded px-2 py-1 text-sm">
                {visibleClinics.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>}
          <div className="flex border rounded overflow-hidden">
            <button onClick={() => setMode('pattern')}
              className={`px-2 py-1.5 text-xs ${mode === 'pattern' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
              每週固定表
            </button>
            <button onClick={() => setMode('week')}
              className={`px-2 py-1.5 text-xs ${mode === 'week' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
              本週實況
            </button>
          </div>
          {mode === 'week' && (
            <div className="flex items-center gap-1">
              <button onClick={prevWeek} aria-label="上一週" className="h-9 w-9 flex items-center justify-center hover:bg-muted rounded"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={goToday} className="h-9 text-xs px-2 hover:bg-muted rounded">今週</button>
              <button onClick={nextWeek} aria-label="下一週" className="h-9 w-9 flex items-center justify-center hover:bg-muted rounded"><ChevronRight className="w-4 h-4" /></button>
              <span className="text-sm font-medium">{weekDays[0]} ~ {weekDays[6]}</span>
            </div>
          )}
        </div>
      </div>

      {loadError && (
        <div className="mb-2 px-3 py-2 text-sm rounded bg-destructive/10 text-destructive">
          載入失敗：{loadError}
          <button onClick={() => { setLoadError(null); loadShifts() }} className="ml-2 underline">重試</button>
        </div>
      )}
      {mode === 'pattern' && patternError && (
        <div className="px-3 py-2 text-sm rounded bg-destructive/10 text-destructive">{patternError}</div>
      )}

      {mode === 'pattern' ? (
        <Card className="overflow-x-auto">
          <div className="px-3 py-2 text-xs text-muted-foreground border-b">
            撳格揀：全日／AM／PM／清除。時間跟診所「時段設定」（全日 {clinicSlots.FULL.start}–{clinicSlots.FULL.end}、AM {clinicSlots.AM.start}–{clinicSlots.AM.end}、PM {clinicSlots.PM.start}–{clinicSlots.PM.end}）。
            <b className="text-amber-700"> 改固定表會影響所有週（包括過去）；只改某一日請用「本週實況」。</b>
            {!canManage && '（只讀 —— 每週固定表只准 OWNER/MANAGER 修改）'}
            {patternLoading && '（載入中...）'}
          </div>
          <table className="w-full text-xs border-separate border-spacing-0">
            <thead>
              <tr className="bg-muted/50">
                <th className="sticky left-0 z-10 bg-muted p-2 text-left min-w-[120px]">醫生</th>
                {WEEK_ORDER.map(wd => (
                  <th key={wd} className="p-2 text-center min-w-[80px]" style={{ fontSize: 13 }}>星期{DAY_LABELS[wd]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleProviders.map(p => (
                <tr key={p.id}>
                  <td className="sticky left-0 z-10 bg-background p-2 font-medium border-t" style={{ borderRight: '2px solid #e5e7eb', fontSize: 14 }}>
                    <span style={{ color: p.color || '#888' }}>●</span> {p.name}
                  </td>
                  {WEEK_ORDER.map(wd => {
                    const slot = (patternMap.get(`${p.id}:${wd}`) ?? '') as SlotKey | ''
                    const open = patternPick?.providerId === p.id && patternPick?.weekday === wd
                    return (
                      <td key={wd} className="border-t relative"
                        onClick={() => canManage && setPatternPick(open ? null : { providerId: p.id, weekday: wd })}
                        style={{ cursor: canManage ? 'pointer' : 'default', textAlign: 'center', padding: 8, background: canManage ? undefined : '#f8fafc' }}>
                        {slot ? (
                          <span style={{
                            display: 'inline-block', minWidth: 44, padding: '2px 8px', borderRadius: 4, fontSize: 13, fontWeight: 600,
                            ...(() => { const c = cellColors({ kind: 'duty', slot } as CellInfo); return { background: c.bg, color: c.fg } })(),
                          }}>{SLOT_TEXT[slot]}</span>
                        ) : (
                          <span style={{ color: '#e5e7eb', fontSize: 12 }}>·</span>
                        )}
                        {open && (
                          <div onClick={e => e.stopPropagation()}
                            className="absolute z-20 left-1/2 -translate-x-1/2 top-full mt-1 w-32 rounded-lg border bg-background shadow-lg p-1 text-left">
                            {PATTERN_OPTIONS.map(o => (
                              <button key={o.v || 'none'} onClick={() => savePattern(p.id, wd, o.v)}
                                className={`w-full h-9 px-2 rounded text-sm text-left hover:bg-muted ${o.v === slot ? 'font-bold' : ''}`}>
                                {o.v === slot ? '✓ ' : ''}{o.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
      <>
      {/* ═══ 桌面：週表 ═══ */}
      <Card className="overflow-x-auto hidden md:block">
        <table className="w-full text-xs border-separate border-spacing-0">
          <thead>
            <tr className="bg-muted/50">
              <th className="sticky left-0 z-10 bg-muted p-2 text-left min-w-[120px]">醫生</th>
              {weekDays.map(d => (
                <th key={d} className="p-2 text-center min-w-[100px]" style={{ fontSize: 13 }}>
                  <div>星期{DAY_LABELS[hkDayOfWeek(d)]}</div>
                  <div className="text-muted-foreground">{d}</div>
                  {d === today && <Badge variant="secondary" className="mt-1">今日</Badge>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleProviders.map(p => (
              <tr key={p.id}>
                <td className="sticky left-0 z-10 bg-background p-2 font-medium border-t" style={{ borderRight: '2px solid #e5e7eb', fontSize: 14 }}>
                  <span style={{ color: p.color || '#888' }}>●</span> {p.name}
                </td>
                {weekDays.map(d => (
                  <td key={d} className="p-2 text-center border-t border-l align-top hover:bg-muted/40"
                    onClick={() => setDetail({ date: d, providerId: p.id })}
                    style={{ cursor: 'pointer', minHeight: 48 }}>
                    <CellBody date={d} providerId={p.id} />
                  </td>
                ))}
              </tr>
            ))}

            {userRole !== 'KIOSK' && (
            <tr>
              <td className="sticky left-0 z-10 bg-muted/30 p-2 font-medium text-muted-foreground border-t-2">員工當值</td>
              {weekDays.map(d => (
                <td key={d} className="p-2 align-top bg-muted/10 border-t-2">
                  {staffError
                    ? <div className="text-[11px] text-muted-foreground">載入失敗</div>
                    : (() => {
                        const list = staffByDate.get(d) ?? []
                        if (list.length === 0) return <div className="text-[11px] text-muted-foreground/30 text-center">—</div>
                        return (
                          <div className="flex flex-col gap-0.5">
                            {list.map((s, i) => (
                              <div key={`${s.id}-${i}`} className="text-[11px] leading-tight whitespace-nowrap">
                                <span className={s.transfer ? 'text-amber-700' : ''}>{s.name}</span>
                                {s.transfer && <span className="ml-0.5 text-amber-600">·調</span>}
                                <span className="text-muted-foreground ml-1">{s.start}–{s.end}</span>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                </td>
              ))}
            </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* ═══ 手機：一日一張卡（S3）═══ */}
      <div className="md:hidden space-y-3">
        {weekDays.map(d => (
          <Card key={d} className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-bold">星期{DAY_LABELS[hkDayOfWeek(d)]}</span>
              <span className="text-sm text-muted-foreground">{d.slice(5)}</span>
              {d === today && <Badge variant="secondary">今日</Badge>}
            </div>
            <div className="divide-y">
              {visibleProviders.map(p => (
                <button key={p.id} onClick={() => setDetail({ date: d, providerId: p.id })}
                  className="w-full flex items-center gap-3 py-2 text-left min-h-[44px]">
                  <span className="w-24 shrink-0 text-sm font-medium truncate"><span style={{ color: p.color || '#888' }}>●</span> {p.name}</span>
                  <CellBody date={d} providerId={p.id} compact />
                </button>
              ))}
            </div>
          </Card>
        ))}
      </div>
      </>
      )}

      {/* ★ S3：當日詳情 */}
      {detail && detailInfo && (
        <DayDetailPanel
          date={detail.date}
          dow={hkDayOfWeek(detail.date)}
          providerName={detailProvider?.name ?? ''}
          providerColor={detailProvider?.color ?? null}
          clinicName={selectedClinic?.name ?? ''}
          info={detailInfo}
          apricot={apricotByKey.get(`${detail.date}|${detail.providerId}`)}
          slots={clinicSlots}
          canEdit={canSchedule}
          canEditLeave={canManage}   // ★ V-2：KIOSK 唔准郁休假（server 亦擋）
          busy={busy}
          onClose={() => setDetail(null)}
          onSaveException={input => saveException(detail.date, detail.providerId, detailInfo, input)}
          onRestorePattern={() => restorePattern(detailInfo)}
          onEditLeave={() => { const lv = detailInfo.leave; setDetail(null); openLeaveModal(lv) }}
          onDeleteLeave={() => handleDeleteLeave(detailInfo.leave.id)}
          onNewLeave={() => { const d = detail; setDetail(null); openLeaveModal(null, { providerId: d.providerId, date: d.date }) }}
          onOpenBatch={() => { const d = detail; setDetail(null); openBatch(d.date, d.providerId) }}
        />
      )}

      {/* Batch Modal（批量排） */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setModalOpen(false)}>
          <Card className="w-full max-w-md p-4 m-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold">批量排醫生當值</h3>
              <button onClick={() => setModalOpen(false)} aria-label="關閉"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1 block">由呢一日開始</label>
                <input type="date" value={modalCell?.date || ''} onChange={e => setModalCell(c => c ? { ...c, date: e.target.value } : c)}
                  className="w-full border rounded px-2 py-1 text-sm" />
              </div>
              {modalEntries.map((en, i) => (
                <div key={i} className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground">醫生</label>
                    <select value={en.providerId} onChange={e => {
                      const next = [...modalEntries]; next[i].providerId = e.target.value; setModalEntries(next)
                    }} className="w-full border rounded px-2 py-1 text-sm">
                      {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">診所</label>
                    <select value={en.clinicId} onChange={e => {
                      const next = [...modalEntries]; next[i].clinicId = e.target.value; setModalEntries(next)
                    }} className="w-full border rounded px-2 py-1 text-sm">
                      {visibleClinics.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">時段</label>
                    <select value={en.slot} onChange={e => changeEntrySlot(i, e.target.value)} className="w-full border rounded px-2 py-1 text-sm">
                      <option value="FULL">全日（{clinicSlots.FULL.start}–{clinicSlots.FULL.end}）</option>
                      <option value="AM">AM（{clinicSlots.AM.start}–{clinicSlots.AM.end}）</option>
                      <option value="PM">PM（{clinicSlots.PM.start}–{clinicSlots.PM.end}）</option>
                      <option value="">自訂時間</option>
                      <option value="OFF">當日唔返（唔係休假）</option>
                    </select>
                  </div>
                  {en.slot === '' && (<>
                    <div>
                      <label className="text-xs text-muted-foreground">開始</label>
                      <input type="time" value={en.start} onChange={e => {
                        const next = [...modalEntries]; next[i].start = e.target.value; setModalEntries(next)
                      }} className="w-full border rounded px-2 py-1 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">結束</label>
                      <input type="time" value={en.end} onChange={e => {
                        const next = [...modalEntries]; next[i].end = e.target.value; setModalEntries(next)
                      }} className="w-full border rounded px-2 py-1 text-sm" />
                    </div>
                  </>)}
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">備註</label>
                    <input value={en.note} onChange={e => {
                      const next = [...modalEntries]; next[i].note = e.target.value; setModalEntries(next)
                    }} className="w-full border rounded px-2 py-1 text-sm" placeholder="可選" />
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <label className="text-xs text-muted-foreground">星期（留空 = 只做上面嗰日）</label>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {WEEK_ORDER.map(i => (
                      <button key={i} type="button" onClick={() => {
                        setWeekdays(weekdays.includes(i) ? weekdays.filter(w => w !== i) : [...weekdays, i])
                      }} className={`h-8 min-w-[36px] px-2 text-xs rounded border ${weekdays.includes(i) ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                        {DAY_LABELS[i]}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">重複（週）</label>
                  <select value={modalRepeatWeeks} onChange={e => setModalRepeatWeeks(Number(e.target.value))} className="w-full border rounded px-2 py-1 text-sm">
                    {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 週</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">嗰日已經有當值</label>
                  <select value={modalConflict} onChange={e => setModalConflict(e.target.value as any)} className="w-full border rounded px-2 py-1 text-sm">
                    <option value="skip">保留原本（略過）</option>
                    <option value="overwrite">用今次覆蓋</option>
                  </select>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                ▸ 預覽：將寫入 {(weekdays.length || 1) * modalRepeatWeeks} 條（{weekdays.length || 1} 日 × {modalRepeatWeeks} 週）
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setModalOpen(false)} className="px-3 py-1.5 text-sm border rounded hover:bg-muted">取消</button>
              <button onClick={handleSaveModal} disabled={saving} className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50">
                {saving ? '儲存中...' : '儲存'}
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* ★ Leave Modal */}
      {leaveModalOpen && canSchedule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setLeaveModalOpen(false)}>
          <Card className="w-full max-w-md p-4 m-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold">{editingLeaveId ? '修改醫生休假' : '新增醫生休假'}</h3>
              <button onClick={() => setLeaveModalOpen(false)} aria-label="關閉"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1 block">醫生</label>
                <select value={leaveForm.providerId} disabled={!!editingLeaveId} onChange={e => setLeaveForm({ ...leaveForm, providerId: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm">
                  <option value="">選擇醫生...</option>
                  {(editingLeaveId ? providers : visibleProviders).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">開始日</label>
                  <input type="date" value={leaveForm.startDate} onChange={e => setLeaveForm({ ...leaveForm, startDate: e.target.value })}
                    className="w-full border rounded px-2 py-1 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">結束日</label>
                  <input type="date" value={leaveForm.endDate} onChange={e => setLeaveForm({ ...leaveForm, endDate: e.target.value })}
                    className="w-full border rounded px-2 py-1 text-sm" />
                </div>
              </div>
              <div className="flex gap-1 flex-wrap">
                <button type="button" onClick={() => {
                  const t = todayHK()
                  setLeaveForm({ ...leaveForm, startDate: t, endDate: t })
                }} className="text-xs px-2 py-1 border rounded hover:bg-muted">今日</button>
                <button type="button" onClick={() => {
                  const mon = mondayStr(todayHK())
                  setLeaveForm({ ...leaveForm, startDate: mon, endDate: addDays(mon, 4) })
                }} className="text-xs px-2 py-1 border rounded hover:bg-muted">本週 (一–五)</button>
                <button type="button" onClick={() => {
                  const [y, m] = todayHK().split('-').map(Number)
                  const first = `${y}-${String(m).padStart(2, '0')}-01`
                  const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
                  setLeaveForm({ ...leaveForm, startDate: first, endDate: addDays(nextFirst, -1) })
                }} className="text-xs px-2 py-1 border rounded hover:bg-muted">本月</button>
                <button type="button" onClick={() => {
                  const [y, m] = todayHK().split('-').map(Number)
                  const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
                  const [ny, nm] = nextFirst.split('-').map(Number)
                  const afterFirst = nm === 12 ? `${ny + 1}-01-01` : `${ny}-${String(nm + 1).padStart(2, '0')}-01`
                  setLeaveForm({ ...leaveForm, startDate: nextFirst, endDate: addDays(afterFirst, -1) })
                }} className="text-xs px-2 py-1 border rounded hover:bg-muted">下月</button>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">備註（可選）</label>
                <input value={leaveForm.note} onChange={e => setLeaveForm({ ...leaveForm, note: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm" placeholder="病假 / 外出等" />
              </div>
            </div>
            <div className="mt-4 border-t pt-3">
              <div className="text-xs font-medium text-muted-foreground mb-1">現有休假（前 60 日 ~ 後 180 日）</div>
              {listLeaves.length === 0 ? (
                <div className="text-xs text-muted-foreground/60">冇</div>
              ) : (
                <div className="max-h-40 overflow-y-auto divide-y">
                  {listLeaves.map((lv: any) => (
                    <div key={lv.id} className={`flex items-center gap-2 py-1 text-xs ${editingLeaveId === lv.id ? 'bg-amber-50' : ''}`}>
                      <span className="font-medium w-24 truncate">{lv.provider?.name}</span>
                      <span className="flex-1">{toHKDateStr(lv.startDate)}{toHKDateStr(lv.startDate) !== toHKDateStr(lv.endDate) ? ` ~ ${toHKDateStr(lv.endDate)}` : ''}{lv.note ? `（${lv.note}）` : ''}</span>
                      <button type="button" onClick={() => openLeaveModal(lv)} className="px-2 py-1 border rounded hover:bg-muted">修改</button>
                      <button type="button" onClick={() => handleDeleteLeave(lv.id)} className="px-2 py-1 border rounded text-destructive hover:bg-destructive/10">刪除</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setLeaveModalOpen(false)} className="px-3 py-1.5 text-sm border rounded hover:bg-muted">取消</button>
              <button onClick={handleSaveLeave} disabled={savingLeave}
                className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50">
                {savingLeave ? '儲存中...' : '儲存'}
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* ★ S3：toast（取代 alert；錯誤唔會自己消失） */}
      {toast && (
        <div role="status" className="fixed left-1/2 -translate-x-1/2 z-[70] max-w-[92vw] rounded-lg px-4 py-2 text-sm shadow-lg flex items-start gap-3"
          style={{ bottom: 'calc(84px + env(safe-area-inset-bottom))', background: toast.tone === 'ok' ? '#065f46' : '#991b1b', color: '#fff' }}>
          <span>{toast.tone === 'ok' ? '✓ ' : '⚠️ '}{toast.text}</span>
          <button onClick={() => setToast(null)} aria-label="關閉">✕</button>
        </div>
      )}
    </div>
  )
}
