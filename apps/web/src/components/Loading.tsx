'use client'

export default function Loading({ text = '載入中...' }: { text?: string }) {
  return (
    <div className="loading-overlay">
      <div style={{ textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto 12px' }} />
        <div style={{ color: '#888', fontSize: 14 }}>{text}</div>
      </div>
    </div>
  )
}
