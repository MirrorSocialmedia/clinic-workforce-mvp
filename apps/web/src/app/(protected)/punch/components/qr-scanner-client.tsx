'use client'

import { useEffect, useRef, useState } from 'react'
import QrScanner from 'qr-scanner'

interface QrScannerClientProps {
  onScan: (token: string) => Promise<boolean> // 回傳是否成功（成功即停）
  onScannerReady?: (stop: () => void) => void
}

export default function QrScannerClient({ onScan, onScannerReady }: QrScannerClientProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const processingRef = useRef(false)
  const onScanRef = useRef(onScan)
  const [status, setStatus] = useState('開啟鏡頭中...')
  const [manualMode, setManualMode] = useState(false)
  const [manualCode, setManualCode] = useState('')

  useEffect(() => { onScanRef.current = onScan }, [onScan])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const scanner = new QrScanner(
      video,
      async (result) => {
        if (processingRef.current) return
        processingRef.current = true
        setStatus('打卡中...')
        const ok = await onScanRef.current(result.data)
        if (ok) {
          try { scanner.stop(); scanner.destroy() } catch { /* ignore */ }
          scannerRef.current = null
        } else {
          setTimeout(() => {
            processingRef.current = false
            setStatus('請對準診所 QR 碼')
          }, 3000)
        }
      },
      {
        preferredCamera: 'environment',
        maxScansPerSecond: 10,
        highlightScanRegion: true, // 自帶掃描框高亮
        returnDetailedScanResult: true,
      }
    )
    scannerRef.current = scanner
    // 暴露 stop 方法
    if (onScannerReady) {
      onScannerReady(() => {
        try { scanner.stop() } catch {}
      })
    }
    scanner.start()
      .then(() => setStatus('請對準診所 QR 碼'))
      .catch((e: any) => setStatus(`鏡頭啟動失敗：${e?.message ?? e}`))

    return () => {
      try { scanner.stop(); scanner.destroy() } catch { /* ignore */ }
    }
  }, [])

  const submitManual = async () => {
    if (manualCode.length < 6 || processingRef.current) return
    processingRef.current = true
    setStatus('打卡中...')
    const ok = await onScanRef.current(manualCode.trim().toUpperCase())
    if (!ok) setTimeout(() => { processingRef.current = false }, 1500)
  }

  return (
    <div className="bg-card border rounded-xl p-3 mx-auto" style={{ maxWidth: 260 }}>
      {manualMode ? (
        <div className="space-y-2">
          <input
            value={manualCode}
            maxLength={8}
            placeholder="輸入螢幕上的短碼"
            onChange={e => setManualCode(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-center font-mono tracking-widest uppercase"
          />
          <button
            onClick={submitManual}
            className="w-full py-2 rounded-lg bg-primary text-primary-foreground"
          >
            打卡
          </button>
          <button
            onClick={() => setManualMode(false)}
            className="w-full text-sm underline text-muted-foreground"
          >
            改用掃描
          </button>
        </div>
      ) : (
        <>
          {/* ★ playsInline muted 是 iOS 內嵌播放的必要屬性（缺了黑屏） */}
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ width: '100%', borderRadius: 8, background: '#000' }}
          />
          <div className="text-center text-sm text-muted-foreground mt-2">{status}</div>
          <button
            onClick={() => setManualMode(true)}
            className="w-full text-sm underline text-muted-foreground mt-2"
          >
            掃不到？手動輸入短碼
          </button>
        </>
      )}
    </div>
  )
}
