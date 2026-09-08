'use client'

/**
 * MD-D: Payout Runs List — 月結單列表
 * OWNER / provider_payout 權限
 * ★ 2026-08-17: 粒度改為「醫生 × 診所 × 月」
 */
import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Plus, Eye, Lock, FileText, Users, Share2, AlertTriangle, CheckCircle2, SlidersHorizontal, Download } from 'lucide-react'
import { hasPermission } from '@/lib/permissions'

interface PayoutRun {
  id: string
  providerId: string
  clinicId: string
  periodMonth: string
  status: string
  totalAmount: number
  provider: { name: string; shortName?: string | null }
  clinic: { name: string; shortName?: string | null } | null
}

interface ClinicOption {
  id: string
  name: string
  shortName?: string | null
  source: 'PROVIDER_CLINIC' | 'ALLOCATION' | 'REFERRAL'
}

export default function PayoutRunsPage() {
  // ★ MD-AC3: useSearchParams 喺 Next 14 需要 Suspense boundary（build 時 prerender）
  return (
    <Suspense fallback={<div className="p-6">載入中...</div>}>
      <PayoutRunsPageInner />
    </Suspense>
  )
}

function PayoutRunsPageInner() {
  const sp = useSearchParams()
  const currentMonth = (() => {
    // ★ HK 視角月份（同 hk-date.ts 慣例），唔靠瀏覽器本機時區
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit' }).format(new Date())
  })()
  // ★ useSearchParams 喺 Next 14 型別係 SearchParams | null，要守衛
  const urlClinic = sp?.get('clinicId') ?? ''
  const urlMonth = sp?.get('month') ?? ''

  const [runs, setRuns] = useState<PayoutRun[]>([])
  const [loading, setLoading] = useState(true)
  const [providers, setProviders] = useState<{ id: string; name: string; apricotId?: string | null }[]>([])
  const [selectedProvider, setSelectedProvider] = useState('')
  // ★ MD-AC3: 支援 /payout?clinicId=...&month=...（由店鋪營收卡片連結入嚟預先揀好）
  const [selectedClinic, setSelectedClinic] = useState(urlClinic)
  const [availableClinics, setAvailableClinics] = useState<ClinicOption[]>([])
  // ★ cwm-payoutcost-20260908 A1：診所 → 醫生（反方向）。`providers` 係全量下拉，呢個係收窄後嘅名單
  //   null = 唔知（未拉／fetch 失敗）→ 下拉退返全量；[] = 呢間店真係冇醫生 → 下拉空白
  const [clinicProviders, setClinicProviders] = useState<
    { id: string; name: string; shortName: string | null; source: string }[] | null
  >(null)
  // ★ A1：診所視角「有收入但未生成」提示
  const [uncoveredProviders, setUncoveredProviders] = useState<
    { id: string; name: string; shortName: string | null; source: string }[]
  >([])
  // ★ A1：「全部診所」名單（未揀醫生時診所下拉來源）。MD fallback：
  //   本頁可用用戶包 provider_payout override 用戶，GET /api/clinics 唔保證覆蓋（scope filter）
  //   → 改由 POST /api/payout-runs/clinics list mode（淨 periodMonth）供數
  const [allClinics, setAllClinics] = useState<{ id: string; name: string; shortName?: string | null; source?: string }[]>([])
  const [selectedMonth, setSelectedMonth] = useState(urlMonth || currentMonth)
  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const canPayout = userRole ? hasPermission(userRole, 'provider_payout', grant, deny) : false

  // Preview modal
  const [showPreview, setShowPreview] = useState(false)
  const [previewData, setPreviewData] = useState<any>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([])

  // 「有收入但未生成」提示
  const [uncoveredClinics, setUncoveredClinics] = useState<ClinicOption[]>([])

  // ★ cwm-payoutcost-20260908 A2：列表 filter —— 勾選 = 唔理月份，全部列出
  //   （同成本錄入頁 cost-entry/page.tsx:1101「全部月份」同一 pattern）
  const [allMonths, setAllMonths] = useState(false)

  useEffect(() => {
    // ★ A2：mount 嗰次 load 都要帶埋當次 filter — 否則無 filter 嗰個 fetch 喺 server 端
    //   多做 2 條 provider/clinic map query，較慢落後，會蓋過 filter effect 嘅結果 →
    //   開頁最終見到全部月份（實測競態，違反 default = 當月行為）
    loadRuns({
      providerId: selectedProvider || undefined,
      clinicId: selectedClinic || undefined,
      periodMonth: allMonths ? undefined : (selectedMonth || undefined),
    })
    loadProviders()
    loadMe()
    loadAllClinics(selectedMonth) // ★ A1：mount 拉「全部診所」名單（反方向診所下拉）
  }, [])

  // ★ A2：filter 一變就重載列表。★ 空字串 = 唔 filter（唔可以傳 '' 落 query，
  //   後端 `if (providerId)` 對 '' 係 falsy 冇事，但傳咗會令 URL 難睇兼難 debug）
  useEffect(() => {
    loadRuns({
      providerId: selectedProvider || undefined,
      clinicId: selectedClinic || undefined,
      periodMonth: allMonths ? undefined : (selectedMonth || undefined),
    })
  }, [selectedProvider, selectedClinic, selectedMonth, allMonths])

  // ★ MD-AC3: URL 連結預先揀好嘅診所 — 用戶未動過選擇之前，
  //   effect 唔可以清空佢（否則進頁面即失去預選）
  const userTouched = useRef(false)

  useEffect(() => {
    if (selectedProvider && selectedMonth) {
      loadAvailableClinics(selectedProvider, selectedMonth)
    } else if (userTouched.current) {
      setAvailableClinics([])
      setSelectedClinic('')
      setUncoveredClinics([])
    } else {
      setAvailableClinics([])
      setUncoveredClinics([])
    }
  }, [selectedProvider, selectedMonth])

  // ★ cwm-payoutcost-20260908 A1：淨揀咗診所（未揀醫生）→ 拉呢間店呢個月有收入嘅醫生
  useEffect(() => {
    if (selectedClinic && selectedMonth && !selectedProvider) {
      loadClinicProviders(selectedClinic, selectedMonth)
    } else {
      setClinicProviders(null)
      setUncoveredProviders([])
    }
  }, [selectedClinic, selectedMonth, selectedProvider])

  async function loadMe() {
    try {
      const res = await apiFetch<any>('/api/me')
      setUserRole(res.user?.role || '')
      setGrant(res.user?.grant || [])
      setDeny(res.user?.deny || [])
    } catch (e) {
      console.error('Failed to load user info', e)
    }
  }

  async function loadRuns(opts?: { providerId?: string; clinicId?: string; periodMonth?: string }) {
    try {
      const qs = new URLSearchParams()
      if (opts?.providerId) qs.set('providerId', opts.providerId)
      if (opts?.clinicId) qs.set('clinicId', opts.clinicId)
      if (opts?.periodMonth) qs.set('periodMonth', opts.periodMonth)
      const url = qs.toString() ? `/api/payout-runs?${qs}` : '/api/payout-runs'
      const res = await apiFetch<{ runs: PayoutRun[] }>(url)
      setRuns(res.runs || [])
    } catch (e) {
      console.error('Failed to load payout runs', e)
    } finally {
      setLoading(false)
    }
  }

  async function loadProviders() {
    try {
      const res = await apiFetch<any>('/api/providers')
      setProviders(res.providers || [])
    } catch (e) {
      console.error('Failed to load providers', e)
    }
  }

  /** 載入某醫生在某月可用的診所列表 + 未覆蓋診所 */
  async function loadAvailableClinics(providerId: string, periodMonth: string) {
    try {
      const res = await apiFetch<any>('/api/payout-runs/clinics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, periodMonth }),
      })
      setAvailableClinics(res.clinics || [])
      setUncoveredClinics(res.uncoveredClinics || [])
      // 如果有選中的診所且還在列表中，保留；否則清空
      if (selectedClinic && res.clinics?.some((c: ClinicOption) => c.id === selectedClinic)) {
        // keep
      } else if (res.clinics?.length > 0 && !selectedClinic) {
        setSelectedClinic(res.clinics[0].id)
      } else {
        setSelectedClinic('')
      }
    } catch (e) {
      console.error('Failed to load clinics', e)
      setAvailableClinics([])
    }
  }

  /** ★ A1：「全部診所」名單 — list mode（淨 periodMonth）。MD fallback：唔用 GET /api/clinics */
  async function loadAllClinics(periodMonth: string) {
    try {
      const res = await apiFetch<any>('/api/payout-runs/clinics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodMonth }),
      })
      setAllClinics(res.allClinics || [])
    } catch (e) {
      console.error('Failed to load all clinics', e)
    }
  }

  /** ★ A1：某診所某月可用嘅醫生（反方向） */
  async function loadClinicProviders(clinicId: string, periodMonth: string) {
    try {
      const res = await apiFetch<any>('/api/payout-runs/clinics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clinicId, periodMonth }),
      })
      setClinicProviders(res.providers || [])
      setUncoveredProviders(res.uncoveredProviders || [])
      if (res.allClinics) setAllClinics(res.allClinics)
    } catch (e) {
      console.error('Failed to load clinic providers', e)
      setClinicProviders(null)   // ★ null = 退返全量，唔可以 []（會令下拉變空，人手揀唔到嘢）
      setUncoveredProviders([])
    }
  }

  async function handlePreview() {
    if (!selectedProvider || !selectedMonth || !selectedClinic) {
      alert('請選擇醫生、診所和月份')
      return
    }
    setPreviewLoading(true)
    try {
      const res = await apiFetch<any>('/api/payout-runs/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProvider,
          periodMonth: selectedMonth,
          clinicId: selectedClinic || undefined,
        }),
      })
      setPreviewData(res)
      setPreviewWarnings(res.warnings || [])
      setShowPreview(true)
    } catch (e: any) {
      if (e.status === 400) {
        const msgs = (e.message || '未知錯誤')
        alert(`無法預覽:\n${msgs}`)
      } else {
        alert(`預覽失敗: ${e.message}`)
      }
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleGenerate() {
    if (!selectedProvider || !selectedMonth || !selectedClinic) {
      alert('請選擇醫生、診所和月份')
      return
    }
    if (!confirm(`確定為 ${selectedMonth} 生成月結單？`)) return
    setGenerating(true)
    try {
      const res = await apiFetch<any>('/api/payout-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProvider,
          periodMonth: selectedMonth,
          clinicId: selectedClinic || undefined,
        }),
      })
      alert(`月結單已生成 (總額: $${res.run.totalAmount})`)
      setShowPreview(false)
      loadRuns({
        providerId: selectedProvider || undefined,
        clinicId: selectedClinic || undefined,
        periodMonth: allMonths ? undefined : (selectedMonth || undefined),
      })
      // 重新載入診所列表
      if (selectedProvider && selectedMonth) {
        loadAvailableClinics(selectedProvider, selectedMonth)
      }
    } catch (e: any) {
      if (e.status === 409) {
        alert(`月結單已存在`)
      } else if (e.status === 400) {
        alert(`生成失敗: ${e.message}`)
      } else {
        alert(`生成失敗: ${e.message}`)
      }
    } finally {
      setGenerating(false)
    }
  }

  // Group runs by provider+month for the "uncovered" display
  function getRunsByProviderMonth(providerId: string, month: string): PayoutRun[] {
    return runs.filter(r => r.providerId === providerId && r.periodMonth === month)
  }

  if (loading) return <div className="p-6">載入中...</div>

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">醫生月結單</h1>

      {/* Entry links */}
      <div className="flex gap-4 flex-wrap mb-4">
        <a href="/payout/adjustments" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <SlidersHorizontal size={14} /> 手動調整錄入
        </a>
        <a href="/payout/sp-subsidies" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <Users size={14} /> 2人SP 補貼確認
        </a>
        <a href="/payout/referrals" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <Share2 size={14} /> 醫生轉介（REF）
        </a>
      </div>

      {/* Generate section */}
      {canPayout && (
        <Card className="p-4 mb-6">
          {previewWarnings.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
              預覽提示 — 建議確認：
              <ul className="list-disc ml-4 mt-1">
                {previewWarnings.map((w, i) => (<li key={i}>{w}</li>))}
              </ul>
            </div>
          )}
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Plus className="w-4 h-4" /> 生成月結單
          </h2>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-sm text-gray-600 mb-1">醫生</label>
              <select
                className="border rounded px-3 py-2 w-48"
                value={selectedProvider}
                onChange={e => { userTouched.current = true; setSelectedProvider(e.target.value) }}
              >
                <option value="">選擇醫生</option>
                {(clinicProviders ?? providers).map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {clinicProviders && p.source === 'ALLOCATION' ? ' (有收入)'
                      : clinicProviders && p.source === 'REFERRAL' ? ' (轉介)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">診所</label>
              <select
                className="border rounded px-3 py-2 w-48"
                value={selectedClinic}
                onChange={e => { userTouched.current = true; setSelectedClinic(e.target.value) }}
                disabled={!selectedMonth}
              >
                <option value="">選擇診所</option>
                {(selectedProvider ? availableClinics : allClinics).map(c => (
                  <option key={c.id} value={c.id}>
                    {c.shortName || c.name}
                    {selectedProvider
                      ? (c.source === 'ALLOCATION' ? ' (付款)' : c.source === 'REFERRAL' ? ' (轉介)' : ' (綁定)')
                      : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">月份</label>
              <Input
                type="month"
                value={selectedMonth}
                onChange={e => { userTouched.current = true; setSelectedMonth(e.target.value) }}
                className="w-44"
              />
            </div>
            <label className="flex items-center gap-1.5 text-sm text-gray-600 pb-2 cursor-pointer">
              <input type="checkbox" checked={allMonths} onChange={e => setAllMonths(e.target.checked)} />
              全部月份
            </label>
            <Button
              onClick={handlePreview}
              disabled={previewLoading || !selectedProvider || !selectedMonth || !selectedClinic}
              variant="outline"
            >
              預覽
            </Button>
            <Button
              onClick={handleGenerate}
              disabled={generating || !selectedProvider || !selectedMonth || !selectedClinic}
            >
              {generating ? '生成中...' : '生成並鎖定'}
            </Button>
          </div>

          {/* 「有收入但未生成」提示 */}
          {selectedProvider && selectedMonth && uncoveredClinics.length > 0 && (
            <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              <div className="font-semibold mb-1">
                {selectedMonth} · {providers.find(p => p.id === selectedProvider)?.name}
              </div>
              {(() => {
                const coveredClinicIds = new Set(
                  getRunsByProviderMonth(selectedProvider, selectedMonth).map(r => r.clinicId)
                )
                const covered = uncoveredClinics.filter(c => coveredClinicIds.has(c.id))
                const notCovered = uncoveredClinics.filter(c => !coveredClinicIds.has(c.id))
                if (covered.length === 0 && notCovered.length === 0) return null
                return (
                  <div className="mt-1 space-y-0.5">
                    {covered.map(c => (
                      <div key={c.id} className="flex items-center gap-1 text-green-700">
                        <CheckCircle2 size={12} />
                        <span>{c.shortName || c.name} — 已鎖定</span>
                      </div>
                    ))}
                    {notCovered.map(c => (
                      <div key={c.id} className="flex items-center gap-1 text-amber-700">
                        <AlertTriangle size={12} />
                        <span>{c.shortName || c.name} — 有收入但未生成月結</span>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )}

          {/* ★ A1：診所視角 —— 呢間店呢個月，邊幾個醫生未出月結（平行段，上方醫生視角段保留） */}
          {!selectedProvider && selectedClinic && selectedMonth && uncoveredProviders.length > 0 && (
            <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              <div className="font-semibold mb-1">
                {selectedMonth} · {allClinics.find(c => c.id === selectedClinic)?.shortName
                  || allClinics.find(c => c.id === selectedClinic)?.name}
              </div>
              <div className="mt-1 space-y-0.5">
                {uncoveredProviders.map(p => (
                  <div key={p.id} className="flex items-center gap-1 text-amber-700">
                    <AlertTriangle size={12} />
                    <span>{p.shortName || p.name} — 有收入但未生成月結</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Preview modal */}
      {showPreview && previewData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 max-w-2xl w-full max-h-[90vh] overflow-auto">
            <h2 className="text-xl font-bold mb-4">月結單預覽</h2>
            {previewData.errors && previewData.errors.length > 0 && (
              <div className="bg-red-50 text-red-700 p-3 rounded mb-4">
                {previewData.errors.map((e: string, i: number) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
            )}
            {previewData.preview && (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span>原始收入</span><span>${previewData.preview.rawAmount?.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>收入（扣手續費後）</span><span>${previewData.preview.grossAmount?.toFixed(2)}</span></div>
                <div className="flex justify-between text-red-600"><span>Lab 成本</span><span>-${previewData.preview.labCost?.toFixed(2)}</span></div>
                <div className="flex justify-between text-red-600"><span>Implant 成本</span><span>-${previewData.preview.implantCost?.toFixed(2)}</span></div>
                <div className="flex justify-between text-red-600"><span>Invisalign 成本</span><span>-${previewData.preview.invisalignCost?.toFixed(2)}</span></div>
                <div className="flex justify-between font-semibold"><span>利潤</span><span>${previewData.preview.profitAmount?.toFixed(2)}</span></div>
                <div className="flex justify-between text-blue-600"><span>拆帳 ({previewData.preview.percentUsed}%)</span><span>${previewData.preview.salaryAmount?.toFixed(2)}</span></div>
                <div className="flex justify-between text-green-600"><span>SP 補貼</span><span>+$ {previewData.preview.spSubsidy?.toFixed(2)}</span></div>
                <div className="flex justify-between text-green-600"><span>轉介</span><span>+$ {previewData.preview.refAmount?.toFixed(2)}</span></div>
                <div className="flex justify-between text-green-600"><span>上期調整</span><span>+$ {previewData.preview.adjustAmount?.toFixed(2)}</span></div>
                <hr />
                <div className="flex justify-between font-bold text-lg">
                  <span>總額</span><span>${previewData.preview.totalAmount?.toFixed(2)}</span>
                </div>
              </div>
            )}
            {previewData.warnings && previewData.warnings.length > 0 && (
              <div className="bg-yellow-50 text-yellow-700 p-3 rounded mt-4">
                {previewData.warnings.map((w: string, i: number) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setShowPreview(false)}>關閉</Button>
              <Button onClick={handleGenerate} disabled={generating}>
                {generating ? '生成中...' : '確認並鎖定'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Runs list */}
      <div className="space-y-2">
        {runs.length === 0 && (
          <p className="text-gray-500">
            {selectedProvider || selectedClinic || !allMonths
              ? '呢個篩選範圍冇月結單'
              : '暫無月結單'}
          </p>
        )}
        {runs.map(run => (
          <Card key={run.id} className="p-4 flex justify-between items-center">
            <div>
              <div className="font-semibold">
                {run.provider?.shortName || run.provider?.name}
                {run.clinic ? ` · ${run.clinic.shortName || run.clinic.name}` : ''}
                {' · '}{run.periodMonth}
              </div>
              <div className="text-sm text-gray-500">
                總額: ${run.totalAmount.toFixed(2)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                run.status === 'LOCKED' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
              }`}>
                {run.status === 'LOCKED' ? <><Lock className="w-3 h-3 inline mr-1" />已鎖定</> : '草稿'}
              </span>
              <a href={`/api/payout-runs/${run.id}/export`} title="匯出 Excel" onClick={e => e.stopPropagation()} className="text-gray-400 hover:text-gray-700 px-2">
                <Download size={14} />
              </a>
              <a href={`/payout/${run.id}`}>
                <Button variant="ghost" size="sm"><Eye className="w-4 h-4" /></Button>
              </a>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
