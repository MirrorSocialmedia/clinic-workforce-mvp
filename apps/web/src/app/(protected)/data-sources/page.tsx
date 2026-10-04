'use client'

// ============================================================
// ★ cwm-datasource-20261003：資料來源（Apricot 帳號）設定 —— OWNER only
//
// 每個來源一張卡：
//   ① 憑證狀態（正常／失效／未驗證…）＋「更新憑證」（貼 cookie）＋「測試連線」
//   ② 顯示名（員工搜尋時見到；留空 = 用診所名）、病人編號格式（排序用）
//   ③ 服務嘅診所：每間店嘅病人編號前綴、改歸屬
// 帳號代號（MAIN／TY…）係內部 key，只喺細字顯示俾老闆核對，員工永遠見唔到。
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, CheckCircle2, AlertTriangle, XCircle, KeyRound, PlugZap, Plus, Database } from 'lucide-react'
import { CODE_PATTERN_LABEL, type CodePattern } from '@/lib/apricot/source-pure'

interface SourceClinic { id: string; name: string; shortName: string | null; patientCodePrefix: string | null; effectivePrefixes: string[] }
interface Source {
  account: string
  displayName: string
  displayNameIsDefault: boolean
  patientCodePattern: CodePattern | null
  clinics: SourceClinic[]
  credential: {
    configured: boolean
    lastOkAt: string | null
    lastError: string | null
    refreshExpiry: string | null
    updatedAt: string | null
    health: { level: 'ok' | 'warn' | 'error'; code: string; text: string }
  }
}

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString('zh-HK', { hour12: false }) : '—')

function HealthBadge({ h }: { h: Source['credential']['health'] }) {
  const cls = h.level === 'ok' ? 'bg-green-50 text-green-700 border-green-200'
    : h.level === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-red-50 text-red-700 border-red-200'
  const Icon = h.level === 'ok' ? CheckCircle2 : h.level === 'warn' ? AlertTriangle : XCircle
  return <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${cls}`}><Icon size={12} />{h.text}</span>
}

export default function DataSourcesPage() {
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const d: any = await apiFetch('/api/apricot-sources')
      setSources(d.sources || [])
    } catch (e: any) {
      setLoadError(e?.message || '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  // 新增來源
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPattern, setNewPattern] = useState<CodePattern | ''>('')
  const addSource = async () => {
    try {
      await apiFetch('/api/apricot-sources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: newName, patientCodePattern: newPattern || null }),
      })
      setAdding(false); setNewName(''); setNewPattern('')
      await load()
    } catch (e: any) { alert(e?.message || '新增失敗') }
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Database size={20} /> 資料來源</h1>
          <p className="text-sm text-gray-500 mt-1">每個來源 = 一個 Apricot 登入。病人搜尋、收款同步、醫生時間表都經呢度嘅憑證讀資料。</p>
        </div>
        <Button variant="outline" onClick={() => setAdding(v => !v)}><Plus size={14} className="mr-1" />新增來源</Button>
      </div>

      {adding && (
        <Card className="p-4 space-y-3">
          <div className="text-sm font-medium">新增資料來源（接入另一個 Apricot 帳號）</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-sm space-y-1 block">
              <span className="text-gray-600">顯示名（員工見到）</span>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="例：沙田診所" maxLength={40} />
            </label>
            <label className="text-sm space-y-1 block">
              <span className="text-gray-600">病人編號格式</span>
              <PatternSelect value={newPattern} onChange={setNewPattern} />
            </label>
          </div>
          <p className="text-xs text-gray-500">新增之後：① 喺下面「更新憑證」貼入登入資料 ② 喺「診所管理」填店嘅 Apricot 診所 ID，再喺呢頁將店歸入呢個來源。</p>
          <div className="flex gap-2">
            <Button onClick={addSource} disabled={!newName.trim()}>新增</Button>
            <Button variant="outline" onClick={() => setAdding(false)}>取消</Button>
          </div>
        </Card>
      )}

      {loading && <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={16} className="animate-spin" />載入中…</div>}
      {loadError && <div className="text-sm text-red-600">{loadError}</div>}
      {sources.map(s => <SourceCard key={`${s.account}:${s.displayNameIsDefault ? '' : s.displayName}:${s.patientCodePattern ?? ''}`} source={s} all={sources} onChanged={load} />)}

      <Card className="p-4 text-sm text-gray-600 space-y-1">
        <div className="font-medium text-gray-800">點樣攞憑證（每個來源做一次）</div>
        <ol className="list-decimal pl-5 space-y-0.5">
          <li>開一個<b>無痕／私密視窗</b>（每個 Apricot 帳號各開一個，就唔會兩個帳號互相踢走）</li>
          <li>喺嗰個視窗登入 Apricot，隨便開一頁（例如病人搜尋）</li>
          <li>按 F12 → Network（網絡）→ 撳任何一個 request → 右掣 Copy → <b>Copy request headers</b></li>
          <li>返嚟呢頁撳「更新憑證」，成段貼入去 → 儲存（系統會即刻測試）</li>
          <li><b>直接閂咗個無痕視窗，唔好撳登出</b>，之後亦唔好再用嗰個登入 —— 系統同瀏覽器共用同一條登入，瀏覽器繼續用或者登出，系統嗰份就會失效</li>
        </ol>
        <div className="text-xs text-gray-500 pt-1">平時自己用 Apricot 請用另一個瀏覽器／另一個帳號登入，唔好用交咗俾系統嗰個 session。</div>
      </Card>
    </div>
  )
}

function PatternSelect({ value, onChange }: { value: CodePattern | ''; onChange: (v: CodePattern | '') => void }) {
  return (
    <select className="w-full border rounded-md h-9 px-2 text-sm bg-white" value={value} onChange={e => onChange(e.target.value as CodePattern | '')}>
      <option value="">不限</option>
      {(Object.keys(CODE_PATTERN_LABEL) as CodePattern[]).map(k => <option key={k} value={k}>{CODE_PATTERN_LABEL[k]}</option>)}
    </select>
  )
}

function SourceCard({ source: s, all, onChanged }: { source: Source; all: Source[]; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(s.displayNameIsDefault ? '' : s.displayName)
  const [pattern, setPattern] = useState<CodePattern | ''>(s.patientCodePattern ?? '')
  const [savingMeta, setSavingMeta] = useState(false)
  const metaDirty = name.trim() !== (s.displayNameIsDefault ? '' : s.displayName) || (pattern || null) !== s.patientCodePattern

  const [credOpen, setCredOpen] = useState(false)
  const [cookie, setCookie] = useState('')
  const [credBusy, setCredBusy] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const saveMeta = async () => {
    setSavingMeta(true)
    try {
      await apiFetch('/api/apricot-sources', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: s.account, displayName: name, patientCodePattern: pattern || null }),
      })
      await onChanged()
    } catch (e: any) { alert(e?.message || '儲存失敗') } finally { setSavingMeta(false) }
  }

  const saveCred = async () => {
    setCredBusy(true); setMsg(null)
    try {
      const d: any = await apiFetch('/api/apricot-sources/credential', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: s.account, cookie }),
      })
      setCookie(''); setCredOpen(false)
      setMsg({ ok: d.test.ok, text: d.test.ok ? '已儲存，連線成功 ✓ 可以閂咗個無痕視窗（唔好登出）' : `已儲存，但測試失敗：${d.test.text}` })
      await onChanged()
    } catch (e: any) { setMsg({ ok: false, text: e?.message || '儲存失敗' }) } finally { setCredBusy(false) }
  }

  const test = async () => {
    setTestBusy(true); setMsg(null)
    try {
      const d: any = await apiFetch('/api/apricot-sources/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: s.account }),
      })
      setMsg({ ok: d.ok, text: d.text })
      await onChanged()
    } catch (e: any) { setMsg({ ok: false, text: e?.message || '測試失敗' }) } finally { setTestBusy(false) }
  }

  const c = s.credential
  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-semibold text-base">{s.displayName}</div>
          <div className="text-[11px] text-gray-400">內部代號 {s.account}</div>
        </div>
        <HealthBadge h={c.health} />
      </div>

      {/* ① 憑證 */}
      <section className="space-y-2">
        <div className="text-xs text-gray-500 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
          <span>上次成功連線：{fmt(c.lastOkAt)}</span>
          <span>登入有效至：{fmt(c.refreshExpiry)}</span>
          <span>憑證更新：{fmt(c.updatedAt)}</span>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant={c.health.level === 'error' ? 'default' : 'outline'} onClick={() => setCredOpen(v => !v)}>
            <KeyRound size={14} className="mr-1" />更新憑證
          </Button>
          <Button size="sm" variant="outline" onClick={test} disabled={testBusy || !c.configured}>
            {testBusy ? <Loader2 size={14} className="mr-1 animate-spin" /> : <PlugZap size={14} className="mr-1" />}測試連線
          </Button>
        </div>
        {credOpen && (
          <div className="space-y-2 border rounded-md p-3 bg-slate-50">
            <div className="text-xs text-gray-600">貼入「Copy request headers」成段文字（或者 Cookies 表嘅 access_token／refresh_token／iat 三行）。內容會加密儲存，唔會顯示返出嚟。</div>
            <textarea
              className="w-full h-28 border rounded-md p-2 text-xs font-mono bg-white"
              value={cookie} onChange={e => setCookie(e.target.value)}
              placeholder={'cookie: access_token=…; refresh_token=…; iat=…'}
              autoComplete="off" spellCheck={false}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={saveCred} disabled={credBusy || !cookie.trim()}>
                {credBusy && <Loader2 size={14} className="mr-1 animate-spin" />}儲存並測試
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setCredOpen(false); setCookie('') }}>取消</Button>
            </div>
          </div>
        )}
        {msg && <div className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
      </section>

      {/* ② 顯示名／編號格式 */}
      <section className="grid sm:grid-cols-2 gap-3">
        <label className="text-sm space-y-1 block">
          <span className="text-gray-600">顯示名（員工搜尋病人時見到）</span>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder={s.displayNameIsDefault ? s.displayName : '留空 = 用診所名'} maxLength={40} />
        </label>
        <label className="text-sm space-y-1 block">
          <span className="text-gray-600">病人編號格式（格式吻合嘅來源排前）</span>
          <PatternSelect value={pattern} onChange={setPattern} />
        </label>
        {metaDirty && (
          <div className="sm:col-span-2">
            <Button size="sm" onClick={saveMeta} disabled={savingMeta}>{savingMeta && <Loader2 size={14} className="mr-1 animate-spin" />}儲存</Button>
          </div>
        )}
      </section>

      {/* ③ 服務診所 */}
      <section>
        <div className="text-sm text-gray-600 mb-1">服務嘅診所</div>
        {s.clinics.length === 0
          ? <div className="text-sm text-gray-400">未有診所（喺「診所管理」填 Apricot 診所 ID，再喺下面揀返呢個來源）</div>
          : (
            <div className="border rounded-md divide-y">
              {s.clinics.map(cl => <ClinicRow key={`${cl.id}:${cl.patientCodePrefix ?? ''}`} clinic={cl} account={s.account} all={all} onChanged={onChanged} />)}
            </div>
          )}
      </section>
    </Card>
  )
}

function ClinicRow({ clinic, account, all, onChanged }: { clinic: SourceClinic; account: string; all: Source[]; onChanged: () => Promise<void> }) {
  const [prefix, setPrefix] = useState(clinic.patientCodePrefix ?? '')
  const [busy, setBusy] = useState(false)
  const dirty = prefix.trim().toUpperCase() !== (clinic.patientCodePrefix ?? '')

  const put = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      await apiFetch('/api/apricot-sources/clinic', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clinicId: clinic.id, ...body }),
      })
      await onChanged()
    } catch (e: any) { alert(e?.message || '儲存失敗') } finally { setBusy(false) }
  }

  const move = (to: string) => {
    if (to === account) return
    const target = all.find(x => x.account === to)
    if (!confirm(`將「${clinic.name}」改歸「${target?.displayName ?? to}」？\n\n之後呢間店嘅收款同步、醫生時間表、預約都會用嗰個來源嘅登入。請確定呢間店喺嗰個 Apricot 帳號入面。`)) return
    put({ account: to })
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 flex-wrap text-sm">
      <div className="w-28 font-medium">{clinic.name}</div>
      <div className="flex items-center gap-1">
        <span className="text-xs text-gray-500">編號前綴</span>
        <Input className="h-8 w-28 text-xs" value={prefix} onChange={e => setPrefix(e.target.value)}
          placeholder={/^[A-Za-z]{1,6}$/.test(clinic.shortName ?? '') ? `預設 ${clinic.shortName!.toUpperCase()}` : '例：TW'} />
        {dirty && <Button size="sm" className="h-8" disabled={busy} onClick={() => put({ patientCodePrefix: prefix })}>儲存</Button>}
      </div>
      <div className="text-xs text-gray-400 flex-1 min-w-[8rem]">
        {clinic.effectivePrefixes.length ? `推斷用：${clinic.effectivePrefixes.join('、')}` : '冇前綴（純數字編號）'}
      </div>
      {all.length > 1 && (
        <select className="border rounded-md h-8 px-2 text-xs bg-white" value={account} disabled={busy} onChange={e => move(e.target.value)}>
          {all.map(x => <option key={x.account} value={x.account}>{x.displayName}</option>)}
        </select>
      )}
    </div>
  )
}
