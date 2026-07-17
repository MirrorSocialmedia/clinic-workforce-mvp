'use client'
import { useState, useRef, useCallback } from 'react'
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
 const [submitting, setSubmitting] = useState(false)
 const [uploading, setUploading] = useState(false)
 const framesRef = useRef<Blob[]>([])
 const streamRef = useRef<MediaStream | null>(null)
 const videoRef = useRef<HTMLVideoElement>(null)
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

 const startCamera = async () => {
  try {
   const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
   streamRef.current = stream
   if (videoRef.current) {
    videoRef.current.srcObject = stream
    await videoRef.current.play()
   }
  } catch (e: any) { setError(e.message || '相機錯誤') }
 }

 const takeShot = async () => {
  setError('')
  if (!videoRef.current?.readyState) return
  const r = await shoot(videoRef.current, steps[idx].pose)
  if (!r.blob) { setError(r.error!); return }
  framesRef.current.push(r.blob)
  if (idx + 1 < steps.length) setIdx(i => i + 1)
  else await submitFrames(framesRef.current)
 }

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
    setError(data.error || '登記失敗')
    setUploading(false)
   }
  } catch {
   setError('上傳失敗，請重試')
   setUploading(false)
  }
 }

 return (
  <div className="max-w-md mx-auto p-4">
   <h1 className="text-xl font-bold mb-6">臉部登記</h1>

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
     <h2 className="font-bold mb-3">同意書 v2</h2>
     <div className="border rounded-lg p-4 max-h-60 overflow-y-auto text-sm space-y-2 mb-4">
      <p><strong>目的：</strong>本系統收集您的臉部特徵用於打卡驗證，確保打卡紀錄為本人操作。</p>
      <p><strong>收集範圍：</strong>僅收集臉部幾何特徵（512 維向量），不儲存原始照片。</p>
      <p><strong>儲存方式：</strong>臉部特徵向量儲存於伺服器資料庫，僅用於打卡比對。</p>
      <p><strong>資料安全：</strong>臉部特徵資料不會離開本伺服器，不會上傳至第三方或雲端。</p>
      <p><strong>身份核實：</strong>登記時將保留一張正面照片供管理員核實身份，核准或拒絕後即時刪除。</p>
      <p><strong>拒絕權利：</strong>您可以拒絕登記臉部識別，不會影響正常工作。拒絕後打卡將標記為「未登記」，不會被拒絕。</p>
      <p><strong>資料刪除：</strong>離職時您的臉部特徵資料將立即刪除。</p>
     </div>
     <label className="flex items-center gap-2 mb-4">
      <input type="checkbox" className="w-4 h-4" checked={consentChecked} onChange={e => setConsentChecked(e.target.checked)} />
      <span className="text-sm">我已閱讀並同意以上條款</span>
     </label>
     <button className="w-full py-3 bg-blue-600 text-white rounded-lg disabled:opacity-50"
      disabled={!consentChecked} onClick={() => { setStep('capture'); startCamera() }}>
      同意，開始登記
     </button>
    </div>
   )}

   {step === 'capture' && (
    <div className="text-center">
     <div className="relative mb-4">
      <video ref={videoRef} muted playsInline className="w-full rounded-lg" style={{ width: '100%', transform: 'scaleX(-1)' }} />
     </div>
     <div style={{ textAlign: 'center', marginTop: 12 }}>
      <div style={{ fontSize: 22, fontWeight: 700, minHeight: 32 }}>{steps[idx].hint}</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>第 {idx + 1} / 5 張</div>
      <button
       className="mt-4 py-3 px-10 bg-blue-600 text-white rounded-lg text-lg disabled:opacity-50"
       onClick={takeShot} disabled={submitting}>
       📸 拍攝
      </button>
      {error && <div style={{ fontSize: 15, color: '#dc2626', marginTop: 12, fontWeight: 500 }}>{error}</div>}
     </div>
    </div>
   )}

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
