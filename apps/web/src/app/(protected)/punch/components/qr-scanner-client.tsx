'use client'

import { useEffect, useRef, useState } from 'react'
import QrScanner from 'qr-scanner'
import type { ScanOutcome } from '@/lib/punch-retry'

interface QrScannerClientProps {
  onScan: (token: string) => Promise<ScanOutcome> // ok = 停；rejected = 封鎖呢個碼；retry = 唔封鎖，自動再試（有上限）
  onScannerReady?: (stop: () => Promise<void> | void) => void
}

// ★ 2026-09-30 F-02：網絡／伺服器暫時問題，同一個碼最多自動再試 2 輪（每輪相隔 2 秒）。
//   斷網時請求永遠去唔到伺服器 → 永遠收唔到 EXPIRED；唔加上限會每 2 秒無限重試（已模擬證實）。
//   到上限後只封鎖「呢個碼」—— iPad 換新碼會自動再試（每碼 2 輪 ≈ 每 12 秒最多 2 次），或者員工撳「再試一次」。
const MAX_AUTO_RETRY_PER_CODE = 2
const RETRY_DELAY_MS = 2000

export default function QrScannerClient({ onScan, onScannerReady }: QrScannerClientProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const processingRef = useRef(false)
  // ★ cwm-antitamper：被伺服器拒絕嘅碼唔重複送（鏡頭會連續掃到同一個碼）
  const lastFailedRef = useRef<string | null>(null)
  const retryCountRef = useRef(new Map<string, number>())
  const onScanRef = useRef(onScan)
  const skipFirstManualEffect = useRef(true)
  const [status, setStatus] = useState('開啟鏡頭中...')
  const [manualMode, setManualMode] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [showRetryBtn, setShowRetryBtn] = useState(false)

  useEffect(() => { onScanRef.current = onScan }, [onScan])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const scanner = new QrScanner(
      video,
      async (result) => {
        if (processingRef.current) return
        if (result.data === lastFailedRef.current) return
        processingRef.current = true
        setShowRetryBtn(false)
        setStatus('打卡中...')
        const outcome = await onScanRef.current(result.data)

        if (outcome === 'ok') {
          try { scanner.stop(); scanner.destroy() } catch { /* ignore */ }
          scannerRef.current = null
          return
        }

        if (outcome === 'retry') {
          const n = (retryCountRef.current.get(result.data) ?? 0) + 1
          retryCountRef.current.set(result.data, n)
          if (n >= MAX_AUTO_RETRY_PER_CODE) {
            lastFailedRef.current = result.data
            setShowRetryBtn(true)
            setStatus('網絡唔穩定 — iPad 換碼後會自動再試，或撳「再試一次」')
          } else {
            setStatus('未確認打到卡 — 2 秒後自動再試')
          }
          setTimeout(() => { processingRef.current = false }, RETRY_DELAY_MS)
          return
        }

        // rejected：伺服器拒絕（過期、無效、已打…）→ 封鎖呢個碼
        lastFailedRef.current = result.data
        setTimeout(() => {
          processingRef.current = false
          setStatus('未打到卡 — 請等 iPad 換新 QR 再掃')
        }, 3000)
      },
      {
        preferredCamera: 'environment',
        maxScansPerSecond: 10,
        highlightScanRegion: true,
        returnDetailedScanResult: true,
      }
    )
    scannerRef.current = scanner
    if (onScannerReady) {
      onScannerReady(async () => {
        try { await scanner.pause(true) } catch { /* ignore */ }
        try { scanner.stop() } catch { /* ignore */ }
      })
    }
    scanner.start()
      .then(() => setStatus('請對準診所 QR 碼'))
      .catch((e: any) => setStatus(`鏡頭啟動失敗：${e?.message ?? e}`))

    return () => {
      try { scanner.stop(); scanner.destroy() } catch { /* ignore */ }
    }
  }, [])

  // ★ 2026-09-30 F-03：手動模式只停鏡頭，返嚟再開（scanner 綁死第一個 <video>，唔可以拆咗再起）
  useEffect(() => {
    if (skipFirstManualEffect.current) { skipFirstManualEffect.current = false; return }
    const s = scannerRef.current
    if (!s) return
    if (manualMode) { s.stop(); return }
    s.start()
      .then(() => setStatus('請對準診所 QR 碼'))
      .catch((e: any) => setStatus(`鏡頭啟動失敗：${e?.message ?? e}`))
  }, [manualMode])

  const retryNow = () => {
    lastFailedRef.current = null
    retryCountRef.current.clear()
    setShowRetryBtn(false)
    setStatus('請對準診所 QR 碼')
    processingRef.current = false
  }

  const submitManual = async () => {
    if (manualCode.trim().length < 6 || processingRef.current) return
    processingRef.current = true
    setStatus('打卡中...')
    const outcome = await onScanRef.current(manualCode.trim().toUpperCase())
    if (outcome !== 'ok') setTimeout(() => { processingRef.current = false }, outcome === 'retry' ? 1000 : 1500)
  }

  return (
    <div className="bg-card border rounded-xl p-3 mx-auto" style={{ maxWidth: 260 }}>
      {/* ★ F-03：video 永遠 mount，只係收起。★ playsInline muted 係 iOS 內嵌播放必要屬性（缺咗黑屏） */}
      <div style={{ display: manualMode ? 'none' : 'block' }}>
        <video
          ref={videoRef}
          playsInline
          muted
          style={{ width: '100%', borderRadius: 8, background: '#000' }}
        />
      </div>

      {manualMode ? (
        <div className="space-y-2">
          <input
            value={manualCode}
            maxLength={8}
            placeholder="輸入螢幕上的短碼"
            onChange={e => setManualCode(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-center font-mono tracking-widest uppercase"
          />
          <button onClick={submitManual} className="w-full py-2 rounded-lg bg-primary text-primary-foreground">
            打卡
          </button>
          <div className="text-center text-xs text-muted-foreground">{status}</div>
          <button onClick={() => setManualMode(false)} className="w-full text-sm underline text-muted-foreground">
            改用掃描
          </button>
        </div>
      ) : (
        <>
          <div className="text-center text-sm text-muted-foreground mt-2">{status}</div>
          {showRetryBtn && (
            <button onClick={retryNow} className="w-full py-2 rounded-lg bg-primary text-primary-foreground mt-2">
              再試一次
            </button>
          )}
          <button onClick={() => setManualMode(true)} className="w-full text-sm underline text-muted-foreground mt-2">
            掃不到？手動輸入短碼
          </button>
        </>
      )}
    </div>
  )
}
