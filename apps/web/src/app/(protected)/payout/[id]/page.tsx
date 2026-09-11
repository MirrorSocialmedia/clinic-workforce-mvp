'use client'

/**
 * MD-D: Payout Run Detail — 月結單詳情
 * // ownership-ok: provider_payout 權限限制
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ArrowLeft, Lock, Unlock, FileDown, Trash2, RotateCcw, Download } from 'lucide-react'

interface PayoutRun {
  id: string
  providerId: string
  clinicId: string | null
  periodMonth: string
  status: string
  lockedAt: string | null
  grossAmount: number
  rawAmount: number
  labCost: number
  implantCost: number
  invisalignCost: number
  profitAmount: number
  percentUsed: number
  salaryAmount: number
  spSubsidy: number
  refAmount: number
  adjustAmount: number
  totalAmount: number
  breakdownJson: any
  provider: { name: string; shortName?: string | null }
  clinic?: { name: string; shortName?: string | null } | null
  adjustments: any[]
}

// ★ 2026-08-26：工廠總覽 API 回傳行型
interface VendorSummaryRow {
  vendor: string
  labCost: number
  implantCost: number
  invisalignCost: number
  total: number
  caseCount: number
}

interface ReconciliationStatus {
  id: string
  providerId: string
  clinicId: string | null // ★ cwm-reconkiosk-20260910 B2：月結單係【醫生×診所×月】粒度，badge 要比對到診所
  status: string
  difference: number
  reportTotal: number
  systemTotal: number
  detailJson?: any // ★ cwm-reconkiosk-20260910 A3：nonIncomeTotal/nonIncomeMethods（CREDIT 口徑說明行）
}

export default function PayoutRunDetailPage({ params }: { params: { id: string } }) {
  const [run, setRun] = useState<PayoutRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockReason, setUnlockReason] = useState('')
  const [showUnlock, setShowUnlock] = useState(false)
  const [reconciliation, setReconciliation] = useState<ReconciliationStatus | null>(null)
  // AA4: delete/regenerate states
  const [deleting, setDeleting] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  // ★ 2026-08-26：[ 醫生明細 ] [ 工廠總覽 ] tab
  const [tab, setTab] = useState<'doctor' | 'vendor'>('doctor')
  const [vendorSummary, setVendorSummary] = useState<{ vendors: VendorSummaryRow[] } | null>(null)
  const [vendorLoading, setVendorLoading] = useState(false)
  const router = useRouter()

  useEffect(() => {
    loadRun()
  }, [params.id])

  async function loadRun() {
    try {
      const res = await apiFetch<{ run: PayoutRun }>(`/api/payout-runs/${params.id}`)
      setRun(res.run)
      // Fetch reconciliation status for this provider + clinic + month
      loadReconciliation(res.run.providerId, res.run.periodMonth, res.run.clinicId)
      // ★ 2026-08-26：工廠總覽（跨醫生）
      loadVendorSummary(res.run.id)
    } catch (e: any) {
      alert(`載入失敗: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  async function loadVendorSummary(runId: string) {
    setVendorLoading(true)
    try {
      const res = await apiFetch<{ vendors: VendorSummaryRow[] }>(`/api/payout-runs/${runId}/vendor-summary`)
      setVendorSummary({ vendors: res.vendors })
    } catch {
      setVendorSummary(null) // 總覽攞唔到唔阻主頁
    } finally {
      setVendorLoading(false)
    }
  }

  async function loadReconciliation(providerId: string, periodMonth: string, clinicId: string | null) {
    try {
      const res = await apiFetch<{ imports: ReconciliationStatus[] }>(
        `/api/reconciliation?month=${encodeURIComponent(periodMonth)}${clinicId ? `&clinicId=${encodeURIComponent(clinicId)}` : ''}`,
      )
      // ★ cwm-reconkiosk-20260910 B2：月結單係【醫生 × 診所 × 月】粒度。淨對 providerId 會攞到第二間診所，
      //   或者 clinic-scope 修好之前嗰批 clinicId=NULL 舊記錄
      //   （實證：何嘉俊醫生月結單顯示 573,384，實際嗰筆係全診所混埋嘅舊數）。
      //   ★ NULL 記錄嘅 clinicId 永遠 !== clinicId → 修咗之後自動被忽略。
      //   run 冇 clinicId（唔應該發生，POST 必填）→ 拒絕 match，寧缺毋濫。
      const match = clinicId
        ? res.imports.find((r) => r.providerId === providerId && r.clinicId === clinicId)
        : undefined
      setReconciliation(match || null)
    } catch {
      // Reconciliation data optional — don't block page load
      setReconciliation(null)
    }
  }

  async function handleUnlock() {
    if (!unlockReason.trim()) {
      alert('解鎖必須填寫理由')
      return
    }
    setUnlocking(true)
    try {
      await apiFetch('/api/payout-runs/' + params.id + '/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: unlockReason }),
      })
      alert('已解鎖')
      setShowUnlock(false)
      loadRun()
    } catch (e: any) {
      alert(`解鎖失敗: ${e.message}`)
    } finally {
      setUnlocking(false)
    }
  }

  // AA4: 刪除草稿
  async function handleDelete() {
    if (!run) return
    if (!confirm(`刪除 ${run.periodMonth} 草稿月結單？成本/補貼/轉介記錄會解除鎖定（唔會刪），可以重新生成。`)) return
    setDeleting(true)
    try {
      await apiFetch(`/api/payout-runs/${params.id}`, { method: 'DELETE' })
      alert('已刪除草稿')
      router.push('/payout')
    } catch (e: any) {
      alert(`刪除失敗: ${e.message}`)
    } finally {
      setDeleting(false)
    }
  }

  // AA4: 重新生成（DELETE + POST）
  async function handleRegenerate() {
    if (!run) return
    if (!confirm(`重新生成 ${run.periodMonth} 月結單？會先刪除舊草稿再重新計算。`)) return
    setRegenerating(true)
    try {
      await apiFetch(`/api/payout-runs/${params.id}`, { method: 'DELETE' })
      const clinicId = run.clinicId || ''
      const res: { run: { id: string } } = await apiFetch('/api/payout-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: run.providerId, periodMonth: run.periodMonth, clinicId }),
      })
      alert('重新生成成功')
      router.push(`/payout/${res.run.id}`)
    } catch (e: any) {
      alert(`重新生成失敗: ${e.message}`)
    } finally {
      setRegenerating(false)
    }
  }

  if (loading) return <div className="p-6">載入中...</div>
  if (!run) return <div className="p-6">搵唔到月結單</div>

  const { provider, periodMonth } = run
  const name = provider?.shortName || provider?.name || '未知醫生'
  const isDraft = run.status !== 'LOCKED'

  // ★ 2026-08-26：breakdownJson 新格式 = { allocations, vendors }；舊 run 係裸陣列 → normalize（#12 唔 crash）
  const bj: any = run.breakdownJson
  const allocationRows: any[] = Array.isArray(bj) ? bj : (bj?.allocations ?? [])
  const vendorMap: Record<string, { vendor: string; amount: number }[]> =
    Array.isArray(bj) ? {} : (bj?.vendors ?? {})

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Button variant="ghost" onClick={() => router.back()} className="mb-4">
        <ArrowLeft className="w-4 h-4 mr-1" /> 返回
      </Button>

      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold">{name} — {periodMonth} 月結單</h1>
          <p className="text-sm text-gray-500">
            狀態:{' '}
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
              run.status === 'LOCKED' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
            }`}>
              {run.status === 'LOCKED' ? <><Lock className="w-3 h-3 inline mr-1" />已鎖定</> : '草稿'}
            </span>
            {run.lockedAt && ` (鎖定時間: ${new Date(run.lockedAt).toLocaleString('zh-HK')})`}
          </p>
          {/* ★ MD-E: Reconciliation status badge */}
          <div className="mt-1">
            {reconciliation?.status === 'MATCH' && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                ✅ 月報對數吻合
              </span>
            )}
            {reconciliation?.status === 'MISMATCH' && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                🔴 月報對數差異: ${Math.abs(reconciliation.difference).toFixed(2)}
              </span>
            )}
            {!reconciliation && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                ⚪ 未上載月報
              </span>
            )}
          </div>
        </div>
        {/* AA4: 草稿狀態顯示重新生成/刪除按鈕 */}
        {isDraft && (
          <div className="flex gap-2">
            <a href={`/api/payout-runs/${run.id}/export`} className="inline-flex items-center gap-1 px-3 py-2 border rounded text-sm hover:bg-gray-50">
              <Download size={14} /> 匯出 Excel
            </a>
            <Button
              size="sm"
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              <RotateCcw className="w-4 h-4 mr-1" />
              {regenerating ? '生成中...' : '重新生成'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {deleting ? '刪除中...' : '刪除草稿'}
            </Button>
          </div>
        )}
        {run.status === 'LOCKED' && (
          <div className="flex items-center gap-2">
            <a href={`/api/payout-runs/${run.id}/export`} className="inline-flex items-center gap-1 px-3 py-2 border rounded text-sm hover:bg-gray-50">
              <Download size={14} /> 匯出 Excel
            </a>
            <Button variant="outline" onClick={() => setShowUnlock(true)}>
              <Unlock className="w-4 h-4 mr-1" /> 解鎖
            </Button>
          </div>
        )}
      </div>

      {/* ★ 2026-08-26：[ 醫生明細 ] [ 工廠總覽 ] tab（MD §三） */}
      <div className="flex gap-1 border-b mb-4">
        <button
          onClick={() => setTab('doctor')}
          className={`px-3 py-1.5 text-sm rounded-t ${tab === 'doctor' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
        >
          醫生明細
        </button>
        <button
          onClick={() => setTab('vendor')}
          className={`px-3 py-1.5 text-sm rounded-t ${tab === 'vendor' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
        >
          工廠總覽
        </button>
      </div>

      {/* Unlock modal */}
      {showUnlock && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 max-w-md w-full">
            <h2 className="text-lg font-bold mb-3">⚠️ 解鎖月結單</h2>
            <p className="text-sm text-gray-600 mb-3">解鎖後可修改相關記錄，請填寫理由：</p>
            <textarea
              className="w-full border rounded p-2 text-sm"
              rows={3}
              value={unlockReason}
              onChange={e => setUnlockReason(e.target.value)}
              placeholder="解鎖理由..."
            />
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="outline" onClick={() => setShowUnlock(false)}>取消</Button>
              <Button onClick={handleUnlock} disabled={unlocking}>
                {unlocking ? '解鎖中...' : '確認解鎖'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {tab === 'doctor' && (<>
      <Card className="p-4 mb-4">
        <h2 className="font-semibold mb-3">收入明細</h2>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between"><span>原始收入（扣手續費前）</span><span>${run.rawAmount.toFixed(2)}</span></div>
          {/* ★ cwm-reconkiosk-20260910 A3：對數口徑 vs 月結口徑說明 —— 對數包晒全部 payment，
              月結引擎排走 countAsIncome=false 嘅方式（生產實值 = CREDIT）。
              純顯示：冇 countAsIncome=false 記錄嘅月份（nonIncomeTotal=0）唔出呢行。 */}
          {reconciliation && (reconciliation.detailJson?.nonIncomeTotal ?? 0) > 0 && (
            <div className="text-xs text-gray-500 pl-2">
              └ 對數口徑 ${reconciliation.systemTotal.toFixed(2)}，差 ${(reconciliation.systemTotal - run.rawAmount).toFixed(2)}（{((reconciliation.detailJson?.nonIncomeMethods as string[]) || []).join(', ')} 不計醫生收入）
            </div>
          )}
          <div className="flex justify-between font-semibold"><span>收入（扣手續費後）</span><span>${run.grossAmount.toFixed(2)}</span></div>
        </div>
      </Card>

      <Card className="p-4 mb-4">
        <h2 className="font-semibold mb-3">成本</h2>
        <div className="space-y-1 text-sm text-red-600">
          <div className="flex justify-between font-semibold"><span>Lab 成本</span><span>-${run.labCost.toFixed(2)}</span></div>
          {/* ★ 2026-08-26：按工廠細分（舊 run 冇 vendors → ?? [] 唔出，唔 crash） */}
          {(vendorMap.LAB ?? []).length > 0 && (
            <div style={{ paddingLeft: 14, margin: '2px 0 8px', borderLeft: '2px solid #fecaca' }}>
              {(vendorMap.LAB ?? []).map((v) => (
                <div key={v.vendor} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280' }}>
                  <span>{v.vendor}</span><span>−${v.amount.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-between font-semibold"><span>Implant 成本</span><span>-${run.implantCost.toFixed(2)}</span></div>
          {(vendorMap.IMPLANT ?? []).length > 0 && (
            <div style={{ paddingLeft: 14, margin: '2px 0 8px', borderLeft: '2px solid #fecaca' }}>
              {(vendorMap.IMPLANT ?? []).map((v) => (
                <div key={v.vendor} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280' }}>
                  <span>{v.vendor}</span><span>−${v.amount.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-between font-semibold"><span>Invisalign 成本</span><span>-${run.invisalignCost.toFixed(2)}</span></div>
          {(vendorMap.INVISALIGN ?? []).length > 0 && (
            <div style={{ paddingLeft: 14, margin: '2px 0 8px', borderLeft: '2px solid #fecaca' }}>
              {(vendorMap.INVISALIGN ?? []).map((v) => (
                <div key={v.vendor} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280' }}>
                  <span>{v.vendor}</span><span>−${v.amount.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-4 mb-4">
        <h2 className="font-semibold mb-3">拆帳計算</h2>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between font-semibold"><span>利潤</span><span>${run.profitAmount.toFixed(2)}</span></div>
          <div className="flex justify-between text-blue-600"><span>拆帳 ({run.percentUsed}%)</span><span>${run.salaryAmount.toFixed(2)}</span></div>
        </div>
      </Card>

      <Card className="p-4 mb-4">
        <h2 className="font-semibold mb-3">補貼與調整</h2>
        <div className="space-y-1 text-sm text-green-600">
          <div className="flex justify-between"><span>2人SP補貼</span><span>+$ {run.spSubsidy.toFixed(2)}</span></div>
          <div className="flex justify-between"><span>轉介收入</span><span>+$ {run.refAmount.toFixed(2)}</span></div>
          <div className="flex justify-between"><span>上期調整</span><span>+$ {run.adjustAmount.toFixed(2)}</span></div>
        </div>
      </Card>

      <Card className="p-4 mb-4">
        <h2 className="font-bold text-lg mb-3">總額</h2>
        <div className="text-2xl font-bold text-blue-700">${run.totalAmount.toFixed(2)}</div>
      </Card>

      {/* Adjustments */}
      {run.adjustments && run.adjustments.length > 0 && (
        <Card className="p-4 mb-4">
          <h2 className="font-semibold mb-3">調整記錄</h2>
          <div className="space-y-1 text-sm">
            {run.adjustments.map(a => (
              <div key={a.id} className="flex justify-between">
                <span>{a.reason} ({a.sourceMonth}) {a.note}</span>
                <span className={a.amount >= 0 ? 'text-green-600' : 'text-red-600'}>
                  {a.amount >= 0 ? '+' : ''}${Math.abs(a.amount).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Breakdown — AA3: 付款明細表（★ 2026-08-26：用 normalize 後 allocationRows，兼容新 { allocations, vendors } 格式） */}
      {allocationRows.length > 0 && (
        <Card className="p-4 mb-4">
          <h2 className="font-semibold mb-3">付款明細</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="py-1">日期</th>
                <th className="py-1">帳單編號</th>
                <th className="py-1">方式</th>
                <th className="py-1 text-right">原始</th>
                <th className="py-1 text-right">費率</th>
                <th className="py-1 text-right">淨額</th>
              </tr>
            </thead>
            <tbody>
              {allocationRows.map((b: any, i: number) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1">{b.paidAt ? new Date(b.paidAt).toLocaleDateString('zh-HK') : '—'}</td>
                  <td className="py-1">{b.billCode || '—'}</td>
                  <td className="py-1">{b.method}</td>
                  <td className="py-1 text-right">${b.rawAmount?.toFixed(2)}</td>
                  <td className="py-1 text-right">{b.feePercentUsed}%</td>
                  <td className="py-1 text-right">${b.netAmount?.toFixed(2)}</td>
                </tr>
              ))}
              <tr className="border-b font-semibold bg-gray-50">
                <td className="py-1" colSpan={3}>小計</td>
                <td className="py-1 text-right">${run.rawAmount.toFixed(2)}</td>
                <td className="py-1"></td>
                <td className="py-1 text-right">${run.grossAmount.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      <div className="text-xs text-gray-400 mt-4">
        註：所有金額四捨五入至小數點後兩位，對數容差 $1。
      </div>
      </>)}

      {/* ★ 2026-08-26：工廠總覽 tab（跨醫生，MD §三） */}
      {tab === 'vendor' && (
        <Card className="p-4 mb-4">
          <h2 className="font-semibold mb-1">工廠總覽（跨醫生）</h2>
          <p className="text-xs text-gray-500 mb-3">
            {run.periodMonth} 全店所有醫生成本按工廠匯總{run.clinic ? `（${run.clinic.shortName || run.clinic.name}）` : ''}
          </p>
          {vendorLoading ? (
            <div className="text-sm text-gray-500">載入中...</div>
          ) : vendorSummary && vendorSummary.vendors.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-1">工廠</th>
                  <th className="py-1 text-right">Lab</th>
                  <th className="py-1 text-right">Implant</th>
                  <th className="py-1 text-right">Invisalign</th>
                  <th className="py-1 text-right">合計</th>
                  <th className="py-1 text-right">單數</th>
                </tr>
              </thead>
              <tbody>
                {vendorSummary.vendors.map((v) => (
                  <tr key={v.vendor} className="border-b">
                    <td className="py-1">{v.vendor}</td>
                    <td className="py-1 text-right">{v.labCost > 0 ? `$${v.labCost.toFixed(2)}` : '—'}</td>
                    <td className="py-1 text-right">{v.implantCost > 0 ? `$${v.implantCost.toFixed(2)}` : '—'}</td>
                    <td className="py-1 text-right">{v.invisalignCost > 0 ? `$${v.invisalignCost.toFixed(2)}` : '—'}</td>
                    <td className="py-1 text-right font-semibold">${v.total.toFixed(2)}</td>
                    <td className="py-1 text-right">{v.caseCount}</td>
                  </tr>
                ))}
                <tr className="border-b font-semibold bg-gray-50">
                  <td className="py-1">合計</td>
                  <td className="py-1 text-right">${vendorSummary.vendors.reduce((a, v) => a + v.labCost, 0).toFixed(2)}</td>
                  <td className="py-1 text-right">${vendorSummary.vendors.reduce((a, v) => a + v.implantCost, 0).toFixed(2)}</td>
                  <td className="py-1 text-right">${vendorSummary.vendors.reduce((a, v) => a + v.invisalignCost, 0).toFixed(2)}</td>
                  <td className="py-1 text-right">${vendorSummary.vendors.reduce((a, v) => a + v.total, 0).toFixed(2)}</td>
                  <td className="py-1 text-right">{vendorSummary.vendors.reduce((a, v) => a + v.caseCount, 0)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="text-sm text-gray-500">本期暫無成本數據</div>
          )}
        </Card>
      )}
    </div>
  )
}
