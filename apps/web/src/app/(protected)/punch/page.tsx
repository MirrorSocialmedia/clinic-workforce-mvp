'use client'

import { withTimeout } from '@/lib/with-timeout'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { XCircle, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { notifyDataChanged } from '@/lib/live-refresh'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import QrScanner from './components/qr-scanner'
import { fmtTime, fmtDateTime, todayHK, toHKDateStr } from '@/lib/hk-date'
import { postPunchWithRetry, failureOutcome, isRescueMatch, type ScanOutcome } from '@/lib/punch-retry'
import { useFaceCapture } from '@/lib/use-face-capture'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

/** Live GPS fetch (two-stage: high-accuracy GPS → low-accuracy WiFi/cell fallback) */
async function getPunchLocationLive(): Promise<{ lat?: number; lng?: number; flag?: string; acc?: number }> {
  if (!navigator.geolocation) return { flag: 'NO_GPS' }
  const tryOnce = (highAcc: boolean, timeout: number) => new Promise<any>(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) }),
      err => resolve({ flag: err.code === 1 ? 'DENIED' : err.code === 3 ? 'TIMEOUT' : 'NO_GPS' }),
      { enableHighAccuracy: highAcc, timeout, maximumAge: 60000 },
    )
  })
  // 第一次: 高精度 GPS 6 秒
  let r = await tryOnce(true, 6000)
  if (r.lat != null) return r
  if (r.flag === 'DENIED') return r // 權限拒絕不必重試
  // 第二次: 低精度(WiFi/基站)8 秒——室內拿不到 GPS 時這步能成
  r = await tryOnce(false, 8000)
  return r
}

/** ★ cwm-consist S6 DB-11：effective time 顯示 — 照 attendance 頁 effectiveTime() 口徑。
 *  /api/punch/my-records 已回傳每筆 record 嘅 APPROVED corrections，唔使再多打一轉 API */
function effectiveTimeDisplay(r: any): string {
  const approved = (r.corrections || [])
    .filter((c: any) => c.status === 'APPROVED')
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  if (approved.length === 0) return fmtDateTime(r.punchTime)
  // ★ F-6：補登建嘅卡 punchTime == correctedTime → 唔好顯示「09:00（原 09:00）」
  if (new Date(approved[0].correctedTime).getTime() === new Date(r.punchTime).getTime()) return fmtDateTime(r.punchTime)
  return `${fmtDateTime(approved[0].correctedTime)}（原 ${fmtDateTime(r.punchTime)}）`
}

/** Play a short confirmation beep via Web Audio API */
function playBeep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.value = 0.3
    osc.start()
    osc.stop(ctx.currentTime + 0.18)
  } catch {
    /* 靜音環境忽略 */
  }
}

// ============================================================
// ★ 2026-09-30 C2：網絡失敗證據 —— 記低「第一次掃到但打唔到」嗰個 QR
//   下一次成功打卡時一齊送，伺服器核實嗰個碼真係 iPad 發出、喺咩時間窗口 → 自動開待批補登。
//   存 sessionStorage：頁面 reload 都唔會唔見；私密模式／storage 唔用得 → 冇證據，唔影響打卡。
// ============================================================
const FA_KEY = 'punch.firstAttempt'
const FA_MAX_AGE_MS = 10 * 60_000
type FirstAttempt = { token: string; at: number; type: string | null }

function loadFirstAttempt(type: string | null): FirstAttempt | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(FA_KEY) || 'null')
    if (v && v.type === type && typeof v.token === 'string' && Date.now() - v.at < FA_MAX_AGE_MS) return v
  } catch { /* storage 唔用得 → 當冇證據 */ }
  return null
}
function rememberFirstAttempt(type: string | null, token: string, at: number) {
  if (loadFirstAttempt(type)) return // ★ 保留最早嗰次
  try { sessionStorage.setItem(FA_KEY, JSON.stringify({ token, at, type })) } catch { /* 同上 */ }
}
function clearFirstAttempt() {
  try { sessionStorage.removeItem(FA_KEY) } catch { /* 同上 */ }
}

// ★ 2026-09-30 C5：失敗記錄排隊，下一次成功先上報（失敗嗰陣網絡本身就唔通）
const CE_KEY = 'punch.clientErrors'
function queueClientError(e: Record<string, unknown>) {
  try {
    const arr = JSON.parse(sessionStorage.getItem(CE_KEY) || '[]').slice(-9)
    arr.push({
      ...e,
      at: Date.now(),
      online: navigator.onLine,
      standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
      conn: (navigator as any).connection?.effectiveType ?? null,
    })
    sessionStorage.setItem(CE_KEY, JSON.stringify(arr))
  } catch { /* storage 唔用得 → 唔上報，唔影響打卡 */ }
}
function flushClientErrors() {
  let arr: any[] = []
  try {
    arr = JSON.parse(sessionStorage.getItem(CE_KEY) || '[]')
    sessionStorage.removeItem(CE_KEY)
  } catch { return }
  if (!arr.length) return
  fetch('/api/punch/client-error', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: arr }),
  }).catch(() => { /* 上報失敗唔緊要 */ })
}

export default function PunchPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [lunchEnabled, setLunchEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [records, setRecords] = useState<any[]>([])

  // ★ Full-screen punch result state
  const [punchResult, setPunchResult] = useState<{
    type: string
    time: string
    clinicName?: string
    note?: string   // ★ C2：自動補登提示
  } | null>(null)

  const [recordsLoaded, setRecordsLoaded] = useState(false) // ★ A2.10：未成功載入就唔好彈「未打上班卡」確認

  // ★ Countdown for auto-redirect
  const [countdown, setCountdown] = useState(3)

  // Face verification state
  const [faceHint, setFaceHint] = useState<string | null>(null)
  const [faceDone, setFaceDone] = useState(true) // 驗證是否已了結(扣倒數用;預設true)
  const faceVideoRef = useRef<HTMLVideoElement>(null)
  const { captureQualified, captureRaw, captureLoose, warmup } = useFaceCapture()

  // GPS warmup state
  const lastPosRef = useRef<{ lat: number; lng: number; acc: number; t: number } | null>(null)
  const watchIdRef = useRef<number | null>(null)
  const [gpsReady, setGpsReady] = useState(false)
  const [gpsDenied, setGpsDenied] = useState(false)
  const [gpsFailed, setGpsFailed] = useState(false)

  // ★ Stale hint for warmup failure
  const [staleHint, setStaleHint] = useState(false)

  // Error banner (inline, not full-screen)
  const [error, setError] = useState<string | null>(null)
  const [errorInfo, setErrorInfo] = useState(false)   // ★ true = amber 提示（ALREADY_PUNCHED），非紅色失敗

  // ★ Type-first punch: employee selects type before scanner opens
  const [pendingType, setPendingType] = useState<null | 'CLOCK_IN' | 'CLOCK_OUT' | 'LUNCH_START' | 'LUNCH_END'>(null)
  const TYPE_LABEL: Record<string, string> = { CLOCK_IN: '上班', CLOCK_OUT: '下班', LUNCH_START: '午休開始', LUNCH_END: '午休結束' }

  // ★ Anti-spam: 30s cooldown + in-flight lock
  const punchingRef = useRef(false)
  const lastPunchRef = useRef(0)

  // ★ Scanner restart key
  const [scannerKey, setScannerKey] = useState(0)

  // ★ Scanner stop ref — release rear camera before starting front camera
  const scannerStopRef = useRef<(() => Promise<void> | void) | null>(null)

  // ★ Face enrollment status
  const [faceEnrollStatus, setFaceEnrollStatus] = useState<string | null>(null)
  const faceStatusRef = useRef<string | null>(null)
  useEffect(() => {
    fetch('/api/face/my-status', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setFaceEnrollStatus(d.status); faceStatusRef.current = d.status })
      .catch(() => {})
  }, [])

  const handleScannerReady = useCallback((stop: () => Promise<void> | void) => {
    scannerStopRef.current = stop
  }, [])

  const fetchUserData = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) { router.push('/login'); return }
      const data = await res.json()
      setUser({ role: data.user.role, clinics: data.user.clinicIds || [] })
      setLunchEnabled(!!data.lunchEnabled)
    } catch { router.push('/login') }
  }, [router])

  const fetchRecords = useCallback(async () => {
    try {
      const res = await fetch('/api/punch/my-records', { credentials: 'include', cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setRecords(data.records || [])
        setRecordsLoaded(true)
      }
    } catch { /* 網絡唔通：保留舊 records */ }
  }, [])

  useEffect(() => {
    fetchUserData()
  }, [fetchUserData])

  useEffect(() => {
    if (user) {
      fetchRecords()
      setLoading(false)
    }
  }, [user, fetchRecords])

  // ★ 返到前台（喺路上開咗頁、鎖機、到診所再開）→ 先用 GET 建立新連線，打卡 POST 唔使撞死連線
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') fetchRecords() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', fetchRecords)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', fetchRecords)
    }
  }, [fetchRecords])

  // ★ 背景預熱偵測器(wasm+模型)，打卡時已是熱的
  // ★ warmup 失敗唔好吞：PWA chunk 404 會死喺呢度
  useEffect(() => {
    warmup().catch((e: any) => {
      console.error('[punch] warmup 失敗', { name: e?.name, message: e?.message })
      setStaleHint(true)
    })
  }, [warmup])

  // ★ Mask-check warmup ping — latch early if server is down, zero latency on punch
  useEffect(() => {
    const mc = async () => {
      try {
        // Send a tiny placeholder blob
        const blob = new Blob([new Uint8Array(1)], { type: 'image/jpeg' })
        const fd = new FormData()
        fd.append('frame', blob, 'warmup.jpg')
        await Promise.race([
          fetch('/api/face/mask-check', { method: 'POST', credentials: 'include', body: fd }),
          new Promise<null>(r => setTimeout(() => r(null), 1200)),
        ])
      } catch {
        // Latch will handle this — fail-open
      }
    }
    mc()
  }, [])

  // ★ GPS watchPosition 保溫 — 頁面在就追蹤，離頁立即停
  useEffect(() => {
    if (!navigator.geolocation) return
    watchIdRef.current = navigator.geolocation.watchPosition(
      p => {
        lastPosRef.current = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          acc: Math.round(p.coords.accuracy),
          t: Date.now(),
        }
        setGpsReady(true)
      },
      err => {
        // 保溫失敗靜默——打卡時兩段式兜底會再試
        // 但若 code=1 (DENIED)，設狀態供 UI 顯示橫幅
        if (err.code === 1) setGpsDenied(true)
      },
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 27000 },
    )
    // 3 秒喚醒：保溫遲遲不就緒 → 主動兩段式取一次
    const kick = setTimeout(async () => {
      if (!lastPosRef.current) {
        const r = await getPunchLocationLive()
        if (r.lat != null && r.lng != null) {
          const acc: number = r.acc != null ? Math.round(Number(r.acc)) : 999
          lastPosRef.current = { lat: r.lat, lng: r.lng, acc, t: Date.now() }
          setGpsReady(true)
        } else if (r.flag === 'DENIED') {
          setGpsDenied(true)
        } else {
          setGpsFailed(true)
        }
      }
    }, 3000)
    return () => {
      clearTimeout(kick)
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current)
    }
  }, []) // 只跑一次，頁面在=保溫在

  // ★ Dispatcher: 保溫優先 → 兩段式現取兜底
  async function getPunchLocation(): Promise<{ lat?: number; lng?: number; flag?: string; acc?: number }> {
    // ① 先用保溫的新鮮坐標（30 秒內）——絕大多數打卡走這條，零等待
    const c = lastPosRef.current
    if (c && Date.now() - c.t < 30000) {
      return { lat: c.lat, lng: c.lng, acc: c.acc }
    }
    // ② 保溫沒有/太舊 → 兩段式現取（兜底）
    return await getPunchLocationLive()
  }

  // ★ Fast dispatcher for punch: 保溫優先 → 3 秒逾時兜底，定位失敗不擋打卡
  async function getPunchLocationForPunch(): Promise<{ lat?: number; lng?: number; flag?: string; acc?: number }> {
    // ① 保溫的新鮮坐標（30 秒內）——零等待
    const c = lastPosRef.current
    if (c && Date.now() - c.t < 30000) {
      return { lat: c.lat, lng: c.lng, acc: c.acc }
    }
    // ② 沒保溫 → 給 3 秒機會，拿不到就放行（不擋打卡）
    return await Promise.race([
      getPunchLocationLive(),
      new Promise<any>(resolve => setTimeout(() => resolve({ flag: 'TIMEOUT' }), 3000)),
    ])
  }

  // ★ 網絡斷咗／重試失敗之後確認：「今次」嘅卡其實入咗庫未
  //   /api/punch/my-records 已按 punchTime desc 回傳完整紀錄（id、punchType、punchTime），唔使改 API
  const findRecentPunch = useCallback(async (type: string | null, scanStartedAt: number) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    try {
      const res = await fetch('/api/punch/my-records', { credentials: 'include', cache: 'no-store', signal: ctrl.signal })
      if (!res.ok) return null
      const { records = [] } = await res.json()
      setRecords(records)
      setRecordsLoaded(true)
      return records.find((x: any) => isRescueMatch(x, type, scanStartedAt)) ?? null
    } catch {
      return null
    } finally {
      clearTimeout(t)
    }
  }, [])

  // ★ 打卡成功後嘅所有回饋（正常成功 + 網絡斷咗但查到已入庫，兩條路共用）
  //   ⚠️ 普通 function（唔係 useCallback）：handleScan 會用到佢嘅 closure；入面只准用 ref／setter／穩定 callback，唔好讀 state
  async function onPunchSuccess(rec: { id?: string; punchType: string; punchTime: string }, note?: string) {
    navigator.vibrate?.([80, 40, 80])
    playBeep()

    setPunchResult({
      type: rec.punchType === 'CLOCK_IN' ? '上工' : rec.punchType === 'CLOCK_OUT' ? '落班' : rec.punchType === 'LUNCH_START' ? '午休開始' : '午休結束',
      time: fmtTime(rec.punchTime),
      note,
    })
    setCountdown(3)
    notifyDataChanged('attendance')
    fetchRecords()
    await scannerStopRef.current?.()

    setPendingType(null)
    lastPunchRef.current = Date.now()

    let fs = faceStatusRef.current
    if (!fs) {
      try {
        const r = await fetch('/api/face/my-status', { credentials: 'include' })
        fs = (await r.json()).status
        faceStatusRef.current = fs
      } catch {}
    }
    const willVerify = !!rec.id && fs === 'ACTIVE'
    setFaceDone(!willVerify)
    if (rec.id) {
      if (willVerify) {
        runFaceVerify(rec.id)
      } else {
        const fd = new FormData(); fd.append('punchId', rec.id)
        // ★ cwm-facemissing-20261010：未登記人臉嘅員工 —— 呢個請求冇 await、隨即倒數跳頁；keepalive 確保送得完
        fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd, keepalive: true }).catch(() => {})
      }
    }
  }

  // ★ Punch handler — 回傳 ScanOutcome（ok / rejected / retry），掃描器據此決定停、封鎖碼、定自動再試
  const handleScan = useCallback(async (token: string): Promise<ScanOutcome> => {
    // ★ in-flight：回 retry（原本回 false 會令掃描器封鎖一個其實有效嘅碼）
    if (punchingRef.current) return 'retry'
    if (Date.now() - lastPunchRef.current < 30000) {
      setErrorInfo(true)
      setError('剛打過卡，請稍候')
      return 'rejected'
    }
    punchingRef.current = true
    setErrorInfo(false)
    setError(null)
    const scanStartedAt = Date.now()
    const type = pendingType
    const fa = loadFirstAttempt(type) // ★ C2：之前失敗嗰次嘅證據

    try {
      // ★ GPS location (shadow mode — never blocks punch; 3s max timeout)
      const loc = await getPunchLocationForPunch()

      const r = await postPunchWithRetry({
        token,
        deviceInfo: navigator.userAgent,
        lat: loc.lat,
        lng: loc.lng,
        geoFlag: loc.flag,
        geoAcc: loc.acc,
        punchType: type, // ★ 全員必帶
        ...(fa && fa.token !== token ? { firstToken: fa.token, firstScanAt: fa.at } : {}),
      })

      // ① 兩次都收唔到回應 → 先查頭先有冇入庫
      if (r.kind === 'network') {
        const landed = await findRecentPunch(type, scanStartedAt)
        if (landed) { clearFirstAttempt(); await onPunchSuccess(landed); return 'ok' }
        rememberFirstAttempt(type, token, scanStartedAt)
        queueClientError({ stage: 'network', errName: r.errName, elapsedMs: Date.now() - scanStartedAt, type })
        setErrorInfo(false)
        setError('網絡唔穩定，今次未確認打到卡。請繼續對住 QR（會自動再試，唔使等換碼）')
        return 'retry'
      }

      const { res, data, attempt } = r
      if (!res.ok) {
        // ② 重試過（第一次冇回應）→ 第一次可能其實成功咗。
        //    唔好只睇 ALREADY_PUNCHED：route 先驗 token，碼啱啱過期會回 EXPIRED 蓋過「已打」。
        if (attempt > 1) {
          // BUSY = 第一次仲揸住員工鎖（lock_timeout 3s），等佢 commit 先查
          if (data.code === 'BUSY') await new Promise(x => setTimeout(x, 1500))
          const landed = await findRecentPunch(type, scanStartedAt)
          if (landed) { clearFirstAttempt(); await onPunchSuccess(landed); return 'ok' }
        }
        const outcome = failureOutcome(res.status, data.code)
        if (outcome === 'retry') {
          rememberFirstAttempt(type, token, scanStartedAt)
          queueClientError({ stage: `http_${res.status}`, errName: data.code ?? '', elapsedMs: Date.now() - scanStartedAt, type })
        }
        fetchRecords() // ★ DB-07：失敗都 refetch
        setErrorInfo(data.code === 'ALREADY_PUNCHED')
        setError(
          data.code === 'ALREADY_PUNCHED' ? '今日已打過呢種卡（上次已成功）'
          : data.error ? data.error
          : res.status >= 500 ? '伺服器暫時連唔到，今次未打到卡，請繼續對住 QR'
          : '打卡失敗'
        )
        return outcome
      }

      clearFirstAttempt()
      flushClientErrors()
      await onPunchSuccess(
        { id: data.recordId, punchType: data.punchType, punchTime: data.punchTime },
        data.autoCorrectionAt ? `網絡問題：系統已自動提交補登（${fmtTime(data.autoCorrectionAt)}），等主管批核` : undefined,
      )
      return 'ok'
    } catch (e: any) {
      // 正常唔會嚟到呢度（網絡錯誤已喺 postPunchWithRetry 處理）
      fetchRecords()
      setErrorInfo(false)
      setError(e?.message || '打卡失敗')
      return 'retry' // ★ 未知錯誤唔封鎖碼（盡量唔擋）
    } finally {
      punchingRef.current = false
    }
  }, [fetchRecords, faceEnrollStatus, pendingType, findRecentPunch])

  // Keep ref stable for scanner
  const handleScanRef = useRef(handleScan)
  useEffect(() => { handleScanRef.current = handleScan }, [handleScan])

  // Wrap in a stable function for scanner prop
  const stableOnScan = useCallback(async (token: string): Promise<ScanOutcome> => {
    return handleScanRef.current(token)
  }, [])

  // ★ Lunch punch unified into handleScan with pendingType — no separate handler needed

  // ★ Android 相機釋放延遲 — 重試開鏡 (NotReadableError)
  async function openFrontCamera(tries = 4): Promise<MediaStream> {
    let lastErr: any
    for (let i = 0; i < tries; i++) {
      try {
        // ★ cwm-facemissing-20261010：部分手機（尤其 iOS 加咗落主畫面嘅 App）getUserMedia 會永遠唔返 →
        //   之前冇時限 → 一直卡住、冇送結果、員工關 App → faceStatus 永遠 null（Winkie／Wendy 48/48）
        return await withTimeout(
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } }),
          10000, 'Timeout',
          late => late.getTracks().forEach(t => t.stop()), // 遲到先開到嘅鏡頭即刻關
        )
      } catch (e: any) {
        lastErr = e
        if (e?.name !== 'NotReadableError' && e?.name !== 'AbortError') throw e // 權限拒絕等不重試
        await new Promise(r => setTimeout(r, 350)) // 等釋放,最多 ~1 秒
      }
    }
    throw lastErr
  }

  // ★ runFaceVerify 全身替換: 8秒死線 + 三種了結(sent / no_face / skipped)
  const runFaceVerify = async (punchId: string) => {
    // ★ cwm-facemissing-20261010：總死線 —— 無論邊步卡住，60 秒（正常流程最多 ~35 秒，留位畀慢網上載）都一定送「略過」＋放行倒數，唔會冇結果
    let settled = false
    const watchdog = setTimeout(() => {
      if (settled) return
      settled = true
      const wfd = new FormData()
      wfd.append('punchId', punchId)
      wfd.append('result', 'SKIPPED')
      wfd.append('reason', 'face_watchdog_60s')
      fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: wfd, keepalive: true }).catch(() => {})
      setFaceHint('臉部驗證逾時，已略過')
      setTimeout(() => setFaceHint(null), 1500)
      setFaceDone(true)
    }, 60000)
    let outcome: 'sent' | 'no_face' | 'skipped' = 'skipped'
    let fd_reason: string = ''
    let noFaceEvidence: Blob | null = null
    let stage: 'gum' | 'play' | 'cap' | 'send' = 'gum'
    try {
      if (!faceVideoRef.current) throw Object.assign(new Error('face video not mounted'), { name: 'NotMounted' })
      setFaceHint('請看鏡頭')
      const stream = await openFrontCamera() // stage = 'gum'
      try {
        faceVideoRef.current.srcObject = stream
        stage = 'play'
        await withTimeout(faceVideoRef.current.play(), 6000, 'Timeout') // ★ cwm-facemissing：play() 都會卡死
        stage = 'cap'

        let blob: Blob | null = null
        try {
          blob = await captureQualified(faceVideoRef.current, 15000, setFaceHint)
        } catch (ce: any) {
          // ★ MediaPipe 係 client 前置閘 — 真正驗證喺 server
          const v = faceVideoRef.current
          if (ce?.name !== 'NoFrame' && v && v.videoWidth > 0) {
            console.error('[punch] client 偵測器失敗，改送 raw 幀', { name: ce?.name, message: ce?.message })
            setFaceHint('請看鏡頭')
            await new Promise(r => setTimeout(r, 800))
            try {
              blob = await captureRaw(v)
            } catch {
              throw ce // ★ fallback 自己都死 → 掟返「原本」嘅錯，唔准換名
            }
          } else {
            throw ce
          }
        }

        if (!blob) {
          setFaceHint('請對準鏡頭')
          try { blob = await captureLoose(faceVideoRef.current, 2000) } catch {}
          if (!blob) {
            await new Promise(r => setTimeout(r, 300))
            blob = await captureRaw(faceVideoRef.current) // ★ 最後盲影安全網
          }
        }
        if (blob) {
          stage = 'send' // ★ 上載階段 — 網絡層錯誤唔准再扮 capture 錯
          setFaceHint('分析中…')
          const fd = new FormData()
          fd.append('punchId', punchId)
          fd.append('frame', blob, 'punch.jpg')
          // ★ 2026-08-05：keepalive 有 64KB body 上限，frame 正常 40-120KB
          // → 超標即掟 TypeError（camera_cap_type saga 根因）。
          // redirect 由 faceDone 扣住，page 唔會走 — keepalive 冇必要。
          const r = await fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd })
          if (r.ok) {
            const j = await r.json()
            setFaceHint(j.status === 'PASS' ? '✅ 驗證通過' : null)
          }
          outcome = 'sent'
        } else {
          outcome = 'no_face' // ★ 相機正常、8秒無合格人臉 = 迴避嫌疑
          fd_reason = 'no_face_8s'
        }
        // ★ 關鏡頭前拍證據幀
        if (outcome === 'no_face' && faceVideoRef.current?.readyState) {
          try { noFaceEvidence = await captureRaw(faceVideoRef.current) } catch {}
        }
      } finally {
        stream.getTracks().forEach(t => t.stop())
      }
    } catch (e: any) {
      outcome = 'skipped'
      const name: string = e?.name ?? 'UnknownError'
      const isStandalone = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches
      const suffix = isStandalone ? '_pwa' : '_web'
      const short = name.replace(/Error$/i, '').toLowerCase()

      if (name === 'NotMounted') fd_reason = `camera_notmounted${suffix}`
      else if (name === 'NoFrame') fd_reason = `camera_noframe${suffix}`
      else if (name.startsWith('Init_')) fd_reason = `camera_init_${short.slice(5)}${suffix}`
      else if (name.startsWith('Detect_')) fd_reason = `camera_detect_${short.slice(7)}${suffix}`
      else {
        // ★ 附帶 message 頭 20 字元（淨字母數字）
        const msg = String(e?.message || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20).toLowerCase()
        fd_reason = `camera_${stage}_${short}${suffix}${msg ? `~${msg}` : ''}`
      }

      console.error('[punch] face verify 失敗', { name, message: e?.message, standalone: isStandalone, ua: navigator.userAgent })

      setFaceHint(
        name.startsWith('Init_')
          ? 'App 版本過舊 — 請完全關閉本應用程式（上滑掃走）再重開'
          : name === 'NotReadableError'
          ? '相機被其他應用程式佔用 — 請完全關閉其他 app 再試'
          : name === 'AbortError' || name === 'NoFrame'
          ? '相機啟動失敗 — 請完全關閉本應用程式（上滑掃走）再重開'
          : name === 'NotAllowedError'
          ? '未授權使用相機 — 請喺裝置設定開啟'
          : '相機無法使用，已略過人臉驗證'
      )
    }

    // ★ cwm-facemissing-20261010：守門狗已經報咗「略過」就唔再送（伺服器只收第一個結果）
    clearTimeout(watchdog)
    if (settled) return
    settled = true

    if (outcome === 'sent') {
      setFaceHint(null)
    } else {
      if (outcome === 'no_face') {
        const fd = new FormData()
        fd.append('punchId', punchId)
        if (noFaceEvidence) fd.append('frame', noFaceEvidence, 'noface.jpg')
        fd.append('reason', fd_reason || 'no_face_8s')
        fd.append('result', 'NO_FACE')
        // ★ 2026-08-05：keepalive 有 64KB body 上限（同上）。
        await fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd })
      } else {
        const fd = new FormData()
        fd.append('punchId', punchId)
        fd.append('result', 'SKIPPED')
        if (fd_reason) fd.append('reason', fd_reason)
        // ★ cwm-facemissing-20261010：冇相嘅細 body（遠低於 keepalive 64KB 上限）→ keepalive，關 App／轉頁都送得完
        await fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd, keepalive: true })
      }
      setFaceHint(outcome === 'no_face' ? '未拍攝到人臉' : '臉部驗證略過')
      setTimeout(() => setFaceHint(null), 1500)
    }
    setFaceDone(true) // ★ 任何了結都放行倒數
  }

  // ★ Countdown: auto-redirect to dashboard after success
  // 扣住條件: 有 punchResult AND faceDone(驗證已了結)
  useEffect(() => {
    if (!punchResult || !faceDone) return
    const t = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(t)
          router.push('/dashboard')
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [punchResult, faceDone, router])

  // ★ 2026-09-30 F-04：未打上班卡揀「下班」／未打午休開始揀「午休結束」→ 問一句（只提示，撳確定照打）
  //   records 未成功載入（離線）就唔問 —— 唔可以因為資料唔齊而阻住人
  function pickType(t: 'CLOCK_IN' | 'CLOCK_OUT' | 'LUNCH_START' | 'LUNCH_END') {
    if (recordsLoaded) {
      const today = todayHK()
      const has = new Set(records.filter(r => toHKDateStr(r.punchTime) === today).map(r => r.punchType))
      if (t === 'CLOCK_OUT' && !has.has('CLOCK_IN')
        && !confirm('你今日仲未打「上班」卡。\n\n確定而家要打「下班」？\n（啱啱返工請撳「取消」，再揀「上班打卡」）')) return
      if (t === 'LUNCH_END' && !has.has('LUNCH_START')
        && !confirm('你今日仲未打「午休開始」。\n\n確定而家要打「午休結束」？')) return
    }
    setPendingType(t)
  }

  if (loading) return <div className="flex justify-center items-center min-h-[200px] text-muted-foreground">載入中...</div>
  if (!user) return null

  return (
    <div className="p-4 space-y-4 max-w-lg mx-auto">
      {/* Page Header */}
      <div>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Smartphone size={22} /> 掃碼打卡</h1>
        <p className="text-sm text-muted-foreground mt-1">對準診所螢幕 QR 碼，自動完成打卡</p>
      </div>

      {/* GPS denied banner */}
      {gpsDenied && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
          📍 打卡需要定位權限——請到 設定→Safari→位置→允許，或點網址列 🔒 開啟
        </div>
      )}

      {/* GPS status indicator */}
      <div style={{ textAlign: 'center', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>
        {gpsReady ? '📍 定位就緒' : gpsDenied ? '📍 定位已拒絕' : gpsFailed ? '📍 定位不可用（不影響打卡）' : '📍 定位中…'}
      </div>

      {/* QR Scanner — compact card, hidden when showing full-screen result */}
      {!punchResult && (
        <div className="bg-card border rounded-xl p-3 max-w-sm mx-auto">
          {!pendingType ? (
            // Step 1: 全員先選類型（未選不開鏡頭）
            <div>
              <div className="text-center text-sm font-medium text-muted-foreground mb-3">請選擇打卡類型</div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => pickType('CLOCK_IN')}
                  className="py-4 px-4 rounded-xl font-semibold text-sm transition-all active:scale-95"
                  style={{ background: '#dcfce7', color: '#166534', border: '1px solid #86efac' }}
                >
                  🟢 上班打卡
                </button>
                <button
                  onClick={() => pickType('CLOCK_OUT')}
                  className="py-4 px-4 rounded-xl font-semibold text-sm transition-all active:scale-95"
                  style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' }}
                >
                  🔴 下班打卡
                </button>
                {lunchEnabled && (
                  <button
                    onClick={() => pickType('LUNCH_START')}
                    className="py-4 px-4 rounded-xl font-semibold text-sm transition-all active:scale-95"
                    style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}
                  >
                    ☀️ 午休開始
                  </button>
                )}
                {lunchEnabled && (
                  <button
                    onClick={() => pickType('LUNCH_END')}
                    className="py-4 px-4 rounded-xl font-semibold text-sm transition-all active:scale-95"
                    style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #93c5fd' }}
                  >
                    🌙 午休結束
                  </button>
                )}
              </div>
            </div>
          ) : (
            // Step 2: 選了類型才開鏡頭
            <>
              <div className="text-center mb-3">
                <span className="text-sm font-medium">正在打卡：<b>{TYPE_LABEL[pendingType]}</b></span>
                <button onClick={() => setPendingType(null)} className="ml-2 text-xs text-muted-foreground underline">重選</button>
              </div>
              <QrScanner key={scannerKey} onScan={stableOnScan} onScannerReady={handleScannerReady} />
            </>
          )}
        </div>
      )}

      {/* ★ Error banner — fixed top for immediate visibility */}
      {error && (
        <div
          className={errorInfo
            ? 'bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 flex items-start gap-3 shadow-lg'
            : 'bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 flex items-start gap-3 shadow-lg'}
          style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999 }}
        >
          <XCircle className={`h-5 w-5 ${errorInfo ? 'text-amber-600' : 'text-red-600'} flex-shrink-0 mt-0.5`} />
          <div className="flex-1">
            <div className={`font-semibold ${errorInfo ? 'text-amber-800 dark:text-amber-200' : 'text-red-800 dark:text-red-200'} text-sm`}>{errorInfo ? '提示' : '打卡失敗'}</div>
            <div className={`text-sm mt-0.5 ${errorInfo ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300'}`}>{error}</div>
          </div>
          <button
            onClick={() => setError(null)}
            className={`flex-shrink-0 p-1 rounded ${errorInfo ? 'text-amber-600 hover:text-amber-700 hover:bg-amber-100' : 'text-red-500 hover:text-red-700 hover:bg-red-100'}`}
            aria-label="關閉"
          >
            ✕
          </button>
        </div>
      )}

      {/* Recent records */}
      {!punchResult && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">最近記錄</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {records.length === 0 ? (
              <div className="text-muted-foreground text-center py-6">暫無記錄</div>
            ) : (
              <div className="divide-y divide-border">
                {records.slice(0, 10).map((r) => (
                  <div
                    key={r.id}
                    className="flex justify-between items-center py-3 px-4 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={r.punchType === 'CLOCK_IN' ? 'default' : r.punchType === 'CLOCK_OUT' ? 'secondary' : r.punchType === 'LUNCH_START' ? 'outline' : 'destructive'}
                      >
                        {r.punchType === 'CLOCK_IN' ? '上工' : r.punchType === 'CLOCK_OUT' ? '落班' : r.punchType === 'LUNCH_START' ? '午休開始' : '午休結束'}
                      </Badge>
                      <span className="text-foreground">{r.clinic?.name || '診所'}</span>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {effectiveTimeDisplay(r)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Face enrollment status ── */}
      {!punchResult && (
        <div style={{ marginTop: 24, textAlign: 'center', fontSize: 13, paddingBottom: 16 }}>
          {faceEnrollStatus === 'NOT_ENROLLED' && (
            <Link href="/my/face-enroll" className="underline text-primary">🪪 登記臉部識別</Link>
          )}
          {faceEnrollStatus === 'PENDING' && (
            <span className="text-muted-foreground">🕐 臉部登記審核中，核准後自動生效</span>
          )}
          {faceEnrollStatus === 'ACTIVE' && (
            <span className="text-muted-foreground">
              ✅ 臉部識別已啟用 · <Link href="/my/face-enroll" className="underline">重新登記</Link>
            </span>
          )}
        </div>
      )}

      {/* ── Stale hint warning ── */}
      {staleHint && !punchResult && (
        <div style={{ fontSize: 12, color: '#b45309', textAlign: 'center', marginTop: 4 }}>
          ⚠️ 人臉驗證元件載入失敗（App 版本可能過舊）— 請完全關閉本應用程式（上滑掃走）再重開
        </div>
      )}

      {/* ── Version hint ── */}
      {!punchResult && (
        <div style={{ fontSize: 11, color: '#999', textAlign: 'center', marginTop: 8, paddingBottom: 8 }}>
          v{todayHK()} — 若顯示異常請硬刷新
        </div>
      )}

      {/* ── Face verification window: always-mounted, display toggled ── */}
      <div style={{
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
        width: 'min(78vw, 320px)', zIndex: 60,
        borderRadius: 16, overflow: 'hidden', background: '#000',
        boxShadow: '0 8px 30px rgba(0,0,0,.45)',
        display: faceHint ? 'block' : 'none',
      }}>
        <div style={{ position: 'relative' }}>
          <video ref={faceVideoRef} muted playsInline style={{ width: '100%', transform: 'scaleX(-1)', display: 'block' }} />
          {/* 人形框:橢圓透明窗 + 四周壓暗 */}
          <div style={{
            position: 'absolute', left: '50%', top: '48%', transform: 'translate(-50%, -50%)',
            width: '62%', height: '78%', borderRadius: '50%',
            border: '2.5px dashed rgba(255,255,255,.85)',
            boxShadow: '0 0 0 999px rgba(0,0,0,.45)',
            pointerEvents: 'none',
          }} />
        </div>
        <div style={{ fontSize: 14, textAlign: 'center', color: '#fff', padding: '8px 0' }}>{faceHint}</div>
      </div>

      {/* ── Full-screen success overlay ── */}
      {punchResult && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center"
          style={{ background: '#059669' }}
        >
          <div style={{ fontSize: 96, color: '#fff' }}>✓</div>
          <div className="text-white text-3xl font-bold mt-4">
            {punchResult.type}打卡成功
          </div>
          <div className="text-emerald-100 text-xl mt-2 font-mono">
            {punchResult.time}
          </div>

          {punchResult.note && (
            <div className="text-emerald-50 text-sm mt-4 px-6 text-center">{punchResult.note}</div>
          )}

          <button
            onClick={() => router.push('/dashboard')}
            className="mt-10 px-8 py-3 rounded-xl bg-white/20 text-white text-lg"
          >
            返回首頁（{countdown}）
          </button>
        </div>
      )}
    </div>
  )
}
