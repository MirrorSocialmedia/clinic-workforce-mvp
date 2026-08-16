'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Loader2, Plus, Edit, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api-client'

interface FeeItemPrice {
  id: string
  feeItemCode: string
  label: string
  listPrice: number
  effectiveFrom: string
  effectiveTo: string | null
  createdBy: string
}

export default function FeeItemPricesPage() {
  const [items, setItems] = useState<FeeItemPrice[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<FeeItemPrice | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    feeItemCode: '',
    label: '',
    listPrice: 0,
    effectiveFrom: '2026-01-01',
    effectiveTo: '',
  })

  const fetchItems = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/fee-item-list-prices')
      setItems(data.items || [])
    } catch (e: any) {
      toast.error(`載入標準價失敗: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  const openCreate = () => {
    setEditing(null)
    setForm({ feeItemCode: '', label: '', listPrice: 0, effectiveFrom: '2026-01-01', effectiveTo: '' })
    setOpen(true)
  }

  const openEdit = (item: FeeItemPrice) => {
    setEditing(item)
    setForm({
      feeItemCode: item.feeItemCode,
      label: item.label,
      listPrice: item.listPrice,
      effectiveFrom: item.effectiveFrom?.slice(0, 10) || '2026-01-01',
      effectiveTo: item.effectiveTo?.slice(0, 10) || '',
    })
    setOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.feeItemCode || !form.label || form.listPrice <= 0 || !form.effectiveFrom) {
      toast.error('feeItemCode、label、listPrice、effectiveFrom 為必填')
      return
    }
    setSaving(true)
    try {
      const body = {
        feeItemCode: form.feeItemCode,
        label: form.label,
        listPrice: Number(form.listPrice),
        effectiveFrom: form.effectiveFrom,
        effectiveTo: form.effectiveTo || null,
      }

      if (editing) {
        await apiFetch(`/api/fee-item-list-prices/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        toast.success('已更新')
      } else {
        await apiFetch('/api/fee-item-list-prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        toast.success('已新增')
      }

      setOpen(false)
      fetchItems()
    } catch (e: any) {
      toast.error(`儲存失敗: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const hasSpSeed = items.some(i => /sp580/i.test(i.feeItemCode))

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">標準價目表</h1>
          <p className="text-sm text-gray-500 mt-1">
            用於 SP 補貼計算 — 每個 feeItemCode 對應一個標準原價
          </p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus size={14} /> 新增
        </Button>
      </div>

      {/* SP 580 提示 */}
      {!hasSpSeed && (
        <Card className="p-3 bg-amber-50 border-amber-200">
          <div className="flex items-center gap-2 text-sm text-amber-800">
            <AlertTriangle size={14} />
            <span>
              SP 580 標準價尚未設定。請新增一條記錄：
              <code className="mx-1 bg-amber-100 px-1 rounded">feeItemCode=SP580</code>
              、<code className="mx-1 bg-amber-100 px-1 rounded">label=SCALING &amp; POLISHING</code>
              、<code className="mx-1 bg-amber-100 px-1 rounded">listPrice=580.00</code>
            </span>
          </div>
        </Card>
      )}

      {/* Table */}
      <Card>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={24} /></div>
        ) : items.length === 0 ? (
          <div className="text-center py-8 text-sm text-gray-400">
            尚未設定標準價
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>feeItemCode</TableHead>
                <TableHead>名稱</TableHead>
                <TableHead className="text-right">標準價</TableHead>
                <TableHead>生效日期</TableHead>
                <TableHead>失效日期</TableHead>
                <TableHead className="w-24">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map(item => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono text-sm">{item.feeItemCode}</TableCell>
                  <TableCell>{item.label}</TableCell>
                  <TableCell className="text-right">${item.listPrice.toFixed(2)}</TableCell>
                  <TableCell>{item.effectiveFrom}</TableCell>
                  <TableCell>{item.effectiveTo || '—'}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(item)}>
                        <Edit size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? '編輯標準價' : '新增標準價'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Fee Item Code</Label>
              <Input
                value={form.feeItemCode}
                onChange={e => setForm({ ...form, feeItemCode: e.target.value })}
                placeholder="如 SP580"
              />
              {!editing && (
                <p className="text-xs text-gray-400 mt-1">
                  對應 Apricot 帳單項目嘅 feeItem.code
                </p>
              )}
            </div>
            <div>
              <Label>名稱</Label>
              <Input
                value={form.label}
                onChange={e => setForm({ ...form, label: e.target.value })}
                placeholder="SCALING &amp; POLISHING"
              />
            </div>
            <div>
              <Label>標準價</Label>
              <Input
                type="number"
                step="0.01"
                value={form.listPrice || ''}
                onChange={e => setForm({ ...form, listPrice: Number(e.target.value) })}
                placeholder="580.00"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>生效日期</Label>
                <Input
                  type="date"
                  value={form.effectiveFrom}
                  onChange={e => setForm({ ...form, effectiveFrom: e.target.value })}
                />
              </div>
              <div>
                <Label>失效日期</Label>
                <Input
                  type="date"
                  value={form.effectiveTo}
                  onChange={e => setForm({ ...form, effectiveTo: e.target.value })}
                  placeholder="留空 = 永久"
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 size={14} className="animate-spin mr-1" />}
              {editing ? '儲存' : '新增'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
