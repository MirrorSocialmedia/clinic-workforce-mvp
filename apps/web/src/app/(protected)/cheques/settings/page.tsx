'use client'

// ============================================================
// ★ cwm-chequeprint-20261005：支票設定（只限老闆；API RBAC = OWNER）
//   出票戶口＋支票簿號碼＋用嘅診所；醫生／Lab 支票抬頭。員工抬頭用帳號管理嘅全名。
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-client'
import { BackButton } from '@/components/BackButton'

interface Account {
  id: string; label: string; bankName: string; accountLast4: string | null; layoutId: string | null
  bookFirstNo: number | null; bookLastNo: number | null; nextNo: number | null; noWidth: number; isActive: boolean
  nextNoText: string | null; remaining: number | null; clinicIds: string[]
}
interface Clinic { id: string; name: string; companyName: string; accountId: string | null }
interface Payee { id: string; name: string; payee: string }
interface Layout { id: string; name: string }
interface Settings { accounts: Account[]; clinics: Clinic[]; providers: Payee[]; labs: Payee[]; layouts: Layout[] }

type Draft = {
  id: string | null; label: string; bankName: string; accountLast4: string; layoutId: string
  bookFirstNo: string; bookLastNo: string; nextNo: string; noWidth: string; isActive: boolean; clinicIds: string[]
}

const toDraft = (a: Account | null, layoutId: string): Draft => a ? {
  id: a.id, label: a.label, bankName: a.bankName, accountLast4: a.accountLast4 ?? '', layoutId: a.layoutId ?? layoutId,
  bookFirstNo: a.bookFirstNo?.toString() ?? '', bookLastNo: a.bookLastNo?.toString() ?? '', nextNo: a.nextNo?.toString() ?? '',
  noWidth: String(a.noWidth), isActive: a.isActive, clinicIds: a.clinicIds,
} : { id: null, label: '', bankName: 'HSBC', accountLast4: '', layoutId, bookFirstNo: '', bookLastNo: '', nextNo: '', noWidth: '6', isActive: true, clinicIds: [] }

const bankLabel = (b: string) => (b === 'HSBC' ? '匯豐' : b)

export default function ChequeSettingsPage() {
  const [data, setData] = useState<Settings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await apiFetch<Settings>('/api/cheques/settings')) } catch (e: any) { setErr(e?.message || '載入失敗') }
  }, [])
  useEffect(() => { load() }, [load])

  const saveAccount = async () => {
    if (!draft) return
    setSaving(true); setMsg(null)
    try {
      const body = JSON.stringify({ ...draft, noWidth: Number(draft.noWidth) })
      if (draft.id) await apiFetch(`/api/cheques/accounts/${draft.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      else await apiFetch('/api/cheques/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      setDraft(null); setMsg('已儲存 ✓'); await load()
    } catch (e: any) { setMsg(e?.message || '儲存失敗') } finally { setSaving(false) }
  }

  const savePayee = async (kind: 'PROVIDER' | 'LAB', refId: string, payeeName: string) => {
    try {
      await apiFetch('/api/cheques/payees', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, refId, payeeName }) })
      setMsg('抬頭已儲存 ✓'); await load()
    } catch (e: any) { setMsg(e?.message || '儲存失敗') }
  }

  const clinicName = (id: string) => data?.clinics.find(c => c.id === id)?.name ?? ''
  const accountLabel = (id: string | null) => data?.accounts.find(a => a.id === id)?.label ?? ''

  return (
    <div className="p-6" style={{ maxWidth: 1100 }}>
      <BackButton to="/cheques" label="返回支票打印" />
      <div className="flex items-end justify-between flex-wrap gap-2 mb-4">
        <h1 className="text-2xl font-bold">支票設定</h1>
        <Link href="/cheques/printer" className="text-sm text-brand underline">打印機同版面校準 →</Link>
      </div>
      {err && <div className="text-sm text-red-600 mb-3">{err}</div>}
      {msg && <div className={`text-sm mb-3 ${msg.includes('✓') ? 'text-green-700' : 'text-red-600'}`}>{msg}</div>}

      <section className="border rounded-lg bg-white overflow-hidden mb-6">
        <div className="flex justify-between items-center px-4 py-3 border-b">
          <h2 className="font-semibold">出票戶口同支票簿</h2>
          <button type="button" onClick={() => setDraft(toDraft(null, data?.layouts[0]?.id ?? ''))} className="h-9 px-3 rounded-md border border-dashed text-sm text-brand">＋ 新增戶口</button>
        </div>
        <div className="hidden md:grid grid-cols-[1.2fr_0.6fr_0.7fr_1.6fr_0.8fr_1.6fr_60px] gap-3 px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-600">
          <span>戶口</span><span>銀行</span><span>尾 4 位</span><span>支票簿號碼</span><span>下一張</span><span>用嘅診所</span><span></span>
        </div>
        {data?.accounts.length === 0 && <div className="px-4 py-6 text-sm text-muted-foreground">未有戶口。每間診所嘅支票簿開一個戶口，再揀邊間診所用佢。</div>}
        {data?.accounts.map(a => (
          <div key={a.id} className={`grid grid-cols-1 md:grid-cols-[1.2fr_0.6fr_0.7fr_1.6fr_0.8fr_1.6fr_60px] gap-1 md:gap-3 px-4 py-3 border-t text-sm items-center ${a.isActive ? '' : 'opacity-50'}`}>
            <span className="font-medium">{a.label}{!a.isActive && '（停用）'}</span>
            <span>{bankLabel(a.bankName)}</span>
            <span className="font-mono">{a.accountLast4 ? `****${a.accountLast4}` : '—'}</span>
            <span className="font-mono">{a.bookFirstNo != null && a.bookLastNo != null ? `${String(a.bookFirstNo).padStart(a.noWidth, '0')} – ${String(a.bookLastNo).padStart(a.noWidth, '0')}` : '未設定'}</span>
            <span className="font-mono text-brand">{a.nextNoText ?? '—'}{a.remaining != null && <span className="text-xs text-muted-foreground font-sans">（剩 {a.remaining} 張）</span>}</span>
            <span className="text-slate-600">{a.clinicIds.map(clinicName).join('、') || <span className="text-amber-700">未揀診所</span>}</span>
            <button type="button" onClick={() => setDraft(toDraft(a, data.layouts[0]?.id ?? ''))} className="text-brand text-sm underline justify-self-start md:justify-self-end">修改</button>
          </div>
        ))}
      </section>

      {draft && data && (
        <section className="border-2 border-brand rounded-lg bg-white p-4 mb-6" aria-label="戶口表單">
          <h2 className="font-semibold mb-3">{draft.id ? `修改「${draft.label}」` : '新增戶口'}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Field label="戶口名稱"><input value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} placeholder="例：臻善 匯豐" className="border rounded px-2 py-1.5 w-full" /></Field>
            <Field label="銀行">
              <select value={draft.bankName} onChange={e => setDraft({ ...draft, bankName: e.target.value })} className="border rounded px-2 py-1.5 w-full bg-white">
                <option value="HSBC">匯豐</option>
              </select>
            </Field>
            <Field label="戶口號碼尾 4 位"><input value={draft.accountLast4} inputMode="numeric" maxLength={4} onChange={e => setDraft({ ...draft, accountLast4: e.target.value })} className="border rounded px-2 py-1.5 w-full font-mono" /></Field>
            <Field label="版面">
              <select value={draft.layoutId} onChange={e => setDraft({ ...draft, layoutId: e.target.value })} className="border rounded px-2 py-1.5 w-full bg-white">
                {data.layouts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="支票簿首張號碼"><input value={draft.bookFirstNo} inputMode="numeric" onChange={e => setDraft({ ...draft, bookFirstNo: e.target.value })} className="border rounded px-2 py-1.5 w-full font-mono" /></Field>
            <Field label="支票簿尾張號碼"><input value={draft.bookLastNo} inputMode="numeric" onChange={e => setDraft({ ...draft, bookLastNo: e.target.value })} className="border rounded px-2 py-1.5 w-full font-mono" /></Field>
            <Field label="下一張（實物支票最面嗰張）"><input value={draft.nextNo} inputMode="numeric" placeholder="留空 = 首張" onChange={e => setDraft({ ...draft, nextNo: e.target.value })} className="border rounded px-2 py-1.5 w-full font-mono" /></Field>
            <Field label="號碼位數"><input value={draft.noWidth} inputMode="numeric" onChange={e => setDraft({ ...draft, noWidth: e.target.value })} className="border rounded px-2 py-1.5 w-full font-mono" /></Field>
          </div>
          <div className="mt-4">
            <div className="text-sm font-medium mb-1">用呢本支票簿嘅診所</div>
            <div className="flex flex-wrap gap-2">
              {data.clinics.map(c => {
                const on = draft.clinicIds.includes(c.id)
                const elsewhere = c.accountId && c.accountId !== draft.id ? accountLabel(c.accountId) : null
                return (
                  <label key={c.id} className={`flex items-center gap-2 border rounded px-2 py-1 text-sm ${on ? 'border-brand bg-blue-50' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => setDraft({ ...draft, clinicIds: on ? draft.clinicIds.filter(x => x !== c.id) : [...draft.clinicIds, c.id] })} />
                    {c.name}{elsewhere && <span className="text-xs text-amber-700">（而家用「{elsewhere}」，揀咗會搬過嚟）</span>}
                  </label>
                )
              })}
            </div>
          </div>
          <label className="flex items-center gap-2 mt-3 text-sm">
            <input type="checkbox" checked={draft.isActive} onChange={e => setDraft({ ...draft, isActive: e.target.checked })} />啟用
          </label>
          <div className="flex justify-end gap-3 mt-4">
            <button type="button" onClick={() => setDraft(null)} className="h-10 px-4 rounded-md border text-sm">取消</button>
            <button type="button" onClick={saveAccount} disabled={saving} className="h-10 px-5 rounded-md bg-brand text-white text-sm font-semibold disabled:opacity-50">{saving ? '儲存中…' : '儲存戶口'}</button>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <PayeeList title="醫生支票抬頭" hint="例：DR CHAN TAI MAN 或者醫生公司名" list={data?.providers ?? []} onSave={(id, v) => savePayee('PROVIDER', id, v)} />
        <PayeeList title="Lab 支票抬頭" hint="公司註冊英文名（睇 Lab 月結單收款人）" list={data?.labs ?? []} onSave={(id, v) => savePayee('LAB', id, v)} />
      </div>
      <p className="text-sm text-muted-foreground mt-4">員工抬頭用「帳號管理」嘅全名；冇填全名嘅員工，打印中心會提示唔可以出票。</p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-xs text-slate-600">{label}{children}</label>
}

function PayeeList({ title, hint, list, onSave }: { title: string; hint: string; list: Payee[]; onSave: (id: string, v: string) => void }) {
  const [vals, setVals] = useState<Record<string, string>>({})
  useEffect(() => { setVals(Object.fromEntries(list.map(p => [p.id, p.payee]))) }, [list])
  return (
    <section className="border rounded-lg bg-white overflow-hidden">
      <h2 className="font-semibold px-4 py-3 border-b">{title}</h2>
      {list.length === 0 && <div className="px-4 py-4 text-sm text-muted-foreground">冇資料</div>}
      {list.map(p => {
        const v = vals[p.id] ?? ''
        const dirty = v.trim().toUpperCase() !== p.payee
        return (
          <div key={p.id} className="grid grid-cols-[110px_1fr_56px] gap-2 items-center px-4 py-2 border-t text-sm">
            <span>{p.name}</span>
            <input value={v} placeholder={hint} aria-label={`${p.name} 支票抬頭`}
              onChange={e => setVals({ ...vals, [p.id]: e.target.value })}
              className={`border rounded px-2 py-1 text-sm uppercase ${!p.payee ? 'border-amber-400' : ''}`} />
            <button type="button" disabled={!dirty} onClick={() => onSave(p.id, v)} className="text-sm text-brand disabled:text-slate-300">儲存</button>
          </div>
        )
      })}
    </section>
  )
}
