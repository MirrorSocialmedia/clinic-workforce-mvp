'use client'

import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'

interface QrScannerClientProps {
  onScan: (token: string) => Promise<void>
}

export default function QrScannerClient({ onScan }: QrScannerClientProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const onScanRef = useRef(onScan)
  const [status, setStatus] = useState('開啟鏡頭中...')

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
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
          // Pause scanning, call parent, then resume
          try {
            scanner.pause()
          } catch {
            /* ignore */
          }
          setStatus('打卡中...')
          try {
            await onScanRef.current(decodedText)
          } finally {
            // Resume after 1.5s delay
            setTimeout(() => {
              try {
                scanner.resume()
              } catch {
                /* ignore */
              }
              setStatus('請對準診所 QR 碼')
            }, 1500)
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
      .catch(() => {
        setStatus('無法開啟鏡頭，請檢查權限')
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

  return (
    <>
      <div id="qr-reader" className="w-full rounded-lg overflow-hidden" />
      <p className="text-center mt-3 text-sm text-gray-500">{status}</p>
    </>
  )
}
