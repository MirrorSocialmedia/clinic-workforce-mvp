'use client'
import { useState, useRef, useCallback } from 'react'
import { useFaceCapture } from '@/lib/use-face-capture'

export default function FaceEnrollPage() {
  const [step, setStep] = useState<'code' | 'consent' | 'capture' | 'done'>('code')
  const [code, setCode] = useState('')
  const [hint, setHint] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(0)
  const [checkingCode, setCheckingCode] = useState(false)
  const [consentChecked, setConsentChecked] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const { captureQualified } = useFaceCapture()

  const checkCode = async () => {
    setCheckingCode(true)
    setError('')
    try {
      const res = await fetch('/api/face/enroll-code/check', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      })
      if (res.ok) setStep('consent')
      else setError((await res.json()).error || '登記碼無效')
    } catch {
      setError('網絡錯誤，請重試')
    }
    setCheckingCode(false)
  }

  const startCapture = useCallback(async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      const hints = ['請正對鏡頭', '頭微微向左', '頭微微向右', '微微抬頭', '再次正對鏡頭']
      const frames: Blob[] = []
      for (let i = 0; i < hints.length; i++) {
        setHint(hints[i])
        setProgress(i)
        await new Promise(r => setTimeout(r, 900)) // 先給讀提示+擺姿勢的時間
        const b = await captureQualified(videoRef.current!, 6000)
        if (!b) {
          setError('光線不足或未偵測到臉，請調整後重試')
          stream.getTracks().forEach(t => t.stop())
          return
        }
        frames.push(b)
        setHint(`✓ 第 ${i + 1} 張完成`)
        await new Promise(r => setTimeout(r, 500))
      }
      stream.getTracks().forEach(t => t.stop())
      setProgress(5)
      setHint('上傳中...')

      const fd = new FormData()
      fd.append('code', code)
      frames.forEach((b, i) => fd.append('frames', b, `f${i}.jpg`))

      const res = await fetch('/api/face/enroll', { method: 'POST', credentials: 'include', body: fd })
      const data = await res.json()
      if (res.ok) {
        setStep('done')
      } else {
        setError(data.error || '登記失敗')
      }
    } catch (e: any) {
      setError(e.message || '相機錯誤')
    }
  }, [code, captureQualified])

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
          <h2 className="font-bold mb-3">同意書</h2>
          <div className="border rounded-lg p-4 max-h-60 overflow-y-auto text-sm space-y-2 mb-4">
            <p><strong>目的：</strong>本系統收集您的臉部特徵用於打卡驗證，確保打卡紀錄為本人操作。</p>
            <p><strong>收集範圍：</strong>僅收集臉部幾何特徵（512 維向量），不儲存原始照片。</p>
            <p><strong>儲存方式：</strong>臉部特徵向量儲存於伺服器資料庫，僅用於打卡比對。</p>
            <p><strong>資料安全：</strong>臉部特徵資料不會離開本伺服器，不會上傳至第三方或雲端。</p>
            <p><strong>拒絕權利：</strong>您可以拒絕登記臉部識別，不會影響正常工作。拒絕後打卡將標記為「未登記」，不會被拒絕。</p>
            <p><strong>資料刪除：</strong>離職時您的臉部特徵資料將立即刪除。</p>
          </div>
          <label className="flex items-center gap-2 mb-4">
            <input type="checkbox" className="w-4 h-4" checked={consentChecked} onChange={e => setConsentChecked(e.target.checked)} />
            <span className="text-sm">我已閱讀並同意以上條款</span>
          </label>
          <button className="w-full py-3 bg-blue-600 text-white rounded-lg disabled:opacity-50"
            disabled={!consentChecked} onClick={() => setStep('capture')}>
            同意，開始登記
          </button>
        </div>
      )}

      {step === 'capture' && (
        <div className="text-center">
          <div className="relative mb-4">
            <video ref={videoRef} muted playsInline className="w-full rounded-lg" style={{ display: step === 'capture' ? 'block' : 'none' }} />
          </div>
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <div style={{ fontSize: 22, fontWeight: 700, minHeight: 32 }}>{hint}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>進度：{progress} / 5 張</div>
            {error && <div style={{ fontSize: 14, color: '#dc2626', marginTop: 8 }}>{error}</div>}
          </div>
          {!error && hint !== '上傳中...' && (
            <button className="mt-4 py-2 px-6 bg-blue-600 text-white rounded-lg" onClick={startCapture}>
              開始拍攝
            </button>
          )}
        </div>
      )}

      {step === 'done' && (
        <div className="text-center py-8">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-xl font-bold mb-2">登記完成！</h2>
          <p className="text-gray-600 mb-6">請試打卡 2-3 次以完成校準</p>
          <a href="/punch" className="py-3 px-8 bg-blue-600 text-white rounded-lg inline-block">
            前往打卡
          </a>
        </div>
      )}
    </div>
  )
}
