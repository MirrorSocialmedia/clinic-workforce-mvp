'use client'

// ============================================================
// 未綁帳號（cwm-apricotacct-20260913 E3）
// 有收入但冇綁任何個體（或只標咗 UNKNOWN）嘅 Apricot 帳號 → 唔會入任何月結。
//
// ★ 綁定 modal 三個 option：
//   ( ) 醫生  [揀醫生]
//   ( ) 診所  [揀診所]   ☐ 通用帳號（每間店同一個 ID）← ★★★ 剔咗存 clinicId=null
//   ( ) 未知  — 暫時唔綁
// ★ MARKED_UNKNOWN 行（只標咗 UNKNOWN）灰色低調顯示 — 佢仲收緊錢，提醒你。
// ============================================================

import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'

interface UnassignedRow {
  apricotId: string
  name: string | null
  allocCount: number
  amount: number
  firstMonth: string | null
  lastMonth: string | null
  clinics: string[]
  status: 'UNBOUND' | 'MARKED_UNKNOWN'
}

interface ProviderOption { id: string; name: string }
interface ClinicOption { id: string; name: string }

type BindKind = 'PROVIDER' | 'CLINIC' | 'UNKNOWN'

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 })}`
}

export default function UnassignedAccountsPage() {
  const [rows, setRows] = useState<UnassignedRow[]>([])
  const [totalAmount, setTotalAmount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 綁定 modal
  const [modalRow, setModalRow] = useState<UnassignedRow | null>(null)
  // ★ 顯示／提交用（destructuring 出 apricotId）
  const { apricotId: modalRowId } = modalRow ?? {}
  const [kind, setKind] = useState<BindKind>('PROVIDER')
  const [providerId, setProviderId] = useState('')
  const [clinicId, setClinicId] = useState('')
  const [genericClinic, setGenericClinic] = useState(false) // ★★★ 通用帳號 → clinicId=null
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [clinics, setClinics] = useState<ClinicOption[]>([])

  const loadList = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data: any = await apiFetch('/api/apricot-accounts/unassigned')
      setRows(data.unassigned || [])
      setTotalAmount(data.totalAmount ?? 0)
    } catch (e: any) {
      console.error('[apricot-accounts] load failed', e)
      setLoadError(e?.message || '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadOptions = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([
        apiFetch<any>('/api/providers'),
        apiFetch<any>('/api/clinics'),
      ])
      setProviders((p.providers || []).map((x: any) => ({ id: x.id, name: x.name })))
      setClinics((c.clinics || []).map((x: any) => ({ id: x.id, name: x.name })))
    } catch (e) {
      console.error('[apricot-accounts] load options failed', e)
    }
  }, [])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { loadOptions() }, [loadOptions])

  const openModal = (row: UnassignedRow) => {
    setModalRow(row)
    setKind('PROVIDER')
    setProviderId('')
    setClinicId('')
    setGenericClinic(false)
    setNote('')
    setSaveError(null)
    setSaved(false)
  }

  const submit = async () => {
    if (!modalRow) return
    // 前端預檢（server 都有三道守衛，呢度只係即時反饋）
    if (kind === 'PROVIDER' && !providerId) {
      setSaveError('揀一位醫生')
      return
    }
    if (kind === 'CLINIC' && !genericClinic && !clinicId) {
      setSaveError('揀一間診所，或者剔「通用帳號」')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await apiFetch('/api/apricot-accounts', {
        method: 'PUT',
        body: JSON.stringify({
          apricotId: modalRowId,
          kind,
          // ★ PROVIDER → 只送 providerId；CLINIC 通用 → clinicId 唔送；UNKNOWN → 兩個都唔送
          providerId: kind === 'PROVIDER' ? providerId : null,
          clinicId: kind === 'CLINIC' && !genericClinic ? clinicId : null,
          // 用戶冇改過名 → 送 null 落 server 用醫生/診所名兜底
          name: null,
          note: note.trim() || null,
        }),
      })
      setSaved(true)
      // 綁完重新載入（呢行應該出清單）
      setTimeout(() => {
        setModalRow(null)
        loadList()
      }, 600)
    } catch (e: any) {
      setSaveError(e?.message || '綁定失敗')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-xl font-bold">未綁帳號</h1>
        <p className="text-sm text-muted-foreground mt-1">
          有收入但冇綁任何個體（或只標咗 UNKNOWN）嘅 Apricot 帳號 —— 呢啲收入唔會入任何月結。
        </p>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-3 text-sm">{loadError}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 p-6 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 載入中…
        </div>
      ) : (
        <Card className="p-4">
          {rows.length === 0 ? (
            <div className="flex items-center gap-2 text-green-700 p-4">
              <CheckCircle2 className="h-4 w-4" /> 所有收緊錢嘅 Apricot 帳號都已綁定
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3 mb-4 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  {rows.length} 個 Apricot 帳號未綁 —— 呢啲收入唔會入任何月結
                  {totalAmount > 0 && <span>（合計 {fmtMoney(totalAmount)}）</span>}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">名</th>
                      <th className="py-2 pr-4 font-medium">ID</th>
                      <th className="py-2 pr-4 font-medium">診所</th>
                      <th className="py-2 pr-4 font-medium text-right">筆數</th>
                      <th className="py-2 pr-4 font-medium text-right">金額</th>
                      <th className="py-2 pr-4 font-medium">期間</th>
                      <th className="py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const { apricotId: rowId } = r
                      return (
                      <tr
                        key={rowId}
                        className={`border-b last:border-0 ${r.status === 'MARKED_UNKNOWN' ? 'opacity-50' : ''}`}
                      >
                        <td className="py-2 pr-4">
                          {r.name || '（無名）'}
                          {r.status === 'MARKED_UNKNOWN' && (
                            <span className="ml-2 text-xs text-muted-foreground">（已標 UNKNOWN）</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{rowId}</td>
                        <td className="py-2 pr-4">{r.clinics?.length ? r.clinics.join('、') : '—'}</td>
                        <td className="py-2 pr-4 text-right">{r.allocCount}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{fmtMoney(r.amount)}</td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {r.firstMonth && r.lastMonth ? `${r.firstMonth}～${r.lastMonth}` : '—'}
                        </td>
                        <td className="py-2 text-right">
                          <Button size="sm" onClick={() => openModal(r)}>綁定</Button>
                        </td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {/* 綁定 modal */}
      {modalRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-background rounded-lg shadow-xl w-full max-w-md p-5 space-y-4">
            <div>
              <div className="font-semibold">綁定帳號</div>
              <div className="text-sm text-muted-foreground mt-1">
                帳號 <span className="font-medium text-foreground">{modalRow.name || '（無名）'}</span>
                <span className="ml-2 font-mono text-xs">ID {modalRowId}</span>
              </div>
            </div>

            {saved ? (
              <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-md p-3 text-sm">
                <CheckCircle2 className="h-4 w-4" /> 已綁定
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="text-sm font-medium">呢個帳號屬於：</div>

                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={kind === 'PROVIDER'}
                      onChange={() => setKind('PROVIDER')}
                      className="accent-primary"
                    />
                    醫生
                    <select
                      value={providerId}
                      onChange={e => setProviderId(e.target.value)}
                      disabled={kind !== 'PROVIDER'}
                      className="ml-auto border rounded px-2 py-1.5 text-sm w-44"
                    >
                      <option value="">揀醫生…</option>
                      {providers.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={kind === 'CLINIC'}
                      onChange={() => setKind('CLINIC')}
                      className="accent-primary"
                    />
                    診所
                    <select
                      value={clinicId}
                      onChange={e => setClinicId(e.target.value)}
                      disabled={kind !== 'CLINIC' || genericClinic}
                      className="ml-auto border rounded px-2 py-1.5 text-sm w-44"
                    >
                      <option value="">揀診所…</option>
                      {clinics.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>

                  {/* ★★★ 通用帳號 — 剔咗存 clinicId=null（每間店同一個 ID，唔好硬揀一間店） */}
                  <label className="flex items-center gap-2 text-sm cursor-pointer ml-6">
                    <input
                      type="checkbox"
                      checked={genericClinic}
                      onChange={e => setGenericClinic(e.target.checked)}
                      disabled={kind !== 'CLINIC'}
                      className="accent-primary"
                    />
                    通用帳號（每間店同一個 ID）
                  </label>

                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={kind === 'UNKNOWN'}
                      onChange={() => setKind('UNKNOWN')}
                      className="accent-primary"
                    />
                    未知 <span className="text-muted-foreground">— 暫時唔綁</span>
                  </label>
                </div>

                <div className="space-y-1">
                  <Label className="text-sm">備註</Label>
                  <Input
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="例如：新開嘅帳號，仲未確認係邊個"
                  />
                </div>

                {saveError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-2 text-sm">{saveError}</div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setModalRow(null)} disabled={saving}>
                    取消
                  </Button>
                  <Button size="sm" onClick={submit} disabled={saving}>
                    {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                    確定
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
