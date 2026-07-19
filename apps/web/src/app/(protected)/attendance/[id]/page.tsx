'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { fmtDateTime } from '@/lib/hk-date'
import { BackButton } from '@/components/BackButton'

type FaceStatus = 'PASS' | 'FAIL' | 'NOT_ENROLLED' | 'SKIPPED' | 'NO_FACE' | 'PENDING' | string

function faceBadge(status: FaceStatus | null | undefined) {
  if (!status) return '—'
  const map: Record<string, string> = {
    PASS: '✅ PASS',
    FAIL: '❌ FAIL',
    NOT_ENROLLED: '⚪ 未登記',
    SKIPPED: '⏭️ 略過',
    NO_FACE: '⚠️ 未拍到',
    PENDING: '⏳ 待覆核',
  }
  return map[status] || status
}

function fmt(dt: string | Date | null | undefined) {
  if (!dt) return '—'
  return fmtDateTime(dt)
}

export default function AttendanceDetailPage() {
  const router = useRouter()
  const params = useParams()
  const id = params?.id as string

  const [loading, setLoading] = useState(true)
  const [record, setRecord] = useState<any>(null)
  const [chain, setChain] = useState<any[]>([])
  const [forbidden, setForbidden] = useState(false)

  useEffect(() => {
    if (!id) return

    async function fetchDetail() {
      setLoading(true)
      try {
        const res = await fetch(`/api/punches/${id}`, { credentials: 'include' })
        if (res.status === 403) {
          setForbidden(true)
          return
        }
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

  if (forbidden) {
    return (
      <div style={{ padding: 20 }}>
        <p style={{ color: '#dc2626', fontWeight: 'bold' }}>🚫 無權限查看此詳情頁（僅 OWNER/MANAGER）</p>
        <BackButton to="/attendance" label="返回列表" />
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

      {/* ── Face Verification Section ── */}
      <section style={{
        background: '#fff', borderRadius: 8, border: '1px solid #e0e0e0',
        padding: 20, marginBottom: 20,
      }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>人臉驗證</h3>
        <div style={{ fontSize: 14 }}>
          狀態: {faceBadge(record.faceStatus)}{' '}
          {record.faceScore != null && `（分數 ${record.faceScore.toFixed(3)}）`}
        </div>
        {record.faceReason && (
          <div style={{ fontSize: 13, marginTop: 4 }}>原因: {record.faceReason}</div>
        )}
        {record.faceFramePath && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold' }}>現場照片:</div>
            <img
              src={`/api/face/review/${record.id}`}
              alt="打卡當下"
              style={{ maxWidth: 240, borderRadius: 8, border: '1px solid #eee', marginTop: 4 }}
            />
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              {record.faceReviewedAt ? `已於 ${fmt(record.faceReviewedAt)} 覆核` : '未覆核'}
            </div>
          </div>
        )}
        {!record.faceFramePath && record.faceStatus === 'PASS' && (
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
            通過驗證，依政策不留存照片
          </div>
        )}
      </section>

      {/* ── Location Section ── */}
      <section style={{
        background: '#fff', borderRadius: 8, border: '1px solid #e0e0e0',
        padding: 20, marginBottom: 20,
      }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>打卡位置</h3>
        {record.locationFlag === 'OUT_OF_RANGE' && (
          <div style={{ color: '#dc2626', fontWeight: 'bold', marginBottom: 8 }}>
            ⚠️ 超出範圍（距店 {record.distanceM} 米）
          </div>
        )}
        {record.punchLat != null ? (
          <>
            <div style={{ fontSize: 14 }}>
              座標: {record.punchLat.toFixed(6)}, {record.punchLng.toFixed(6)}
              {record.geoAccuracy != null && ` （精度 ±${record.geoAccuracy}米）`}
            </div>
            <div style={{ fontSize: 14, marginTop: 4 }}>
              距店: {record.distanceM != null ? `${record.distanceM} 米` : '該店未設座標'}
            </div>
            <a
              href={`https://www.google.com/maps?q=${record.punchLat},${record.punchLng}`}
              target="_blank"
              rel="noopener"
              style={{ display: 'inline-block', marginTop: 8, fontSize: 13, color: '#2563eb' }}
            >
              在地圖查看 ↗
            </a>
          </>
        ) : (
          <div style={{ color: '#888', fontSize: 14 }}>
            無座標
            {record.locationFlag === 'DENIED' ? '（員工拒絕定位權限）'
              : record.locationFlag === 'TIMEOUT' ? '（GPS 逾時，室內訊號弱）'
              : '（定位不可用）'}
          </div>
        )}
      </section>

      {/* ── Punch Details Section ── */}
      <section style={{
        background: '#fff', borderRadius: 8, border: '1px solid #e0e0e0',
        padding: 20, marginBottom: 20,
      }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>打卡詳情</h3>
        <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
          <tbody>
            <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '8px 0', color: '#888', width: '120px' }}>員工</td>
              <td>{record.employee?.user?.name || record.employeeId}</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '8px 0', color: '#888' }}>診所</td>
              <td>{record.clinic?.name || record.clinicId}</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '8px 0', color: '#888' }}>打卡類型</td>
              <td>{record.punchType === 'CLOCK_IN' ? '上班' : '下班'}</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '8px 0', color: '#888' }}>時間</td>
              <td>{fmt(record.punchTime)}</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '8px 0', color: '#888' }}>來源</td>
              <td>
                {record.source === 'QR_DYNAMIC' ? '📱 動態QR碼' :
                 record.source === 'QR_STATIC' ? '📱 固定QR碼' :
                 record.source === 'MANUAL_CORRECTION' ? '✏️ 補打卡' :
                 record.source === 'SYSTEM' ? '⚙️ 系統' :
                 record.source}
                {record.tokenValid ? ' · QR有效' : ' · QR無效'}
              </td>
            </tr>
            <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '8px 0', color: '#888' }}>裝置</td>
              <td style={{ fontSize: 11, wordBreak: 'break-all' }}>
                {record.deviceInfo || '—'}
              </td>
            </tr>
            <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '8px 0', color: '#888' }}>記錄建立</td>
              <td>{fmt(record.createdAt)}</td>
            </tr>
            <tr>
              <td style={{ padding: '8px 0', color: '#888' }}>記錄ID</td>
              <td style={{ fontSize: 11 }}>{record.id}</td>
            </tr>
          </tbody>
        </table>
        {record.notes && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: '#f9f9f9', borderRadius: 4, fontSize: 13 }}>
            <span style={{ color: '#888' }}>備註：</span> {record.notes}
          </div>
        )}
      </section>

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
                   `修正 #${index} — ${item.status === 'APPROVED' ? '✅ 已批準' :
                    item.status === 'REJECTED' ? '❌ 已拒絕' : '⏳ 審批中'}`}
                </div>

                {item.type === 'original' ? (
                  <div style={{ fontSize: 13 }}>
                    <div>時間：{fmt(item.punchTime)}</div>
                    <div>類型：{item.punchType === 'CLOCK_IN' ? '上工' : '落班'}</div>
                    <div>來源：{item.source}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 13 }}>
                    <div>修正時間：{fmt(item.correctedTime)}</div>
                    <div>類型：{item.punchType === 'CLOCK_IN' ? '上工' : '落班'}</div>
                    <div>原因：{item.reason || '—'}</div>
                    <div>申請人：{item.requestedBy}</div>
                    <div>審批人：{item.approvedBy || '—'}</div>
                    <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>
                      建立：{fmt(item.createdAt)}
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
