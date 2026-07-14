'use client'

import dynamic from 'next/dynamic'

const QrScannerClient = dynamic(() => import('./qr-scanner-client'), {
  ssr: false,
  loading: () => <p className="text-center text-sm text-gray-500">載入掃描器...</p>,
})

interface QrScannerProps {
  onScan: (token: string) => Promise<boolean>
}

export default function QrScanner({ onScan }: QrScannerProps) {
  return <QrScannerClient onScan={onScan} />
}
