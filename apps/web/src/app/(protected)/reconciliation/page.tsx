'use client'

/**
 * MD-E: Reconciliation — 月報對數
 * 月報 xlsx → Apricot 官方嘅數（裁判） vs 你系統嘅數（主資料）
 */
import { useEffect, useState, useCallback } from 'react'
import React from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Upload, FileSpreadsheet, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { RequireRole } from '@/components/RequireRole'

interface ReconciliationRecord {
  id: string
  providerId: string
  providerName: string
  providerShortName: string | null
  periodMonth: string
  fileName: string
  rowCount: number
  reportTotal: number
  reportCharges: number | null
  systemTotal: number
  difference: number
  chargesVsPaid: number | null
  status: string
  uploadedAt: string
  detailJson: any
}

interface Provider {
  id: string
  name: string
  shortName: string | null
}

/** H1b: Parse preview result */
interface ParsePreview {
  meta: { practitioner: string; clinic: string; month: string }
  rowCount: number
  // ★ MD-AC1: 日期解析唔到嘅跳過行數
  skipped: number
}

export default function ReconciliationPage() {
  // ★ 2026-08-22：頁面層權限 gate（navItems:179 roles:['OWNER'] + provider_payout）
  //   denied 時 Inner 唔 mount → 零 API request
  return (
    <RequireRole roles={['OWNER']} perms={['provider_payout']}>
      <ReconciliationPageInner />
    </RequireRole>
  )
}

function ReconciliationPageInner() {
  const [records, setRecords] = useState<ReconciliationRecord[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonth())
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  // H1b: Parse preview state
  const [parsePreview, setParsePreview] = useState<ParsePreview | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [previewFile, setPreviewFile] = useState<File | null>(null)

  useEffect(() => {
    loadProviders()
    loadRecords()
  }, [selectedMonth])

  async function loadProviders() {
    try {
      const res = await apiFetch<{ providers: Provider[] }>('/api/providers')
      setProviders(res.providers)
    } catch {
      // fallback — continue without provider filter
    }
  }

  async function loadRecords() {
    setLoading(true)
    try {
      const res = await apiFetch<{ imports: ReconciliationRecord[] }>(
        `/api/reconciliation?month=${encodeURIComponent(selectedMonth)}`,
      )
      setRecords(res.imports)
    } catch (e: any) {
      console.error('[reconciliation] loadRecords failed', e)
    } finally {
      setLoading(false)
    }
  }

  // H1b: Parse preview step
  const handleFileSelect = useCallback(async (file: File) => {
    setUploading(true)
    setUploadError(null)
    setParsePreview(null)
    setPreviewFile(file)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res: ParsePreview = await apiFetch('/api/reconciliation/parse', {
        method: 'POST',
        body: formData,
      })
      setParsePreview(res)

      // Auto-select provider by matching shortName from "(CODE)" in practitioner name
      const code = res.meta.practitioner.match(/\(([^)]+)\)\s*$/)?.[1]?.trim()
      if (code) {
        const matched = providers.find((p) => p.shortName === code)
        if (matched) {
          setSelectedProviderId(matched.id)
          return
        }
      }
      // No auto-match found — user must select manually
      setSelectedProviderId('')
    } catch (e: any) {
      const msg = e.message || '解析失敗'
      setUploadError(msg)
      setParsePreview(null)
      setPreviewFile(null)
    } finally {
      setUploading(false)
    }
  }, [providers])

  // H1b: Submit upload with providerId
  const handleUpload = useCallback(async () => {
    if (!previewFile || !selectedProviderId) return
    setUploading(true)
    setUploadError(null)
    try {
      const formData = new FormData()
      formData.append('file', previewFile)
      formData.append('providerId', selectedProviderId)
      const res: { success: boolean; status: string; difference: number; skipped?: number } = await apiFetch('/api/reconciliation/upload', {
        method: 'POST',
        body: formData,
      })
      if (res.success) {
        alert(
          `上載成功！狀態: ${res.status}，差異: $${Math.abs(res.difference).toFixed(2)}${(res.skipped ?? 0) > 0 ? `，⚠️ 跳過 ${res.skipped} 行（日期解析唔到）` : ''}`,
        )
        loadRecords()
      }
    } catch (e: any) {
      const msg = e.message || '上載失敗'
      setUploadError(msg)
      alert(`上載失敗: ${msg}`)
    } finally {
      setUploading(false)
      setParsePreview(null)
      setPreviewFile(null)
      setSelectedProviderId('')
    }
  }, [previewFile, selectedProviderId])

  const handleCancelPreview = useCallback(() => {
    setParsePreview(null)
    setPreviewFile(null)
    setSelectedProviderId('')
    setUploadError(null)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFileSelect(file)
    },
    [handleFileSelect],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleFileSelect(file)
    },
    [handleFileSelect],
  )

  const handleBackfill = useCallback(
    async (date: string) => {
      if (!confirm(`確定要重新同步 ${date} 嘅 Apricot 數據？`)) return
      try {
        const clinicRes = await apiFetch<{ clinics: { id: string }[] }>('/api/clinics')
        if (!clinicRes.clinics?.length) {
          alert('搵唔到診所')
          return
        }
        await apiFetch('/api/apricot/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clinicId: clinicRes.clinics[0].id,
            from: date,
            to: date,
          }),
        })
        alert('同步完成，請重新上載月報對數')
      } catch (e: any) {
        alert(`同步失敗: ${e.message}`)
      }
    },
    [],
  )

  const fmt = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">月報對數</h1>

      {/* Month selector + Upload / Preview */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Input
          type="month"
          value={selectedMonth}
          onChange={(e) => setSelectedMonth(e.target.value)}
          className="w-44"
        />

        {!parsePreview ? (
          <>
            <label
              className={`relative flex items-center gap-2 px-4 py-2 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                dragOver
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-300 hover:border-blue-400'
              } ${uploading ? 'opacity-50 pointer-events-none' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <Upload className="w-4 h-4" />
              <span className="text-sm">上載報表 ⬆</span>
              <Input
                type="file"
                accept=".xlsx"
                onChange={handleInputChange}
                className="absolute inset-0 opacity-0 cursor-pointer"
                disabled={uploading}
              />
            </label>

            {uploading && <span className="text-sm text-gray-500">解析中...</span>}
            {uploadError && (
              <span className="text-sm text-red-600 flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> {uploadError}
              </span>
            )}
          </>
        ) : (
          /* H1b: Parse preview — show practitioner + provider select */
          <div className="flex flex-wrap items-center gap-3 p-4 bg-blue-50 rounded-lg border border-blue-200">
            <div className="text-sm">
              <span className="text-gray-500">報表醫生：</span>
              <strong>{parsePreview.meta.practitioner}</strong>
              <span className="text-gray-400 ml-2">（{parsePreview.meta.month}，{parsePreview.rowCount} 筆{parsePreview.skipped > 0 ? `，⚠️ 跳過 ${parsePreview.skipped} 行（日期解析唔到）` : ''}）</span>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="provider-select" className="text-sm text-gray-600">揀醫生：</label>
              <select
                id="provider-select"
                value={selectedProviderId}
                onChange={(e) => setSelectedProviderId(e.target.value)}
                className="border rounded px-2 py-1 text-sm bg-white"
                disabled={uploading}
              >
                <option value="">— 請揀醫生 —</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.shortName ? ` (${p.shortName})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleUpload}
                disabled={uploading || !selectedProviderId}
                className="text-xs"
              >
                {uploading ? '上載中...' : '確認上載'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancelPreview}
                disabled={uploading}
                className="text-xs"
              >
                取消
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Records table */}
      {loading ? (
        <div className="text-gray-400">載入中...</div>
      ) : records.length === 0 ? (
        <Card className="p-8 text-center text-gray-400">
          <FileSpreadsheet className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>呢個月仲未有對數記錄</p>
          <p className="text-sm mt-1">請上載 Apricot 月報 xlsx</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b bg-gray-50">
                <th className="p-3">醫生</th>
                <th className="p-3 text-right">系統</th>
                <th className="p-3 text-right">Apricot</th>
                <th className="p-3 text-right">差異</th>
                <th className="p-3 text-center">狀態</th>
                <th className="p-3 text-left">檔案</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const isMatch = r.status === 'MATCH'
                const isMismatch = r.status === 'MISMATCH'
                const name = r.providerShortName || r.providerName || '未知'
                return (
                  <React.Fragment key={r.id}>
                    <tr className="border-b hover:bg-gray-50">
                      <td className="p-3 font-medium">{name}</td>
                      <td className="p-3 text-right tabular-nums">{fmt(r.systemTotal)}</td>
                      <td className="p-3 text-right tabular-nums">{fmt(r.reportTotal)}</td>
                      <td className={`p-3 text-right tabular-nums font-medium ${isMismatch ? 'text-red-600' : 'text-green-600'}`}>
                        {r.difference >= 0 ? '+' : '−'}{fmt(r.difference)}
                      </td>
                      {r.chargesVsPaid != null && Number(r.chargesVsPaid) !== 0 && (
                        <td className="p-3 text-xs text-gray-500">
                          收費 {fmt(r.reportCharges ?? 0)}，未收清 {fmt(r.chargesVsPaid)}
                        </td>
                      )}
                      <td className="p-3 text-center">
                        {isMatch && <span className="text-green-600">✅ 吻合</span>}
                        {isMismatch && <span className="text-red-600">🔴 差異</span>}
                        {!isMatch && !isMismatch && <span className="text-gray-400">⚪ ERROR</span>}
                      </td>
                      <td className="p-3 text-xs text-gray-500 max-w-[200px] truncate" title={r.fileName}>
                        {r.fileName}
                      </td>
                    </tr>
                    {/* Expandable detail */}
                    {r.id === expandedId && r.detailJson?.byDay && (
                      <tr>
                        <td colSpan={6} className="p-4 bg-gray-50">
                          <div className="space-y-4">
                            {/* By day detail */}
                            <div>
                              <h4 className="font-semibold text-sm mb-2">逐日對比</h4>
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left border-b">
                                    <th className="py-1">日期</th>
                                    <th className="py-1 text-right">報表</th>
                                    <th className="py-1 text-right">系統</th>
                                    <th className="py-1 text-right">差異</th>
                                    <th className="py-1"></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.detailJson.byDay
                                    .filter((d: any) => Math.abs(d.diff) > 0.01)
                                    .map((d: any, i: number) => (
                                      <tr key={i} className="border-b last:border-0">
                                        <td className="py-1">{d.date}</td>
                                        <td className="py-1 text-right tabular-nums">{fmt(d.report)}</td>
                                        <td className="py-1 text-right tabular-nums">{fmt(d.system)}</td>
                                        <td className={`py-1 text-right tabular-nums ${Math.abs(d.diff) > 0.01 ? 'text-red-600 font-medium' : ''}`}>
                                          {d.diff >= 0 ? '+' : '−'}{fmt(d.diff)}
                                        </td>
                                        <td className="py-1">
                                          {Math.abs(d.diff) > 0.01 && (
                                            <button
                                              className="text-xs text-blue-600 hover:underline"
                                              onClick={() => handleBackfill(d.date)}
                                            >
                                              ↻ backfill
                                            </button>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                            {/* By method detail */}
                            {r.detailJson.byMethod && r.detailJson.byMethod.length > 0 && (
                              <div>
                                <h4 className="font-semibold text-sm mb-2">逐方式（系統）</h4>
                                <div className="flex flex-wrap gap-2">
                                  {r.detailJson.byMethod.map((m: any, i: number) => (
                                    <span key={i} className="px-2 py-1 bg-white border rounded text-xs tabular-nums">
                                      {m.method}: {fmt(m.amount)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {/* Expand/collapse toggle */}
                    {isMismatch && r.detailJson?.byDay && (
                      <tr>
                        <td colSpan={6} className="p-1 bg-gray-50">
                          <button
                            className="text-xs text-blue-600 hover:underline flex items-center gap-1 w-full"
                            onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                          >
                            {r.id === expandedId ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                            差異明細
                          </button>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}

      <div className="text-xs text-gray-400 mt-6">
        ★ 對數永遠用你自己嘅數。月報只係答：「我有冇漏收 / 多收 payment？」
        <br />
        容差 $1，MISMATCH 唔擋生成月結，只警告。
      </div>
    </div>
  )
}

function getCurrentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
