'use client'

import dynamic from 'next/dynamic'
import type { ScanOutcome } from '@/lib/punch-retry'

const QrScannerClient = dynamic(() => import('./qr-scanner-client'), {
  ssr: false,
  loading: () => <p className="text-center text-sm text-gray-500">載入掃描器...</p>,
})

interface QrScannerProps {
  onScan: (token: string) => Promise<ScanOutcome>
  onScannerReady?: (stop: () => Promise<void> | void) => void
}

export default function QrScanner({ onScan, onScannerReady }: QrScannerProps) {
  return <QrScannerClient onScan={onScan} onScannerReady={onScannerReady} />
}
