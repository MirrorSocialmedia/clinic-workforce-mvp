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
import { ArrowLeft, Lock, Unlock, FileDown } from 'lucide-react'

interface PayoutRun {
  id: string
  providerId: string
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
  adjustments: any[]
}

export default function PayoutRunDetailPage({ params }: { params: { id: string } }) {
  const [run, setRun] = useState<PayoutRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockReason, setUnlockReason] = useState('')
  const [showUnlock, setShowUnlock] = useState(false)
  const router = useRouter()

  useEffect(() => {
    loadRun()
  }, [params.id])

  async function loadRun() {
    try {
      const res = await apiFetch<{ run: PayoutRun }>(`/api/payout-runs/${params.id}`)
      setRun(res.run)
    } catch (e: any) {
      alert(`載入失敗: ${e.message}`)
    } finally {
      setLoading(false)
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

  if (loading) return <div className="p-6">載入中...</div>
  if (!run) return <div className="p-6">搵唔到月結單</div>

  const { provider, periodMonth } = run
  const name = provider?.shortName || provider?.name || '未知醫生'

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
        </div>
        {run.status === 'LOCKED' && (
          <Button variant="outline" onClick={() => setShowUnlock(true)}>
            <Unlock className="w-4 h-4 mr-1" /> 解鎖
          </Button>
        )}
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

      <Card className="p-4 mb-4">
        <h2 className="font-semibold mb-3">收入明細</h2>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between"><span>原始收入（扣手續費前）</span><span>${run.rawAmount.toFixed(2)}</span></div>
          <div className="flex justify-between font-semibold"><span>收入（扣手續費後）</span><span>${run.grossAmount.toFixed(2)}</span></div>
        </div>
      </Card>

      <Card className="p-4 mb-4">
        <h2 className="font-semibold mb-3">成本</h2>
        <div className="space-y-1 text-sm text-red-600">
          <div className="flex justify-between"><span>Lab 成本</span><span>-${run.labCost.toFixed(2)}</span></div>
          <div className="flex justify-between"><span>Implant 成本</span><span>-${run.implantCost.toFixed(2)}</span></div>
          <div className="flex justify-between"><span>Invisalign 成本</span><span>-${run.invisalignCost.toFixed(2)}</span></div>
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

      {/* Breakdown */}
      {run.breakdownJson && run.breakdownJson.length > 0 && (
        <Card className="p-4 mb-4">
          <h2 className="font-semibold mb-3">付款方式明細</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="py-1">方式</th>
                <th className="py-1 text-right">原始</th>
                <th className="py-1 text-right">費率</th>
                <th className="py-1 text-right">淨額</th>
              </tr>
            </thead>
            <tbody>
              {run.breakdownJson.map((b: any, i: number) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1">{b.method}</td>
                  <td className="py-1 text-right">${b.rawAmount?.toFixed(2)}</td>
                  <td className="py-1 text-right">{b.feePercentUsed}%</td>
                  <td className="py-1 text-right">${b.netAmount?.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="text-xs text-gray-400 mt-4">
        註：所有金額四捨五入至小數點後兩位，對數容差 $1。
      </div>
    </div>
  )
}
