import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '診所勞動力管理系統',
  description: '防竄改診所人力管理 — 入職、排班、考勤、計糧',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-HK">
      <body style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', margin: 0 }}>{children}</body>
    </html>
  )
}
