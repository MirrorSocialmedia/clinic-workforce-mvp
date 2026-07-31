'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useFaceLandmark, type Pose } from '@/lib/use-face-landmark'

const steps: { hint: string; pose: Pose }[] = [
 { hint: '請正對鏡頭', pose: 'frontal' },
 { hint: '頭轉向左邊', pose: 'left' },
 { hint: '頭轉向右邊', pose: 'right' },
 { hint: '微微抬頭', pose: 'any' },
 { hint: '再次正對鏡頭', pose: 'frontal' },
]

export default function FaceEnrollPage() {
 const router = useRouter()
 const [step, setStep] = useState<'code' | 'consent' | 'capture' | 'done'>('code')
 const [code, setCode] = useState('')
 const [checkingCode, setCheckingCode] = useState(false)
 const [consentChecked, setConsentChecked] = useState(false)
 const [idx, setIdx] = useState(0)
 const [error, setError] = useState('')
 const [uploading, setUploading] = useState(false)
 const [shooting, setShooting] = useState(false)
 const [flash, setFlash] = useState(false)
 const framesRef = useRef<Blob[]>([])
 const streamRef = useRef<MediaStream | null>(null)
 const videoRef = useRef<HTMLVideoElement>(null)
 const shootingRef = useRef(false) // 同步鎖 —— state 非同步，連按時擋不住
 const { shoot } = useFaceLandmark()

 const checkCode = async () => {
  setCheckingCode(true); setError('')
  try {
   const res = await fetch('/api/face/enroll-code/check', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
   })
   if (res.ok) setStep('consent')
   else setError((await res.json()).error || '登記碼無效')
  } catch { setError('網絡錯誤，請重試') }
  setCheckingCode(false)
 }

 const stopCamera = () => {
  streamRef.current?.getTracks().forEach(t => t.stop())
  streamRef.current = null
 }

 // ★ 等 step 真正切到 capture（DOM 已 mount）才開相機
 useEffect(() => {
  if (step !== 'capture') return
  let cancelled = false
  ;(async () => {
   try {
    const stream = await navigator.mediaDevices.getUserMedia({
     video: { facingMode: 'user', width: { ideal: 720 } },
    })
    if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
    streamRef.current = stream
    if (videoRef.current) {
     videoRef.current.srcObject = stream
     await videoRef.current.play()
    }
   } catch (e: any) {
    setError(e?.name === 'NotAllowedError' ? '請允許使用相機權限' : (e?.message || '相機錯誤'))
   }
  })()
  return () => { cancelled = true; stopCamera(); shootingRef.current = false }
 }, [step])

 const takeShot = async () => {
  // 用 ref 做鎖唔用 state —— state 更新係非同步
  if (shootingRef.current || uploading) return
  shootingRef.current = true
  setShooting(true)
  setError('')

  try {
   if (!videoRef.current?.readyState) {
    setError('相機未就緒，請稍候再試')
    return
   }
   // 鎖住當下 idx
   const currentIdx = idx
   const r = await shoot(videoRef.current, steps[currentIdx].pose)
   if (!r.blob) {
    setError(r.error || '拍攝失敗，請按提示調整姿勢')
    return
   }
   framesRef.current.push(r.blob)
   setFlash(true); setTimeout(() => setFlash(false), 150)
   if (currentIdx + 1 < steps.length) {
    setIdx(currentIdx + 1)
   } else {
    await submitFrames(framesRef.current)
   }
  } finally {
   shootingRef.current = false
   setShooting(false)
  }
 }

 // 錯誤 3.5s 自動消失
 useEffect(() => {
  if (!error) return
  const t = setTimeout(() => setError(''), 3500)
  return () => clearTimeout(t)
 }, [error])

 const submitFrames = async (frames: Blob[]) => {
  setUploading(true); setError('')
  try {
   const fd = new FormData()
   fd.append('code', code)
   frames.forEach((b, i) => fd.append('frames', b, `f${i}.jpg`))
   const res = await fetch('/api/face/enroll', { method: 'POST', credentials: 'include', body: fd })
   if (res.ok) {
    streamRef.current?.getTracks().forEach(t => t.stop())
    setStep('done')
    setUploading(false)
    setTimeout(() => router.push('/my/dashboard'), 2000)
   } else {
    const data = await res.json().catch(() => ({}))
    // ★ 500 / HTML 錯誤頁會 parse 唔到，要有可行動嘅 fallback
    setError(
      data.error ||
      (res.status >= 500
        ? `伺服器處理失敗（${res.status}），請稍後再試；持續失敗請通知管理員`
        : `登記失敗（${res.status}）`)
    )
    setUploading(false)
   }
  } catch {
   setError('上傳失敗，請檢查網絡後重試')
   setUploading(false)
  }
 }

 return (
  <div className="max-w-md mx-auto p-4">
   {step !== 'capture' && <h1 className="text-xl font-bold mb-6">臉部登記</h1>}

   {step === 'code' && (
    <div>
     <label className="block text-sm mb-2">輸入登記碼（6 位數）</label>
     <input
      type="text" maxLength={6} className="w-full px-3 py-2 border rounded-lg text-center text-2xl tracking-widest font-mono"
      value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
      placeholder="000000"
     />
     <button className="w-full mt-4 py-3 bg-blue-600 text-white rounded-lg disabled:opacity-50"
      disabled={code.length !== 6 || checkingCode} onClick={checkCode}>
      {checkingCode ? '驗證中...' : '下一步'}
     </button>
    </div>
   )}

   {step === 'consent' && (
    <div>
     <h2 className="font-bold mb-3">同意書 v3</h2>
     <div className="border rounded-lg p-4 max-h-60 overflow-y-auto text-sm space-y-2 mb-4">
      <p><strong>目的：</strong>本系統收集您的臉部特徵用於打卡驗證，確保打卡紀錄為本人操作。</p>
      <p><strong>收集範圍：</strong>臉部幾何特徵（512 維向量），以及登記時一張正面照片。</p>
      <p><strong>儲存方式：</strong>臉部特徵向量及登記照片儲存於本診所伺服器，僅用於打卡比對及身份核實。</p>
      <p><strong>資料安全：</strong>所有臉部資料不會離開本伺服器，不會上傳至第三方或雲端。</p>
      <p><strong>登記照片保留：</strong>登記時的正面照片會<strong>長期保留</strong>，作為日後核實「該次登記由本人提交並經管理員核准」的憑證。只有系統管理員可查閱。</p>
      <p><strong>拒絕權利：</strong>您可以拒絕登記臉部識別，不會影響正常工作。拒絕後打卡將標記為「未登記」，不會被拒絕。</p>
      <p><strong>資料刪除：</strong>離職時您的臉部特徵資料及登記照片將立即刪除。您亦可隨時要求刪除，惟刪除後需重新登記方可使用臉部打卡。</p>
     </div>
     <label className="flex items-center gap-2 mb-4">
      <input type="checkbox" className="w-4 h-4" checked={consentChecked} onChange={e => setConsentChecked(e.target.checked)} />
      <span className="text-sm">我已閱讀並同意以上條款</span>
     </label>
     <button className="w-full py-3 bg-blue-600 text-white rounded-lg disabled:opacity-50"
      disabled={!consentChecked} onClick={() => setStep('capture')}>
      同意，開始登記
     </button>
     <button className="w-full mt-3 py-2 text-sm text-gray-500 rounded-lg"
      onClick={() => {
       stopCamera()
       setError('')
       setIdx(0)
       framesRef.current = []
       setUploading(false)
       shootingRef.current = false
       setShooting(false)
       setStep('code')
       setConsentChecked(false)
      }}>
      ← 返回
     </button>
    </div>
   )}

   {/* ★ video 不可以條件 render —— ref 會為 null。永遠 mount，靠 display 控制。 */}
   <div
    style={{
     display: step === 'capture' ? 'flex' : 'none',
     flexDirection: 'column',
     height: '100dvh',
     position: 'fixed', inset: 0, background: '#000', zIndex: 50,
    }}
   >
    {/* ── 提示：最頂，永遠見到，唔使碌 ── */}
    <div style={{ padding: '14px 16px 10px', textAlign: 'center', flexShrink: 0, color: '#fff' }}>
     <div style={{ fontSize: 22, fontWeight: 700, minHeight: 30 }}>{steps[idx].hint}</div>
     <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 8 }}>
      {steps.map((_, i) => (
       <span key={i} style={{
        width: 8, height: 8, borderRadius: '50%',
        background: i < idx ? '#22c55e' : i === idx ? '#fff' : 'rgba(255,255,255,.3)',
       }} />
      ))}
     </div>
    </div>

    {/* ── 相機：佔剩餘空間，overflow hidden 令陰影唔會蓋出去 ── */}
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
     <video
      ref={videoRef} muted playsInline
      style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
     />
     <div style={{
      position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
      width: '68%', height: '62%', borderRadius: '50%',
      border: '2.5px dashed rgba(255,255,255,.85)',
      boxShadow: '0 0 0 999px rgba(0,0,0,.45)',
      pointerEvents: 'none',
     }} />

     {/* 閃白效果 */}
     {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: .7, pointerEvents: 'none' }} />}

     {/* ★ 錯誤訊息浮喺相機上面 —— 唔使碌，撳完即刻見到 */}
     {error && (
      <div style={{
       position: 'absolute', left: 12, right: 12, bottom: 12, zIndex: 10,
       background: 'rgba(220,38,38,.95)', color: '#fff',
       padding: '10px 14px', borderRadius: 10, fontSize: 15,
       textAlign: 'center', fontWeight: 500,
      }}>
       {error}
      </div>
     )}
    </div>

    {/* ── 按鈕：貼底，永遠喺視窗內 ── */}
    <div style={{ padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', flexShrink: 0, background: '#000' }}>
     <button
      onClick={takeShot}
      disabled={shooting || uploading}
      style={{
       width: '100%', padding: '15px 0', fontSize: 18, fontWeight: 600,
       borderRadius: 12, border: 'none', color: '#fff',
       background: (shooting || uploading) ? '#4b5563' : '#2563eb',
      }}
     >
      {uploading ? '上傳中…' : shooting ? '處理中…' : '📸 拍攝'}
     </button>
     <button
      onClick={() => {
       stopCamera()
       setError('')
       setIdx(0)
       framesRef.current = []
       setUploading(false)
       shootingRef.current = false
       setShooting(false)
       setStep('code')
      }}
      style={{
       width: '100%', marginTop: 8, padding: '10px 0', fontSize: 14,
       background: 'transparent', border: 'none', color: 'rgba(255,255,255,.6)',
      }}
     >
      取消
     </button>
    </div>
   </div>

   {step === 'done' && (
    <div className="text-center py-8">
     <div className="text-5xl mb-4">✅</div>
     <h2 className="text-xl font-bold mb-2">已提交</h2>
     <p className="text-gray-600 mb-2">您的臉部資料已提交，待管理員核准後生效。</p>
     <p className="text-gray-500 text-sm mb-6">核准前打卡正常，會標記為「待核准」。</p>
     <a href="/punch" className="py-3 px-8 bg-blue-600 text-white rounded-lg inline-block">
      前往打卡
     </a>
    </div>
   )}

   {uploading && (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
     <div style={{ background: '#fff', borderRadius: 12, padding: '20px 28px', fontSize: 15, fontWeight: 600 }}>
      ⏳ 正在上傳中…
     </div>
    </div>
   )}
  </div>
 )
}
