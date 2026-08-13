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
import { Loader2, Plus, Edit, Save, X } from 'lucide-react'
import { toast } from 'sonner'

interface Rule {
  id: string
  method: string
  label: string
  feePercent: number
  countAsIncome: boolean
  effectiveFrom: string
  effectiveTo: string | null
  createdBy: string
}

export default function PaymentMethodsPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [form, setForm] = useState({
    method: '',
    label: '',
    feePercent: 0,
    countAsIncome: true,
    effectiveFrom: '2026-01-01',
    effectiveTo: '',
  })

  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch('/api/payment-method-rules', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setRules(data.rules || [])
    } catch (e: any) {
      toast.error(`載入規則失敗: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRules()
  }, [fetchRules])

  const openCreate = () => {
    setEditing(null)
    setForm({ method: '', label: '', feePercent: 0, countAsIncome: true, effectiveFrom: '2026-01-01', effectiveTo: '' })
    setOpen(true)
  }

  const openEdit = (rule: Rule) => {
    setEditing(rule)
    setForm({
      method: rule.method,
      label: rule.label,
      feePercent: rule.feePercent,
      countAsIncome: rule.countAsIncome,
      effectiveFrom: rule.effectiveFrom?.slice(0, 10) || '2026-01-01',
      effectiveTo: rule.effectiveTo?.slice(0, 10) || '',
    })
    setOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.method || !form.label) {
      toast.error('Method 同 Label 必填')
      return
    }

    try {
      const res = await fetch('/api/payment-method-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: editing?.id,
          method: form.method,
          label: form.label,
          feePercent: form.feePercent,
          countAsIncome: form.countAsIncome,
          effectiveFrom: `${form.effectiveFrom}T00:00:00+08:00`,
          effectiveTo: form.effectiveTo ? `${form.effectiveTo}T23:59:59+08:00` : null,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      toast.success(editing ? '規則已更新' : '新規則已建立')
      setOpen(false)
      fetchRules()
    } catch (e: any) {
      toast.error(`提交失敗: ${e.message}`)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[200px]">
        <Loader2 className="animate-spin text-gray-400" size={24} />
      </div>
    )
  }

  // Group rules by method — show only latest effective rule per method
  const methodMap = new Map<string, Rule>()
  for (const r of rules) {
    const existing = methodMap.get(r.method)
    if (!existing || new Date(r.effectiveFrom) > new Date(existing.effectiveFrom)) {
      methodMap.set(r.method, r)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">付款方式規則</h1>
          <p className="text-sm text-gray-500 mt-1">設定每種付款方式的費率同是否計入收入</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="gap-2">
              <Plus size={16} />
              新增規則
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? '編輯規則' : '新增規則'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div>
                <Label>Method</Label>
                <Input
                  value={form.method}
                  onChange={e => setForm({ ...form, method: e.target.value })}
                  placeholder="e.g. AMEX, UNIONPAY, WECHAT"
                  disabled={!!editing} // method can't be changed on edit
                />
              </div>
              <div>
                <Label>Label</Label>
                <Input
                  value={form.label}
                  onChange={e => setForm({ ...form, label: e.target.value })}
                  placeholder="e.g. American Express"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Fee %</Label>
                  <Input
                    type="number"
                    step="0.001"
                    value={form.feePercent}
                    onChange={e => setForm({ ...form, feePercent: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div>
                  <Label>Count as Income</Label>
                  <select
                    value={form.countAsIncome ? 'true' : 'false'}
                    onChange={e => setForm({ ...form, countAsIncome: e.target.value === 'true' })}
                    className="w-full px-3 py-2 border rounded-md text-sm"
                  >
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Effective From</Label>
                  <Input
                    type="date"
                    value={form.effectiveFrom}
                    onChange={e => setForm({ ...form, effectiveFrom: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Effective To (optional)</Label>
                  <Input
                    type="date"
                    value={form.effectiveTo}
                    onChange={e => setForm({ ...form, effectiveTo: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setOpen(false)} className="gap-1">
                  <X size={14} />
                  取消
                </Button>
                <Button onClick={handleSubmit} className="gap-1">
                  <Save size={14} />
                  {editing ? '更新' : '建立'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Method</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Fee %</TableHead>
                <TableHead>計收入</TableHead>
                <TableHead>生效日</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from(methodMap.values()).map(rule => {
                const isExpired = rule.effectiveTo && new Date(rule.effectiveTo) < new Date()
                return (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium">{rule.method}</TableCell>
                    <TableCell>{rule.label}</TableCell>
                    <TableCell>{rule.feePercent.toFixed(1)}%</TableCell>
                    <TableCell>
                      {rule.countAsIncome ? (
                        <Badge variant="secondary" className="text-green-700 bg-green-50">✓</Badge>
                      ) : (
                        <Badge variant="outline" className="text-gray-500">✗</Badge>
                      )}
                    </TableCell>
                    <TableCell>{rule.effectiveFrom?.slice(0, 10)}</TableCell>
                    <TableCell>
                      {isExpired ? (
                        <Badge variant="outline" className="text-red-600">已過期</Badge>
                      ) : rule.effectiveTo ? (
                        <Badge variant="secondary">至 {rule.effectiveTo.slice(0, 10)}</Badge>
                      ) : (
                        <Badge variant="default" className="text-green-700 bg-green-50">生效中</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(rule)}
                        className="gap-1 h-7 px-2"
                      >
                        <Edit size={14} />
                        編輯
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {methodMap.size === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-400 py-8">
                    未有規則，點擊右上角新增
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="text-xs text-gray-400">
        <p>★ AMEX / UNIONPAY / WECHAT / PAYME 預設唔 seed，需要手動設定費率。</p>
        <p>★ feePercent = 0 表示無手續費；countAsIncome = false 表示唔計入收入（如 CREDIT、FREE_SP）。</p>
      </div>
    </div>
  )
}
