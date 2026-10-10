'use client'

/**
 * ★ cwm-labdoc P4 CHUNK 3：/lab-docs/settings — §12.6 Lab 設定頁（lab_statement）
 *
 * - 容量統計（§11 GET /api/lab-docs/stats）：總容量＋各狀態數量；參考基線「約 18MB/日 ≈ 45GB/7 年」（§5）
 * - 每間 Lab 一卡：月結單類型／單號類型／「月結單單號同 invoice 一樣？」／讀單提示（≤500 字＋字數計數）／
 *   已知收款人／別名清單（可刪）／客戶編號表
 * - 儲存：PUT /api/lab-profiles/:labId（optimistic lock — 409 提示重讀）
 * - 別名刪除：DELETE /api/lab-aliases/:id?type=LabAlias|LabCustomerNo
 * - 權限：lab_statement（§10.2）— 冇權限 = 403 提示（API 層同擋）
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ExternalLink, RefreshCw, Save, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'

// ── 類型 ────────────────────────────────────────────────────────────────

interface LabRow {
  id: string
  name: string
  isActive: boolean
}

interface Profile {
  labId: string
  labName: string
  exists: boolean
  statementKind: string
  statementDocNoSameAsInvoice: boolean
  defaultDocNoKind: string
  extractionHint: string | null
  updatedBy: string | null
  updatedAt: string | null
  payees: string[]
}

interface AliasRow {
  type: string
  id: string
  labId: string | null
  labName: string | null
  kind: string | null
  rawNorm: string | null
  customerNo: string | null
  clinicId: string | null
  clinicName: string | null
  providerId: string | null
  providerName: string | null
  createdBy: string
  createdAt: string
}

interface Stats {
  totalBytes: number
  fileCount: number
  docCount: number
  statusCounts: Record<string, number>
}

interface Me {
  role: string
  grant: string[]
  deny: string[]
}

// ── 常數（§12.4 口徑）──────────────────────────────────────────────────

const STATEMENT_KIND_LABELS: Record<string, string> = {
  DETAIL: '明細型',
  INVOICE_LIST: '單號型',
  OUTSTANDING: '欠款型',
}
const DOC_NO_KIND_LABELS: Record<string, string> = {
  INVOICE_NO: 'Invoice 單號',
  CASE_NO: 'Case 編號',
}
const STATUS_LABELS: Record<string, string> = {
  UPLOADED: '已上傳',
  EXTRACTING: '讀取中',
  EXTRACT_FAILED: '讀取失敗',
  NEEDS_REVIEW: '待確認',
  IN_PROGRESS: '對數中',
  CONFIRMED: '已確認',
  PARTIAL: '部分對咗',
  RECONCILED: '已對',
  DUPLICATE: '重複',
  SUPERSEDED: '已取代',
  VOID: '已作廢',
}
const ALIAS_KIND_LABELS: Record<string, string> = {
  NAME_EN: '英文名',
  NAME_CN: '中文名',
  PAYEE: '收款人',
}
const HINT_MAX = 500

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function dayStr(iso: string): string {
  return iso.slice(0, 10)
}

// ── 單卡 ───────────────────────────────────────────────────────────────

interface CardProps {
  lab: LabRow
  profile: Profile | null
  aliases: AliasRow[]
  customerNos: AliasRow[]
  onSaved: (saved: Profile) => void
  onReloaded: () => void
  onDeletedAlias: (type: 'LabAlias' | 'LabCustomerNo', id: string, rawNorm: string) => void
}

function LabCard({ lab, profile, aliases, customerNos, onSaved, onReloaded, onDeletedAlias }: CardProps) {
  const [statementKind, setStatementKind] = useState(profile?.statementKind ?? 'INVOICE_LIST')
  const [docNoSame, setDocNoSame] = useState(profile?.statementDocNoSameAsInvoice ?? true)
  const [docNoKind, setDocNoKind] = useState(profile?.defaultDocNoKind ?? 'INVOICE_NO')
  const [hint, setHint] = useState(profile?.extractionHint ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  // parent 重讀後（409 後撳「重讀」）→ 用新 profile 重置本地緩衝
  const profileKey = profile ? `${profile.updatedAt ?? 'none'}:${profile.exists ? 1 : 0}` : 'init'
  useEffect(() => {
    if (profile) {
      setStatementKind(profile.statementKind)
      setDocNoSame(profile.statementDocNoSameAsInvoice)
      setDocNoKind(profile.defaultDocNoKind)
      setHint(profile.extractionHint ?? '')
      setError(null)
      setConflict(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey])

  const base = profile ?? null
  const dirty =
    base !== null &&
    (statementKind !== base.statementKind ||
      docNoSame !== base.statementDocNoSameAsInvoice ||
      docNoKind !== base.defaultDocNoKind ||
      hint !== (base.extractionHint ?? ''))

  const hintLen = hint.length
  const hintOver = hintLen > HINT_MAX

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      // 回傳 = 伺服器最新 profile（含新 updatedAt）— onSaved 用佢同步，唔好客户端自己估時間
      const saved = await apiFetch<Profile>(`/api/lab-profiles/${lab.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          updatedAt: base?.updatedAt ?? null,
          statementKind,
          statementDocNoSameAsInvoice: docNoSame,
          defaultDocNoKind: docNoKind,
          extractionHint: hint.trim() === '' ? null : hint,
        }),
      })
      onSaved(saved)
    } catch (e: any) {
      if (e?.status === 409) {
        setConflict(true)
        setError('設定已被其他人更新')
      } else {
        setError(e?.message ?? '儲存失敗')
      }
    } finally {
      setSaving(false)
    }
  }, [lab.id, base, statementKind, docNoSame, docNoKind, hint, onSaved])

  const delAlias = useCallback(
    async (type: 'LabAlias' | 'LabCustomerNo', id: string, label: string) => {
      if (!window.confirm(`確認刪除「${label}」？（下次匹配唔到會再問一次）`)) return
      try {
        await apiFetch(`/api/lab-aliases/${id}?type=${type}`, { method: 'DELETE' })
        onDeletedAlias(type, id, label)
      } catch (e: any) {
        window.alert(e?.message ?? '刪除失敗')
      }
    },
    [onDeletedAlias],
  )

  const inputCls = 'w-full rounded-lg border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40'

  return (
    <div className="bg-card border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{lab.name}</h3>
        {!lab.isActive && <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">已停用</span>}
      </div>

      {/* 設定欄 */}
      <div className="grid grid-cols-1 gap-3">
        <label className="block">
          <span className="text-xs text-muted-foreground">月結單類型</span>
          <select className={inputCls} value={statementKind} onChange={(e) => setStatementKind(e.target.value)}>
            {Object.entries(STATEMENT_KIND_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-muted-foreground">單號類型</span>
            <select className={inputCls} value={docNoKind} onChange={(e) => setDocNoKind(e.target.value)}>
              {Object.entries(DOC_NO_KIND_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <label className="flex items-end gap-2 pb-1">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--brand)]"
              checked={docNoSame}
              onChange={(e) => setDocNoSame(e.target.checked)}
            />
            <span className="text-xs text-muted-foreground leading-tight">月結單單號同 invoice 一樣？</span>
          </label>
        </div>
        <label className="block">
          <span className="text-xs text-muted-foreground">
            讀單提示（加入 AI 讀單 prompt）
            <span className={hintOver ? 'text-red-500 ml-1' : 'ml-1'}>
              {hintLen}/{HINT_MAX}
            </span>
          </span>
          <textarea
            className={`${inputCls} min-h-[64px] ${hintOver ? 'border-red-400' : ''}`}
            value={hint}
            maxLength={HINT_MAX + 50}
            placeholder="例：名後 4 位係病人編號，最後 7 位係 Lab 編號"
            onChange={(e) => setHint(e.target.value)}
          />
          {hintOver && <span className="text-[11px] text-red-500">超過 {HINT_MAX} 字 — 刪短先可以儲存</span>}
        </label>
      </div>

      {/* 已知收款人（LabAlias kind=PAYEE — 經 PUT payees 管理；呢度只顯示） */}
      <div>
        <span className="text-xs text-muted-foreground">已知收款人</span>
        <div className="flex flex-wrap gap-1 mt-1">
          {(profile?.payees ?? []).length === 0 && <span className="text-xs text-muted-foreground">（無）</span>}
          {(profile?.payees ?? []).map((p) => (
            <span key={p} className="px-2 py-0.5 rounded-full bg-brand/10 text-brand text-[11px] font-medium">{p}</span>
          ))}
        </div>
      </div>

      {/* 別名清單（可刪） */}
      <div>
        <span className="text-xs text-muted-foreground">別名清單</span>
        <ul className="mt-1 divide-y">
          {aliases.length === 0 && <li className="text-xs text-muted- py-1">（無）</li>}
          {aliases.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <span className="text-sm truncate block">{a.rawNorm}</span>
                <span className="text-[11px] text-muted-foreground">
                  {ALIAS_KIND_LABELS[a.kind ?? ''] ?? a.kind} · {dayStr(a.createdAt)}
                </span>
              </div>
              <button
                className="p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-50"
                aria-label={`刪除別名 ${a.rawNorm}`}
                onClick={() => delAlias('LabAlias', a.id, a.rawNorm ?? '')}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* 客戶編號表 */}
      <div>
        <span className="text-xs text-muted-foreground">客戶編號表</span>
        {customerNos.length === 0 ? (
          <div className="text-xs text-muted-foreground mt-1">（無）</div>
        ) : (
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">編號</th>
                  <th className="py-1 pr-2 font-medium">診所</th>
                  <th className="py-1 pr-2 font-medium">醫生</th>
                  <th className="py-1 pr-2 font-medium">記錄</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {customerNos.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="py-1.5 pr-2 font-mono">{c.customerNo}</td>
                    <td className="py-1.5 pr-2">{c.clinicName ?? c.clinicId ?? '—'}</td>
                    <td className="py-1.5 pr-2">{c.providerName ?? (c.providerId ? '—（無名）' : '全部') }</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{dayStr(c.createdAt)}</td>
                    <td className="py-1.5 text-right">
                      <button
                        className="p-1 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-50"
                        aria-label={`刪除客戶編號 ${c.customerNo}`}
                        onClick={() => delAlias('LabCustomerNo', c.id, c.customerNo ?? '')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 儲存 */}
      {error && (
        <div className="flex items-center justify-between gap-2 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
          <span className="flex items-center gap-2 min-w-0">
            <AlertTriangle size={14} className="flex-shrink-0" />
            <span className="truncate">{error}{conflict ? ' — 撳「重讀」攞最新值' : ''}</span>
          </span>
          {conflict && (
            <button className="flex-shrink-0 underline" onClick={onReloaded}>
              重讀
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-brand text-white text-sm font-medium py-2 disabled:opacity-50"
          disabled={!dirty || saving || hintOver}
          onClick={save}
        >
          <Save size={14} />
          {saving ? '儲存中…' : '儲存'}
        </button>
        <span className="text-[11px] text-muted-foreground">
          {profile?.exists ? `上次更新 ${profile.updatedAt ? dayStr(profile.updatedAt) : '—'}` : '未有設定（首次儲存會建立）'}
        </span>
      </div>
    </div>
  )
}

// ── 容量統計 ───────────────────────────────────────────────────────────

function StatsBlock({ stats }: { stats: Stats | null }) {
  return (
    <div className="bg-card border rounded-xl p-4 space-y-2">
      <h3 className="font-semibold text-sm">容量統計</h3>
      {stats === null ? (
        <div className="text-xs text-muted-foreground">載入中…</div>
      ) : (
        <>
          <div className="text-sm">
            檔案庫 <b>{fmtBytes(stats.totalBytes)}</b> · {stats.fileCount} 個檔案 · {stats.docCount} 張單據
          </div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(stats.statusCounts).map(([s, n]) => (
              <span key={s} className="px-2 py-0.5 rounded-full bg-muted text-[11px]">
                {STATUS_LABELS[s] ?? s} {n}
              </span>
            ))}
          </div>
          <div className="text-[11px] text-muted-foreground">
            參考基線：約 30 張/日 × 0.6MB ≈ 18MB/日、7 年 ≈ 45GB（含原檔＋顯示圖＋縮圖）
          </div>
        </>
      )}
    </div>
  )
}

// ── 頁 body ────────────────────────────────────────────────────────────

export default function LabDocSettingsBody() {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [meErr, setMeErr] = useState(false)
  const [labs, setLabs] = useState<LabRow[] | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsErr, setStatsErr] = useState(false)
  const [profiles, setProfiles] = useState<Record<string, Profile | null>>({})
  const [aliases, setAliases] = useState<Record<string, AliasRow[]>>({})
  const [customerNos, setCustomerNos] = useState<Record<string, AliasRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const allowed =
    me !== null && hasPermission(me.role, 'lab_statement', me.grant, me.deny)

  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        const d = await r.json()
        setMe({ role: d.user.role, grant: d.user.grant ?? [], deny: d.user.deny ?? [] })
      })
      .catch(() => setMeErr(true))
  }, [])

  const loadLabs = useCallback(async () => {
    setLoading(true)
    setLoadErr(null)
    try {
      const [labsResp, statsResp] = await Promise.all([
        apiFetch<{ labs: LabRow[] }>('/api/labs'),
        apiFetch<Stats>('/api/lab-docs/stats').catch(() => {
          setStatsErr(true)
          return null
        }),
      ])
      setStats(statsResp)
      const rows = labsResp.labs ?? []
      setLabs(rows)
      // 每間 Lab：profile + aliases（並行；單 lab 失敗 = graceful 顯示 null）
      const results = await Promise.all(
        rows.map(async (lab) => {
          const [profile, la, cn] = await Promise.all([
            apiFetch<Profile>(`/api/lab-profiles/${lab.id}`).catch(() => null),
            apiFetch<{ aliases: AliasRow[] }>(`/api/lab-aliases?type=LabAlias&labId=${lab.id}`).catch(() => ({ aliases: [] })),
            apiFetch<{ aliases: AliasRow[] }>(`/api/lab-aliases?type=LabCustomerNo&labId=${lab.id}`).catch(() => ({ aliases: [] })),
          ])
          return { lab, profile, la, cn }
        }),
      )
      setProfiles(Object.fromEntries(results.map((r) => [r.lab.id, r.profile])))
      setAliases(Object.fromEntries(results.map((r) => [r.lab.id, r.la.aliases])))
      setCustomerNos(Object.fromEntries(results.map((r) => [r.lab.id, r.cn.aliases])))
    } catch (e: any) {
      setLoadErr(e?.message ?? '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (allowed) void loadLabs()
  }, [allowed, loadLabs])

  const onSaved = useCallback((labId: string, saved: Profile) => {
    // 用伺服器回傳嘅 profile（含真 updatedAt）同步 — 下次 PUT 嘅鎖先係準嘅
    setProfiles((prev) => ({ ...prev, [labId]: saved }))
  }, [])

  const onReloaded = useCallback(async (labId: string) => {
    const [profile, la, cn] = await Promise.all([
      apiFetch<Profile>(`/api/lab-profiles/${labId}`).catch(() => null),
      apiFetch<{ aliases: AliasRow[] }>(`/api/lab-aliases?type=LabAlias&labId=${labId}`).catch(() => ({ aliases: [] })),
      apiFetch<{ aliases: AliasRow[] }>(`/api/lab-aliases?type=LabCustomerNo&labId=${labId}`).catch(() => ({ aliases: [] })),
    ])
    setProfiles((prev) => ({ ...prev, [labId]: profile }))
    setAliases((prev) => ({ ...prev, [labId]: la.aliases }))
    setCustomerNos((prev) => ({ ...prev, [labId]: cn.aliases }))
  }, [])

  const onDeletedAlias = useCallback((type: 'LabAlias' | 'LabCustomerNo', id: string, rawNorm: string) => {
    if (type === 'LabAlias') {
      setAliases((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, v.filter((a) => a.id !== id)])))
      // PAYEE alias 刪除 → 同步 profile.payees 顯示（本地 filter；下次全頁重讀都會一致）
      setProfiles((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([k, p]) => [k, p ? { ...p, payees: p.payees.filter((x) => x !== rawNorm) } : p]),
        ),
      )
    } else {
      setCustomerNos((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, v.filter((a) => a.id !== id)])))
    }
  }, [])

  if (meErr) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <div className="text-sm text-red-600">載入用戶資料失敗 — 請重試</div>
      </div>
    )
  }
  if (me === null) {
    return <div className="max-w-2xl mx-auto p-4 text-sm text-muted-foreground">載入中…</div>
  }
  if (!allowed) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center gap-3 py-20 text-center">
        <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center">
          <AlertTriangle size={28} className="text-red-500" />
        </div>
        <h2 className="text-lg font-semibold">冇權限</h2>
        <p className="text-sm text-muted-foreground">
          Lab 設定需要 <code className="bg-muted px-1 py-0.5 rounded">lab_statement</code> 權限。請聯絡經理喺帳號管理開通。
        </p>
        <button className="text-sm text-brand underline" onClick={() => router.push('/lab-docs')}>
          返返 Lab 單據
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Lab 設定</h1>
          <p className="text-sm text-muted-foreground mt-0.5">月結單讀法、別名、客戶編號（每間 Lab 一卡）</p>
        </div>
        <button
          className="flex items-center gap-1 text-sm text-brand"
          onClick={() => router.push('/lab-docs')}
        >
          <ExternalLink size={14} /> 單據
        </button>
      </div>

      <StatsBlock stats={stats} />
      {statsErr && (
        <div className="text-[11px] text-muted-foreground">
          容量統計載入失敗（唔影響設定）— 稍後重試
        </div>
      )}

      {loading && <div className="text-sm text-muted-foreground flex items-center gap-2 py-6"><RefreshCw size={16} className="animate-spin" /> 載入 Lab 清單…</div>}
      {loadErr && !loading && (
        <div className="flex items-center justify-between gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
          <span>{loadErr}</span>
          <button className="underline" onClick={loadLabs}>重試</button>
        </div>
      )}

      {labs && labs.length === 0 && !loading && (
        <div className="text-sm text-muted-foreground py-6 text-center">冇 Lab — 先喺 Lab 管理新增</div>
      )}

      {labs?.map((lab) => (
        <LabCard
          key={lab.id}
          lab={lab}
          profile={profiles[lab.id] ?? null}
          aliases={aliases[lab.id] ?? []}
          customerNos={customerNos[lab.id] ?? []}
          onSaved={(saved) => onSaved(lab.id, saved)}
          onReloaded={() => void onReloaded(lab.id)}
          onDeletedAlias={onDeletedAlias}
        />
      ))}
    </div>
  )
}
