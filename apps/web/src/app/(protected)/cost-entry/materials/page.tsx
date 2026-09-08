'use client'

import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import { toHKDateStr, todayHK } from '@/lib/hk-date'
import { Card } from '@/components/ui/card'
import { Plus, Loader2 } from 'lucide-react'

type RowItem = {
  id: string
  name: string
  unitPrice: number | null
  effectiveFrom: string
  effectiveTo: string | null
  isActive: boolean
}

export default function MaterialsPage() {
  const [items, setItems] = useState<RowItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])

  // Create modal
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ name: '', unitPrice: '', effectiveFrom: new Date().toISOString().slice(0, 10) })
  const [saving, setSaving] = useState(false)

  // ★ 2026-08-28 (cwm-matedit-t1): 改價 / 更名 / 停用 状態
  const [priceTarget, setPriceTarget] = useState<RowItem | null>(null)
  const [priceForm, setPriceForm] = useState({ unitPrice: '', effectiveFrom: '' })
  const [renameTarget, setRenameTarget] = useState<RowItem | null>(null)
  const [renameForm, setRenameForm] = useState({ newName: '' })
  const [rowBusy, setRowBusy] = useState('')

  // ★ cwm-payoutcost-20260908 B1：改日期
  const [dateTarget, setDateTarget] = useState<RowItem | null>(null)
  const [dateForm, setDateForm] = useState({ effectiveFrom: '', effectiveTo: '' })

  // 新增 / 改價 / 更名 / 停用 同一權限門（provider_payout = OWNER）
  const canEdit = userRole ? hasPermission(userRole, 'provider_payout', grant, deny) : false

  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      // ★ ?all=1 → 版本鏈全部行（active + inactive）；新增材料下拉仍用預設 GET（只回當前生效）
      const data: any = await apiFetch('/api/material-items?all=1')
      setItems(data.allRecords || [])
    } catch (e) {
      console.error('[materials] load materials failed', e)
      setLoadError('材料清單載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadAuth = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/me')
      setUserRole(data.user?.role || '')
      // ★ 2026-08-22：/api/me 已經 parse 好，直接回 user.grant / user.deny
      //   （permissionsJson 喺 route.ts:24 被剷走，讀佢永遠 undefined）
      setGrant(data.user?.grant ?? [])
      setDeny(data.user?.deny ?? [])
    } catch (e) {
      console.error('[materials] load auth failed', e)
      setLoadError('權限載入失敗')
    }
  }, [])

  useEffect(() => {
    loadAuth()
    loadItems()
  }, [loadAuth, loadItems])

  const handleSubmit = async () => {
    if (!form.name || !form.unitPrice || !form.effectiveFrom) {
      alert('名稱、單價、生效日為必填')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/api/material-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          unitPrice: Number(form.unitPrice),
          effectiveFrom: form.effectiveFrom,
        }),
      })

      setModalOpen(false)
      setForm({ name: '', unitPrice: '', effectiveFrom: new Date().toISOString().slice(0, 10) })
      loadItems()
    } catch (e: any) {
      alert(`新增失敗: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // —— ★ 改價：POST 新版本（同名），auto-close 封舊版；舊版保留，歷史個案唔受影響
  const openPriceModal = (item: RowItem) => {
    setPriceTarget(item)
    setPriceForm({
      unitPrice: item.unitPrice != null ? String(item.unitPrice) : '',
      effectiveFrom: todayHK(),
    })
  }

  const submitPrice = async () => {
    if (!priceTarget) return
    if (!priceForm.unitPrice || !priceForm.effectiveFrom) {
      alert('單價、生效日為必填')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/api/material-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: priceTarget.name,
          unitPrice: Number(priceForm.unitPrice),
          effectiveFrom: priceForm.effectiveFrom,
        }),
      })
      setPriceTarget(null)
      loadItems()
    } catch (e: any) {
      alert(`改價失敗: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // —— ★ 更名：兩步 — ① 停用舊版 ② 新名新增（舊價、今日生效）
  //   絕不 UPDATE name（implant resolve 靠 name、匯出靠 id 反查）
  const openRenameModal = (item: RowItem) => {
    setRenameTarget(item)
    setRenameForm({ newName: item.name })
  }

  const submitRename = async () => {
    if (!renameTarget) return
    const newName = renameForm.newName.trim()
    if (!newName) {
      alert('請輸入新名稱')
      return
    }
    if (newName === renameTarget.name) {
      alert('新名稱同而家一樣，唔使改')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/material-items/${renameTarget.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      })
      await apiFetch('/api/material-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          unitPrice: renameTarget.unitPrice,
          effectiveFrom: todayHK(),
        }),
      })
      setRenameTarget(null)
      loadItems()
    } catch (e: any) {
      alert(`更名失敗: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // —— ★ B1：改生效日 / 到期日（唔開新版本，直接改呢一版嘅日期）
  const openDateModal = (item: RowItem) => {
    setDateTarget(item)
    setDateForm({
      effectiveFrom: toHKDateStr(item.effectiveFrom),
      effectiveTo: item.effectiveTo ? toHKDateStr(item.effectiveTo) : '',
    })
  }

  const submitDate = async () => {
    if (!dateTarget) return
    if (!dateForm.effectiveFrom) { alert('生效日必填'); return }
    setSaving(true)
    try {
      await apiFetch(`/api/material-items/${dateTarget.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effectiveFrom: dateForm.effectiveFrom,
          // ★ 空字串一定要轉 null —— 傳 '' 落去 `new Date('')` = Invalid Date → 400
          effectiveTo: dateForm.effectiveTo || null,
        }),
      })
      setDateTarget(null)
      loadItems()
    } catch (e: any) {
      alert(`改日期失敗: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // —— ★ 停用 / 啟用：淨改 isActive，版本鏈記錄原封不動
  const toggleActive = async (item: RowItem) => {
    if (item.isActive && !confirm(
      `確認停用「${item.name}」？\n\n` +
      `停用後唔會再出現喺新增下拉，已錄入個案唔受影響。\n` +
      `⚠️ 停用最新版本【唔會】自動恢復上一版 —— 上一版嘅到期日仍然封住，` +
      `可能令呢隻材料變成【冇任何版本可用】。要救就用「改日期」。`
    )) return
    setRowBusy(item.id)
    try {
      await apiFetch(`/api/material-items/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !item.isActive }),
      })
      loadItems()
    } catch (e: any) {
      alert(`${item.isActive ? '停用' : '啟用'}失敗: ${e.message}`)
    } finally {
      setRowBusy('')
    }
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={24} /></div>
  }

  return (
    <div className="p-6 space-y-4">
      {loadError && (
        <div className="text-red-500 text-sm p-2 bg-red-50 rounded">{loadError}</div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">材料主檔</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">★ 改價／更名會保留舊版本（版本鏈）；已錄入個案唔受影響</span>
          <a href="/cost-entry" className="text-sm text-blue-600 hover:underline">← 返回成本錄入</a>
        </div>
      </div>

      {!canEdit && (
        <Card className="p-3 bg-yellow-50 text-yellow-700 text-sm">
          ⚠️ 新增／改價／更名／停用材料需要 OWNER 權限
        </Card>
      )}

      <div className="flex justify-end">
        {canEdit && (
          <button onClick={() => setModalOpen(true)}
            className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 flex items-center gap-1">
            <Plus size={14} /> 新增材料
          </button>
        )}
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-2">名稱</th>
              <th className="text-right p-2">單價</th>
              <th className="text-left p-2">生效日</th>
              <th className="text-left p-2">到期日</th>
              <th className="text-left p-2">狀態</th>
              {canEdit && <th className="text-left p-2">操作</th>}
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className={`border-b hover:bg-gray-50 ${!item.isActive ? 'opacity-60' : ''}`}>
                <td className="p-2 font-medium">{item.name}</td>
                <td className="p-2 text-right font-mono">{item.unitPrice != null ? `$${Number(item.unitPrice).toFixed(2)}` : '—'}</td>
                <td className="p-2">{new Date(item.effectiveFrom).toLocaleDateString('zh-HK')}</td>
                <td className="p-2">{item.effectiveTo ? new Date(item.effectiveTo).toLocaleDateString('zh-HK') : '—'}</td>
                <td className="p-2">
                  {(() => {
                    const expired = item.isActive && item.effectiveTo && new Date(item.effectiveTo) < new Date()
                    return (
                      <span className={`text-xs px-2 py-0.5 rounded ${!item.isActive ? 'bg-gray-100 text-gray-500' : expired ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                        {!item.isActive ? '已停用' : expired ? '已到期' : '有效'}
                      </span>
                    )
                  })()}
                </td>
                {canEdit && (
                  <td className="p-2">
                    <div className="flex gap-1">
                      {item.isActive ? (
                        <>
                          <button onClick={() => openPriceModal(item)} disabled={rowBusy === item.id || saving}
                            className="px-2 py-0.5 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50">
                            改價
                          </button>
                          <button onClick={() => openRenameModal(item)} disabled={rowBusy === item.id || saving}
                            className="px-2 py-0.5 text-xs border border-purple-300 text-purple-700 rounded hover:bg-purple-50 disabled:opacity-50">
                            更名
                          </button>
                          <button onClick={() => openDateModal(item)} disabled={rowBusy === item.id || saving}
                            className="px-2 py-0.5 text-xs border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50">
                            改日期
                          </button>
                          <button onClick={() => toggleActive(item)} disabled={rowBusy === item.id}
                            className="px-2 py-0.5 text-xs border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50">
                            停用
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => openDateModal(item)} disabled={rowBusy === item.id || saving}
                            className="px-2 py-0.5 text-xs border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50">
                            改日期
                          </button>
                          <button onClick={() => toggleActive(item)} disabled={rowBusy === item.id}
                            className="px-2 py-0.5 text-xs border border-green-300 text-green-700 rounded hover:bg-green-50 disabled:opacity-50">
                            啟用
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={canEdit ? 6 : 5} className="p-8 text-center text-gray-400">暫無材料記錄</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Create Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">新增材料項目</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">名稱 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="材料名稱" />
              </div>
              <div>
                <label className="block text-sm mb-1">單價 *</label>
                <input type="number" step="0.01" value={form.unitPrice} onChange={e => setForm({ ...form, unitPrice: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="單價" />
              </div>
              <div>
                <label className="block text-sm mb-1">生效日 *</label>
                <input type="date" value={form.effectiveFrom} onChange={e => setForm({ ...form, effectiveFrom: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setModalOpen(false)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={handleSubmit} disabled={saving}
                className="px-4 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50 flex items-center gap-1">
                {saving && <Loader2 size={14} className="animate-spin" />} 確定
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* ★ 改價 Modal — 舊版本保留，新版本由生效日開始 */}
      {priceTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">改價 — {priceTarget.name}</h2>
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
              改價會保留舊版本（{toHKDateStr(priceTarget.effectiveFrom)} 起${priceTarget.unitPrice != null ? ' $' + Number(priceTarget.unitPrice).toFixed(2) : '，冇定價'}），
              由生效日起用新價。已錄入嘅個案唔會受影響。
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">名稱</label>
                <input value={priceTarget.name} readOnly
                  className="w-full border rounded px-2 py-1.5 text-sm bg-gray-50 text-gray-500 cursor-not-allowed" />
              </div>
              <div>
                <label className="block text-sm mb-1">新單價 *</label>
                <input type="number" step="0.01" value={priceForm.unitPrice} onChange={e => setPriceForm({ ...priceForm, unitPrice: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="新單價" />
              </div>
              <div>
                <label className="block text-sm mb-1">生效日 *</label>
                <input type="date" value={priceForm.effectiveFrom} onChange={e => setPriceForm({ ...priceForm, effectiveFrom: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setPriceTarget(null)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={submitPrice} disabled={saving}
                className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                {saving && <Loader2 size={14} className="animate-spin" />} 確定改價
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* ★ B1 改日期 Modal — 只改呢一版嘅日期，唔開新版本 */}
      {dateTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">改日期 — {dateTarget.name}</h2>
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
              改日期<strong>唔會</strong>開新版本，係直接改呢一版嘅生效範圍。
              已錄入嘅個案用緊快照單價，唔會受影響；只影響之後新錄入／補錄嘅個案 resolve 邊個版本。
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">名稱</label>
                <input value={dateTarget.name} readOnly
                  className="w-full border rounded px-2 py-1.5 text-sm bg-gray-50 text-gray-500 cursor-not-allowed" />
              </div>
              <div>
                <label className="block text-sm mb-1">生效日 *</label>
                <input type="date" value={dateForm.effectiveFrom}
                  onChange={e => setDateForm({ ...dateForm, effectiveFrom: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-sm mb-1">到期日 <span className="text-xs text-gray-400">（留空＝無限期）</span></label>
                <input type="date" value={dateForm.effectiveTo}
                  onChange={e => setDateForm({ ...dateForm, effectiveTo: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setDateTarget(null)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={submitDate} disabled={saving}
                className="px-4 py-1.5 bg-gray-700 text-white rounded text-sm hover:bg-gray-800 disabled:opacity-50 flex items-center gap-1">
                {saving && <Loader2 size={14} className="animate-spin" />} 確定
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* ★ 更名 Modal — 停用舊版 + 新名新增；歷史個案保留舊名 */}
      {renameTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">更名 — {renameTarget.name}</h2>
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
              更名會停用舊嘅，歷史個案保留舊名。
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">舊名稱</label>
                <input value={renameTarget.name} readOnly
                  className="w-full border rounded px-2 py-1.5 text-sm bg-gray-50 text-gray-500 cursor-not-allowed" />
              </div>
              <div>
                <label className="block text-sm mb-1">新名稱 *</label>
                <input value={renameForm.newName} onChange={e => setRenameForm({ ...renameForm, newName: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="新名稱" />
              </div>
              <div className="text-xs text-gray-500">
                單價${renameTarget.unitPrice != null ? ' $' + Number(renameTarget.unitPrice).toFixed(2) : '（冇定價）'}將沿用，今日生效。
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setRenameTarget(null)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={submitRename} disabled={saving}
                className="px-4 py-1.5 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50 flex items-center gap-1">
                {saving && <Loader2 size={14} className="animate-spin" />} 確定更名
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
