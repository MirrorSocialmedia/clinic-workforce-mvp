'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { BackButton } from '@/components/BackButton'

export default function AttendanceDetailPage() {
  const router = useRouter()
  const params = useParams()
  const id = params?.id as string

  const [loading, setLoading] = useState(true)
  const [record, setRecord] = useState<any>(null)
  const [chain, setChain] = useState<any[]>([])

  useEffect(() => {
    if (!id) return

    async function fetchDetail() {
      setLoading(true)
      try {
        const res = await fetch(`/api/punches/${id}`, { credentials: 'include' })
        if (!res.ok) {
          if (res.status === 404) {
            setRecord({ error: 'Record not found' })
          }
          return
        }
        const data = await res.json()
        setRecord(data.record)
        setChain(data.chain || [])
      } finally {
        setLoading(false)
      }
    }

    fetchDetail()
  }, [id])

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center' }}>
        <div>載入中...</div>
      </div>
    )
  }

  if (!record) {
    return (
      <div style={{ padding: 20 }}>
        <p>記錄不存在</p>
        <BackButton to="/attendance" label="返回列表" />
      </div>
    )
  }

  if (record.error) {
    return (
      <div style={{ padding: 20 }}>
        <p>{record.error}</p>
        <BackButton to="/attendance" label="返回列表" />
      </div>
    )
  }

  return (
    <div style={{ padding: 20 }}>
      <BackButton to="/attendance" label="返回考勤" />

      <h1 style={{ marginTop: 16, marginBottom: 24 }}>📋 考勤詳情</h1>

      {/* Original Record */}
      <div style={{
        background: '#fff', borderRadius: 8, border: '1px solid #e0e0e0',
        padding: 20, marginBottom: 20,
      }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>原始記錄</h2>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 14 }}>
          <div>
            <span style={{ color: '#888' }}>員工：</span>
            {record.employee?.user?.name || record.employeeId}
          </div>
          <div>
            <span style={{ color: '#888' }}>診所：</span>
            {record.clinic?.name || record.clinicId}
          </div>
          <div>
            <span style={{ color: '#888' }}>打卡時間：</span>
            {new Date(record.punchTime).toLocaleString('zh-HK')}
          </div>
          <div>
            <span style={{ color: '#888' }}>類型：</span>
            {record.punchType === 'CLOCK_IN' ? '上班打卡' : '下班打卡'}
          </div>
          <div>
            <span style={{ color: '#888' }}>來源：</span>
            {record.source === 'QR_DYNAMIC' ? '📱 動態QR碼' :
             record.source === 'QR_STATIC' ? '📱 固定QR碼' :
             record.source === 'MANUAL_CORRECTION' ? '✏️ 補打卡' :
             '⚙️ 系統'}
          </div>
          <div>
            <span style={{ color: '#888' }}>Token 驗證：</span>
            {record.tokenValid === true ? '✅ 有效' :
             record.tokenValid === false ? '❌ 無效' :
             '— 未驗證'}
          </div>
          <div>
            <span style={{ color: '#888' }}>設備資訊：</span>
            {record.deviceInfo || '—'}
          </div>
          <div>
            <span style={{ color: '#888' }}>建立時間：</span>
            {new Date(record.createdAt).toLocaleString('zh-HK')}
          </div>
        </div>

        {record.notes && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: '#f9f9f9', borderRadius: 4, fontSize: 13 }}>
            <span style={{ color: '#888' }}>備註：</span> {record.notes}
          </div>
        )}
      </div>

      {/* Correction Chain */}
      <div style={{
        background: '#fff', borderRadius: 8, border: '1px solid #e0e0e0',
        padding: 20,
      }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>
          🔗 修改鏈 ({chain.length} 筆)
        </h2>
        <p style={{ fontSize: 12, color: '#888' }}>
          原始記錄永遠不變，所有修正以疊加方式記錄。院長可追溯每一次修改。
        </p>

        <div style={{ marginTop: 16 }}>
          {chain.map((item, index) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                gap: 16,
                marginBottom: 16,
                position: 'relative',
              }}
            >
              {/* Timeline indicator */}
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                position: 'relative',
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12,
                  background: item.type === 'original' ? '#3498db' :
                             item.status === 'APPROVED' ? '#27ae60' :
                             item.status === 'REJECTED' ? '#e74c3c' : '#f39c12',
                  color: '#fff',
                  zIndex: 1,
                }}>
                  {index + 1}
                </div>
                {index < chain.length - 1 && (
                  <div style={{
                    width: 2, height: 40, background: '#e0e0e0',
                    marginTop: -2, marginBottom: -2,
                  }} />
                )}
              </div>

              {/* Content */}
              <div style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 6,
                background: item.type === 'original' ? '#ebf5fb' :
                           item.status === 'APPROVED' ? '#eafaf1' :
                           item.status === 'REJECTED' ? '#fdedec' : '#fef9e7',
                border: `1px solid ${
                  item.type === 'original' ? '#aed6f1' :
                  item.status === 'APPROVED' ? '#a9dfbf' :
                  item.status === 'REJECTED' ? '#f5b7b1' : '#f9e79f'
                }`,
              }}>
                <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 6 }}>
                  {item.type === 'original' ? '📌 原始記錄' :
                   `修正 #${index} — ${item.status === 'APPROVED' ? '✅ 已批准' :
                    item.status === 'REJECTED' ? '❌ 已拒絕' : '⏳ 審批中'}`}
                </div>

                {item.type === 'original' ? (
                  <div style={{ fontSize: 13 }}>
                    <div>時間：{new Date(item.punchTime).toLocaleString('zh-HK')}</div>
                    <div>類型：{item.punchType === 'CLOCK_IN' ? '上班' : '下班'}</div>
                    <div>來源：{item.source}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 13 }}>
                    <div>修正時間：{new Date(item.correctedTime).toLocaleString('zh-HK')}</div>
                    <div>類型：{item.punchType === 'CLOCK_IN' ? '上班' : '下班'}</div>
                    <div>原因：{item.reason || '—'}</div>
                    <div>申請人：{item.requestedBy}</div>
                    <div>審批人：{item.approvedBy || '—'}</div>
                    <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>
                      建立：{new Date(item.createdAt).toLocaleString('zh-HK')}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
