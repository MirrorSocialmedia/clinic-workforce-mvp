'use client'

import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'

interface QrScannerClientProps {
  onScan: (token: string) => Promise<boolean> // ★ 回傳是否成功
}

export default function QrScannerClient({ onScan }: QrScannerClientProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const onScanRef = useRef(onScan)
  const processingRef = useRef(false)
  const [status, setStatus] = useState('開啟鏡頭中...')
  const [manualMode, setManualMode] = useState(false)
  const [manualCode, setManualCode] = useState('')

  // Keep onScan ref always in sync
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    setStatus('開啟鏡頭中...')
    const scanner = new Html5Qrcode('qr-reader')
    scannerRef.current = scanner
    let started = false

    scanner
      .start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            // 掃描框佔畫面 70%（原本固定 250px，小屏比例失衡）
            const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7)
            return { width: size, height: size }
          },
          // ★ 關鍵：要求高解析度 videoConstraints
          videoConstraints: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
        async (decodedText) => {
          // ★ 連發鎖：處理中忽略重複掃描
          if (processingRef.current) return
          processingRef.current = true
          setStatus('打卡中...')

          const ok = await onScanRef.current(decodedText)

          if (ok) {
            // ★ 成功：整個停掉（父層顯示全螢幕結果頁）
            try { await scanner.stop() } catch { /* ignore */ }
          } else {
            // 失敗：3秒後恢復掃描
            try { scanner.pause() } catch { /* ignore */ }
            setTimeout(() => {
              try { scanner.resume() } catch { /* ignore */ }
              processingRef.current = false
              setStatus('請對準診所 QR 碼')
            }, 3000)
          }
        },
        () => {
          /* ignore scan errors */
        }
      )
      .then(() => {
        started = true
        setStatus('請對準診所 QR 碼')
      })
      .catch((err) => {
        setStatus(`鏡頭啟動失敗：${err?.message ?? err}`)
      })

    return () => {
      if (started) {
        try {
          scanner.stop()
        } catch {
          /* ignore */
        }
      }
      try {
        scanner.clear()
      } catch {
        /* ignore */
      }
    }
  }, [])

  const handleManualSubmit = async () => {
    if (manualCode.length >= 4) {
      setManualMode(false)
      setManualCode('')
    }
  }

  return (
    <>
      <div id="qr-reader" className="w-full rounded-lg overflow-hidden" />
      <p className="text-center mt-3 text-sm text-gray-500">{status}</p>

      {/* ── Manual input fallback ── */}
      {manualMode ? (
        <div className="mt-3 flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <input
              maxLength={12}
              placeholder="輸入螢幕上的短碼"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleManualSubmit()
              }}
              className="border border-gray-300 rounded-md px-3 py-2 text-center text-lg tracking-widest font-mono uppercase focus:outline-none focus:ring-2 focus:ring-brand"
              autoFocus
            />
            <button
              onClick={handleManualSubmit}
              disabled={manualCode.length < 4}
              className="bg-brand text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              確認
            </button>
          </div>
          <button
            onClick={() => {
              setManualMode(false)
              setManualCode('')
            }}
            className="text-xs text-gray-400 underline mt-1"
          >
            返回掃描
          </button>
        </div>
      ) : (
        <button
          onClick={() => setManualMode(true)}
          className="text-sm underline mt-2 text-gray-500 hover:text-gray-700"
        >
          掃不到？手動輸入螢幕上的短碼
        </button>
      )}
    </>
  )
}
