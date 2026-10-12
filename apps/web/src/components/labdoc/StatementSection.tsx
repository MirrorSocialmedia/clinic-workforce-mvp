'use client'

/**
 * ★ cwm-labdoc：/lab-docs/statements/[id]/sections/[sid] — 分段對數
 *
 * 2026-10-11 改：同「成本錄入」對總數（唔使準確到病人；invoice 先逐個病人對）。
 * - 頂：月結單（唔計備貨／唔關我哋事）｜成本錄入｜差額
 * - 左：月結單行（冇印數量 → 金額 ÷ 單價）；每行可以標「備貨」／「唔關我哋事」；成段都係備貨有一鍵
 * - 右：成本錄入（同 Lab、同診所、同醫生、到貨日喺同月）
 * - 按金額劃埋（一筆成本 = 一行或者連續幾行）只係幫你搵差異，唔影響狀態
 * - 2026-10-11：劃唔到 → 「手動配對成本」（揀幾行配一筆成本，要啱數）；劃錯 → 「未配對到」拆開
 * - 2026-10-11：$0 行預設摺埋；「計入下個月」（本月唔計，下個月自動帶入「上月結轉」，單號重複唔計兩次）
 * - 確認：一致直接確認；有差異要寫原因
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api-client'
import { fmtMoney } from './status-meta'
import { SECTION_STATUS, type StmtLine, type StmtResp } from './StatementDetail'
import { combineSection } from './combine-action'

interface CostSnap { id: string; patientCode: string | null; itemType: string | null; finalCost: number | null; status: string; receivedAt: string | null; note?: string | null }
interface CostResult {
  mode?: string
  statementTotal?: number
  costTotal?: number
  diff?: number
  stockTotal?: number
  notOursTotal?: number
  nextMonthTotal?: number
  carryInTotal?: number
  carryDuplicateLineIds?: string[]
  unpricedCount?: number
  readCheck?: { stated: number; linesSum: number; ok: boolean } | null
  pairs?: Array<{ costCaseId: string; lineIds: string[]; manual?: boolean }>
  costs?: CostSnap[]
}

const MARK_LABEL: Record<string, string> = { STOCK: '備貨', NOT_OURS: '唔關我哋事', NEXT_MONTH: '計入下個月', STATEMENT_WINS: '以月結單為準（舊）' }
/** 'YYYY-MM' → 'M 月' */
const monthLabel = (m: string | null | undefined) => (m && /^\d{4}-\d{2}$/.test(m) ? `${Number(m.slice(5))} 月` : '上個月')
const COUNTED_TYPES = new Set(['INVOICE', 'CREDIT', 'CHARGE'])

/** $0 而且冇標記嘅行（摺埋） */
function isZeroLine(l: StmtLine): boolean {
  return Math.abs(l.amount) < 0.001 && !l.resolution
}

/** 月結單冇印數量 → 金額 ÷ 單價（整除先用） */
function qtyOf(l: StmtLine): number | null {
  if (l.qty != null) return l.qty
  if (!l.unitPrice) return null
  const q = l.amount / l.unitPrice
  const rq = Math.round(q)
  return rq > 0 && Math.abs(q - rq) < 1e-6 ? rq : null
}

export default function StatementSection({ id, sid }: { id: string; sid: string }) {
  const [data, setData] = useState<StmtResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  // 手動配對面板：由邊行開（預先剔咗）
  const [pairFrom, setPairFrom] = useState<string | null>(null)
  // $0 行預設摺埋
  const [showZero, setShowZero] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<StmtResp>(`/api/lab-docs/${id}`))
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [id])
  useEffect(() => { load() }, [load])

  const s = data?.sections.find((x) => x.id === sid) ?? null
  const rj = (s?.resultJson ?? {}) as CostResult
  const costed = rj.mode === 'COST'
  // 行 → 劃埋嘅成本；成本 → 劃埋嘅行
  const { lineToCost, costToLines } = useMemo(() => {
    const lineToCost = new Map<string, string>()
    const costToLines = new Map<string, string[]>()
    for (const p of rj.pairs ?? []) {
      costToLines.set(p.costCaseId, p.lineIds)
      for (const lid of p.lineIds) lineToCost.set(lid, p.costCaseId)
    }
    return { lineToCost, costToLines }
  }, [rj.pairs])

  if (err) return <div className="max-w-5xl mx-auto p-4 text-sm text-red-600">{err}</div>
  if (!data) return <div className="flex justify-center py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin mr-2" />載入中…</div>
  if (!s) return <div className="max-w-5xl mx-auto p-4 text-sm">分段唔存在</div>

  const confirmed = s.status === 'CONFIRMED'
  // 上月結轉副本另外列；$0 行（冇標記）預設摺埋
  const carried = s.lines.filter((l) => !!l.carriedFromLineId)
  const native = s.lines.filter((l) => !l.carriedFromLineId)
  // ★ 2026-10-12：兩份加埋一齊對 — 另一份（或幾份）單嘅行（帶返自己 doc／段做標記）
  const combined = s.combined ?? null
  const otherMembers = (combined?.members ?? []).filter((m) => !m.isSelf)
  const otherLines = combined?.otherLines ?? []
  const selfMember = combined?.members.find((m) => m.isSelf) ?? null
  const zeroCount = native.filter(isZeroLine).length
  const carryDup = new Set(rj.carryDuplicateLineIds ?? [])
  const st = SECTION_STATUS[s.status] ?? { label: s.status, cls: '' }
  const costs = rj.costs ?? []
  const costById = new Map(costs.map((c) => [c.id, c]))
  const diff = rj.diff ?? null
  const isDiff = s.status === 'DIFF'
  // ★ 2026-10-11：「印嘅總數 vs 行加埋」只喺同成本錄入對唔上（DIFF）先顯示，幫手搵原因；
  //   總數一致就唔顯示、唔使原因 — 月結單冇印總數時 AI 會自己加錯一個數，總數啱都出警告只會誤導
  const readBad = isDiff && rj.readCheck?.ok === false
  const needsReason = isDiff
  const docBlocked = !!s.duplicate || !!data.document.supersededById
  const editable = !confirmed && !docBlocked

  const reconcile = async () => {
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/sections/${sid}/reconcile`, { method: 'POST' })
      toast.success('已重新對數')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    if (needsReason && !reason.trim()) { toast.error('有差異 — 要寫原因先可以確認'); return }
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/sections/${sid}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(needsReason ? { reason: reason.trim() } : {}),
      })
      toast.success('已確認呢段')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const markAll = async () => {
    const first = s.lines[0]
    if (!first) return
    if (!window.confirm('成段標做「備貨」？呢段嘅行唔會再同成本錄入比較。')) return
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/sections/${sid}/lines/${first.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'STOCK', applyToAll: true }),
      })
      toast.success('成段已標備貨')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-4 pb-48 md:pb-6 space-y-4">
      <div className="flex items-center gap-2">
        <Link href={`/lab-docs/statements/${id}`} className="p-2 -ml-2 rounded-lg hover:bg-accent" aria-label="返回"><ArrowLeft size={18} /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{s.clinicRaw ?? '診所'} · {s.doctorRaw ?? '醫生'}</h1>
          <div className="text-xs text-muted-foreground">{data.document.labName ?? 'Lab 未揀'} · {data.document.statementMonth ?? '月份未揀'} · 同成本錄入（到貨日）對</div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span>
      </div>

      {s.duplicate && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          <div>同一位醫生、同一間 Lab、同一個月已經有一份月結單（{s.duplicate.uploadedAt} 上傳）。呢份係：</div>
          <div className="flex flex-wrap gap-2 mt-2">
            <Link href={`/lab-docs/statements/${id}`} className="px-3 py-1 rounded-lg border bg-card">Lab 重發 → 返總覽取代舊版</Link>
            <button onClick={async () => { if (await combineSection(id, sid)) load() }} className="px-3 py-1 rounded-lg bg-brand text-white">另一份單 → 兩份加埋一齊對</button>
          </div>
        </div>
      )}
      {s.status === 'NEEDS_ASSIGN' && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          未揀診所／醫生 — 返月結單總覽揀咗先可以同成本錄入對。如果成段都係診所備貨（唔屬病人），撳下面「成段係備貨」。
        </div>
      )}
      {(!data.document.labId || !data.document.statementMonth) && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">月結單未揀 Lab／月份 — 返月結單總覽撳「改 Lab／月份」。</div>
      )}
      {s.newInvoicesSinceRun > 0 && editable && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm flex items-center gap-2">
          <span className="flex-1">成本錄入喺上次對數之後有 {s.newInvoicesSinceRun} 筆改動 — 可以重新對數</span>
          <button onClick={reconcile} disabled={busy} className="px-3 py-1 rounded-lg bg-brand text-white">重新對數</button>
        </div>
      )}

      {/* 總數 */}
      <div className="grid grid-cols-3 rounded-xl border bg-card divide-x">
        <div className="p-3">
          <div className="text-xs text-muted-foreground">月結單{combined ? `（${combined.members.length} 份合計）` : ''}</div>
          <div className="text-lg font-semibold tabular-nums">{costed ? fmtMoney(rj.statementTotal) : '—'}</div>
          {((rj.stockTotal ?? 0) !== 0 || (rj.notOursTotal ?? 0) !== 0 || (rj.nextMonthTotal ?? 0) !== 0) && (
            <div className="text-[11px] text-muted-foreground">
              {(rj.stockTotal ?? 0) !== 0 && <>備貨 {fmtMoney(rj.stockTotal)} </>}
              {(rj.notOursTotal ?? 0) !== 0 && <>唔關我哋事 {fmtMoney(rj.notOursTotal)} </>}
              {(rj.nextMonthTotal ?? 0) !== 0 && <>計入下個月 {fmtMoney(rj.nextMonthTotal)} </>}
              唔計
            </div>
          )}
          {(rj.carryInTotal ?? 0) !== 0 && (
            <div className="text-[11px] text-blue-700">含上月結轉 {fmtMoney(rj.carryInTotal)}</div>
          )}
        </div>
        <div className="p-3">
          <div className="text-xs text-muted-foreground">成本錄入（{costs.length} 筆）</div>
          <div className="text-lg font-semibold tabular-nums">{costed ? fmtMoney(rj.costTotal) : '—'}</div>
        </div>
        <div className="p-3">
          <div className="text-xs text-muted-foreground">差額</div>
          <div className={`text-lg font-semibold tabular-nums ${isDiff ? 'text-amber-700' : costed ? 'text-green-700' : ''}`}>
            {costed ? (diff ? `${diff > 0 ? '+' : ''}${fmtMoney(diff)}` : '$0 ✓') : '—'}
          </div>
        </div>
      </div>
      {readBad && rj.readCheck && <ReadCheckNote stated={rj.readCheck.stated} linesSum={rj.readCheck.linesSum} lines={s.lines} />}
      {(rj.unpricedCount ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">有 {rj.unpricedCount} 筆成本仲係「未有價」— 照計佢而家個數（冇數當 $0），確認前睇清楚。</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground flex-1">按金額幫你劃埋：一筆成本 = 一行，或者 = 連續幾行加埋。只係幫你搵差異，狀態淨係睇總數。</span>
        {editable && s.lines.length > 0 && <button onClick={markAll} disabled={busy} className="px-3 py-1.5 rounded-lg border bg-card text-sm">成段係備貨</button>}
        {editable && <button onClick={reconcile} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-card text-sm"><RefreshCw size={14} />重新對數</button>}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {/* 月結單 */}
        <div className="rounded-xl border bg-card min-w-0">
          {carried.length > 0 && (
            <>
              <div className="px-3 py-2 border-b text-xs font-medium text-blue-700 bg-blue-50">上月結轉（{carried.length} 行）</div>
              <div className="divide-y border-b">
                {carried.map((l) => (
                  <LineRow key={l.id} docId={id} sid={sid} l={l} cost={lineToCost.has(l.id) ? costById.get(lineToCost.get(l.id)!) ?? null : null} editable={editable} onChanged={load} onPair={() => setPairFrom(l.id)} carryDup={carryDup.has(l.id)} month={data.document.statementMonth} />
                ))}
              </div>
            </>
          )}
          <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground">
            {combined ? `呢份月結單（${selfMember?.uploadedAt ?? ''} 上傳）· ` : '月結單（'}{native.length} 行{zeroCount > 0 ? ` · ${native.length - zeroCount} 行要計` : ''}{combined ? '' : '）'}
          </div>
          <div className="divide-y">
            {native.filter((l) => showZero || !isZeroLine(l)).map((l) => (
              <LineRow key={l.id} docId={id} sid={sid} l={l} cost={lineToCost.has(l.id) ? costById.get(lineToCost.get(l.id)!) ?? null : null} editable={editable} onChanged={load} onPair={() => setPairFrom(l.id)} carryDup={false} month={data.document.statementMonth} />
            ))}
            {zeroCount > 0 && (
              <button onClick={() => setShowZero((v) => !v)} className="w-full px-3 py-2 text-left text-xs text-brand bg-muted/40 flex justify-between">
                <span>{showZero ? `收埋 ${zeroCount} 行 $0` : `＋ ${zeroCount} 行 $0（3D 列印模型、替代體等，唔計）`}</span>
                <span>{showZero ? '收埋' : '撳開睇'}</span>
              </button>
            )}
            {native.length === 0 && <div className="p-3 text-sm text-muted-foreground">冇行</div>}
          </div>
          {otherMembers.map((mem) => {
            const ls = otherLines.filter((l) => l.sectionId === mem.sectionId && !l.carriedFromLineId)
            const shown = ls.filter((l) => showZero || !isZeroLine(l))
            return (
              <div key={mem.sectionId} className="border-t-2">
                <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground flex justify-between gap-2">
                  <span>另一份月結單（{mem.uploadedAt} 上傳）· {ls.length} 行</span>
                  <Link href={`/lab-docs/statements/${mem.docId}`} className="underline">開嗰份</Link>
                </div>
                <div className="divide-y">
                  {shown.map((l) => (
                    <LineRow key={l.id} docId={mem.docId} sid={mem.sectionId} l={l} cost={lineToCost.has(l.id) ? costById.get(lineToCost.get(l.id)!) ?? null : null} editable={editable} onChanged={load} onPair={() => setPairFrom(l.id)} carryDup={false} month={data.document.statementMonth} />
                  ))}
                  {ls.length > shown.length && <div className="px-3 py-2 text-xs text-muted-foreground">＋ {ls.length - shown.length} 行 $0（收埋咗）</div>}
                </div>
              </div>
            )
          })}
        </div>

        {/* 成本錄入 */}
        <div className="rounded-xl border bg-card min-w-0">
          <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground flex items-center">
            <span className="flex-1">成本錄入（同 Lab、同診所、同醫生、到貨日喺 {data.document.statementMonth ?? '—'}）</span>
            <Link href="/cost-entry" className="underline">去成本錄入</Link>
          </div>
          <div className="divide-y">
            {costs.map((c) => {
              const paired = costToLines.get(c.id)
              return (
                <div key={c.id} className="p-3 text-sm flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap gap-x-3">
                      <span className="tabular-nums text-muted-foreground">{c.receivedAt ? c.receivedAt.slice(5).replace('-', '/') : '—'}</span>
                      <span className="font-medium">{c.patientCode ?? '—'}</span>
                      <span className="text-muted-foreground">{c.itemType ?? ''}</span>
                    </div>
                    <div className="text-xs mt-0.5">
                      {paired ? <span className="text-green-700">✓ 劃埋月結單 {paired.length} 行</span> : <span className="text-amber-700">月結單冇對到</span>}
                      {c.status === 'PENDING' && <span className="ml-2 px-1.5 rounded bg-amber-100 text-amber-700">未有價</span>}
                    </div>
                  </div>
                  <span className="tabular-nums">{fmtMoney(c.finalCost)}</span>
                </div>
              )
            })}
            {costs.length === 0 && <div className="p-3 text-sm text-muted-foreground">{costed ? '呢個月冇成本' : '未對數'}</div>}
          </div>
        </div>
      </div>

      {pairFrom && editable && (
        <PairPanel
          docId={id}
          sid={sid}
          lines={[...s.lines, ...otherLines]}
          costs={costs.filter((c) => !costToLines.has(c.id))}
          initial={pairFrom}
          onClose={() => setPairFrom(null)}
          onDone={() => { setPairFrom(null); load() }}
        />
      )}

      {confirmed ? (
        <div className="rounded-xl border bg-card p-3 text-sm">
          ✓ 已確認{s.confirmedAt ? `（${String(s.confirmedAt).slice(0, 10)}）` : ''}{s.note ? ` — 原因：${s.note}` : ''}
        </div>
      ) : (
        /* 手機：底部導航高 4rem（AdminMobileNav）→ 企喺佢上面 */
        <div className="fixed bottom-16 inset-x-0 z-30 border-t bg-background/95 backdrop-blur p-3 md:static md:border md:rounded-xl md:bg-card">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[12rem] text-sm">
              {!costed ? <span className="text-muted-foreground">未對數</span>
                : isDiff ? <span className="text-amber-700">差 {fmtMoney(Math.abs(diff ?? 0))} — 改好成本錄入再「重新對數」，或者寫原因確認</span>
                    : <span className="text-green-700">✓ 總數一致</span>}
            </div>
            {needsReason && costed && (
              <input
                id="confirm-reason"
                className="flex-1 min-w-[12rem] border rounded-lg px-2 py-1.5 text-sm"
                placeholder="原因（例：Lab 下月先補單）"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
            <button onClick={confirm} disabled={busy || !costed || docBlocked || (needsReason && !reason.trim())}
              className="px-5 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-40">確認呢段</button>
          </div>
        </div>
      )}
    </div>
  )
}

function LineRow({ docId, sid, l, cost, editable, onChanged, onPair, carryDup, month }: {
  docId: string
  sid: string
  l: StmtLine
  cost: CostSnap | null
  editable: boolean
  onChanged: () => void
  onPair: () => void
  /** 上月結轉副本，但本月月結單已經有同一個單號 → 唔計 */
  carryDup: boolean
  /** 本月（'YYYY-MM'） */
  month: string | null
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const counted = COUNTED_TYPES.has(l.lineType) && l.result !== 'NOT_APPLICABLE' && !carryDup
  const marked = l.resolution && MARK_LABEL[l.resolution]
  const q = qtyOf(l)
  const manual = l.pairMode === 'MANUAL' && !!cost
  const noAuto = l.pairMode === 'NONE'

  const pairOp = async (op: 'UNPAIR' | 'AUTO') => {
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${docId}/sections/${sid}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, lineId: l.id }),
      })
      toast.success(op === 'UNPAIR' ? '已拆開（未配對到）' : '已恢復自動配對')
      setOpen(false)
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const nextLabel = month && /^\d{4}-\d{2}$/.test(month) ? `${(Number(month.slice(5)) % 12) + 1} 月` : '下個月'
  const mark = async (resolution: 'STOCK' | 'NOT_OURS' | 'NEXT_MONTH' | 'CLEAR') => {
    if (resolution === 'NOT_OURS' && !note.trim()) { toast.error('「唔關我哋事」要寫原因'); return }
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${docId}/sections/${sid}/lines/${l.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution, note: note.trim() || null }),
      })
      toast.success(resolution === 'CLEAR' ? '已取消標記' : resolution === 'NEXT_MONTH' ? `已計入${nextLabel}` : '已標記')
      setOpen(false)
      setNote('')
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`p-3 text-sm ${!counted ? 'text-muted-foreground' : ''}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="truncate">
            {l.docNoRaw ? <span className="mr-2 text-muted-foreground">{l.docNoRaw}</span> : null}
            {l.description ?? (l.lineType === 'PAYMENT' ? '付款' : l.lineType === 'BF' ? '上月結餘' : '—')}
            {l.toothRaw ? ` · ${l.toothRaw}` : ''}
          </div>
          <div className="text-xs tabular-nums text-muted-foreground mt-0.5">
            ×{q ?? '—'}{l.qty == null && q != null ? '（推算）' : ''} @ {fmtMoney(l.unitPrice)}
            {l.agingBucket && l.agingBucket !== 'CURRENT' ? ' · 舊欠' : ''}
          </div>
        </div>
        <span className="tabular-nums">{fmtMoney(l.amount)}</span>
      </div>
      {l.carriedFromLineId && (
        <div className="mt-0.5 text-[11px] text-blue-700">由 {monthLabel(l.carriedFromMonth)}月結單帶過嚟</div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        {carryDup ? (
          <span className="px-1.5 rounded bg-amber-50 text-amber-700">本月月結單已經有呢張單（單號 {l.docNoRaw ?? l.docNo ?? '—'}）— 唔再計</span>
        ) : marked ? (
          <span className={`px-1.5 rounded ${l.resolution === 'NEXT_MONTH' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100'}`}>
            {l.resolution === 'NEXT_MONTH' ? `計入${nextLabel}` : marked}{l.resolutionNote ? `：${l.resolutionNote}` : ''}
          </span>
        ) : !counted ? (
          <span>唔計</span>
        ) : cost ? (
          <span className="text-green-700">✓ {manual ? '手動劃埋' : '劃埋'} {cost.patientCode ?? ''} {cost.itemType ?? ''} {fmtMoney(cost.finalCost)}</span>
        ) : l.result === 'UNPAIRED' ? (
          <span className="text-amber-700">{noAuto ? '未配對到（唔自動劃）' : '成本錄入冇對到呢個金額'}</span>
        ) : null}
        {editable && !carryDup && COUNTED_TYPES.has(l.lineType) && (Math.abs(l.amount) > 0.001 || !!l.resolution) && !open && l.resolution !== 'STATEMENT_WINS' && (
          l.resolution === 'STOCK' || l.resolution === 'NOT_OURS' || l.resolution === 'NEXT_MONTH'
            ? <button className="underline" disabled={busy} onClick={() => mark('CLEAR')}>取消標記</button>
            : <button className="underline text-brand" onClick={() => setOpen(true)}>標記</button>
        )}
      </div>
      {open && (
        <div className="mt-2 rounded-lg bg-muted/40 p-2 space-y-2">
          {cost ? (
            <div className="text-xs text-muted-foreground">
              {manual ? '「未配對到」會拆開呢組人手配對。' : '系統劃錯？「未配對到」會拆開成組，嗰啲行之後唔會再自動劃。'}
            </div>
          ) : null}
          {!manual && (
            <input className="w-full border rounded px-2 py-1" placeholder="原因（唔關我哋事要填；備貨可唔填）" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          )}
          <div className="flex flex-wrap gap-2">
            {cost ? (
              <button disabled={busy} onClick={() => pairOp('UNPAIR')} className="px-3 py-1 rounded-lg border border-brand text-brand font-medium">未配對到（拆開）</button>
            ) : l.result === 'UNPAIRED' ? (
              <button disabled={busy} onClick={() => { setOpen(false); onPair() }} className="px-3 py-1 rounded-lg border border-brand text-brand font-medium">手動配對成本</button>
            ) : null}
            {!manual && (!l.agingBucket || l.agingBucket === 'CURRENT') && (
              <button disabled={busy} onClick={() => mark('NEXT_MONTH')} className="px-3 py-1 rounded-lg border border-brand text-brand font-medium">計入{nextLabel}</button>
            )}
            {!manual && <button disabled={busy} onClick={() => mark('STOCK')} className="px-3 py-1 rounded-lg bg-brand text-white">備貨（唔屬病人）</button>}
            {!manual && <button disabled={busy} onClick={() => mark('NOT_OURS')} className="px-3 py-1 rounded-lg border bg-card">唔關我哋事</button>}
            {noAuto && !cost && <button disabled={busy} onClick={() => pairOp('AUTO')} className="px-3 py-1 rounded-lg border bg-card">恢復自動配對</button>}
            <button disabled={busy} onClick={() => setOpen(false)} className="px-3 py-1 rounded-lg border">取消</button>
          </div>
        </div>
      )}
    </div>
  )
}


/** 手動配對：揀幾行（呢段未配對嘅）＋一筆成本（未配對、有價）；要啱數先可以配 */
function PairPanel({ docId, sid, lines, costs, initial, onClose, onDone }: {
  docId: string
  sid: string
  lines: StmtLine[]
  costs: CostSnap[]
  initial: string
  onClose: () => void
  onDone: () => void
}) {
  const candidates = lines.filter((l) => l.result === 'UNPAIRED' && !l.resolution && l.pairMode !== 'MANUAL')
  const [picked, setPicked] = useState<Set<string>>(() => new Set([initial]))
  const [costId, setCostId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pricedCosts = costs.filter((c) => c.finalCost != null)
  const sum = Math.round(candidates.filter((l) => picked.has(l.id)).reduce((t, l) => t + l.amount, 0) * 100) / 100
  const cost = pricedCosts.find((c) => c.id === costId) ?? null
  const ok = !!cost && picked.size > 0 && Math.abs(sum - (cost.finalCost ?? 0)) <= 0.01

  const toggle = (lid: string) => setPicked((p) => {
    const n = new Set(p)
    if (n.has(lid)) n.delete(lid)
    else n.add(lid)
    return n
  })
  const submit = async () => {
    if (!cost || !ok) return
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${docId}/sections/${sid}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'PAIR', lineIds: [...picked], costCaseId: cost.id }),
      })
      toast.success('已手動配對')
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="w-full md:max-w-3xl max-h-[85vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-background p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold">手動配對成本</div>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-1 min-w-0">
            <div className="text-xs text-muted-foreground">月結單行（呢段未配對嘅，可以揀幾行）</div>
            {candidates.map((l) => (
              <label key={l.id} className="flex items-start gap-2 text-sm py-1">
                <input type="checkbox" className="mt-1" checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
                <span className="flex-1 min-w-0">
                  {l.docNoRaw ? <span className="text-muted-foreground mr-1">{l.docNoRaw}</span> : null}
                  {l.description ?? '—'}{l.toothRaw ? ` · ${l.toothRaw}` : ''}
                </span>
                <span className="tabular-nums">{fmtMoney(l.amount)}</span>
              </label>
            ))}
            {candidates.length === 0 && <div className="text-sm text-muted-foreground">冇未配對嘅行</div>}
          </div>
          <div className="space-y-1 min-w-0">
            <div className="text-xs text-muted-foreground">成本錄入（呢個醫生、呢個月、未配對、有價）</div>
            {pricedCosts.map((c) => (
              <label key={c.id} className="flex items-start gap-2 text-sm py-1">
                <input type="radio" name="pair-cost" className="mt-1" checked={costId === c.id} onChange={() => setCostId(c.id)} />
                <span className="flex-1 min-w-0">
                  <span className="font-medium">{c.patientCode ?? '—'}</span> <span className="text-muted-foreground">{c.itemType ?? ''}</span>
                  {c.receivedAt ? <span className="text-muted-foreground"> · {c.receivedAt.slice(5).replace('-', '/')}</span> : null}
                  {c.note ? <span className="block text-xs text-muted-foreground truncate">「{c.note}」</span> : null}
                </span>
                <span className="tabular-nums">{fmtMoney(c.finalCost)}</span>
              </label>
            ))}
            {pricedCosts.length === 0 && <div className="text-sm text-muted-foreground">冇未配對嘅成本</div>}
          </div>
        </div>
        <div className={`rounded-lg px-3 py-2 text-sm tabular-nums ${!cost ? 'bg-muted' : ok ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          揀咗 {picked.size} 行：{fmtMoney(sum)}
          {cost ? <> ・ 成本 {fmtMoney(cost.finalCost)} ・ {ok ? '✓ 啱數' : `差 ${fmtMoney(Math.abs(sum - (cost.finalCost ?? 0)))} — 唔啱數唔可以配對`}</> : ' ・ 揀一筆成本'}
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} disabled={busy} className="px-3 py-1.5 rounded-lg border text-sm">取消</button>
          <button onClick={submit} disabled={busy || !ok} className="px-4 py-1.5 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-40">配對</button>
        </div>
      </div>
    </div>
  )
}

/**
 * 2026-10-11：讀數檢查講清楚啲 — 印嘅總數 vs 讀到嘅行加埋，差幾多、邊行可疑、點處理。
 * 多咗：可能有行讀重複／讀多咗（列出金額啱啱等於差額、或者重複出現嘅行）；或者 AI 讀錯咗印嘅總數。
 * 少咗：可能有行讀漏。
 */
function ReadCheckNote({ stated, linesSum, lines }: { stated: number; linesSum: number; lines: StmtLine[] }) {
  const gap = Math.round((linesSum - stated) * 100) / 100
  const counted = lines.filter((l) => COUNTED_TYPES.has(l.lineType))
  const key = (l: StmtLine) => `${l.docNoRaw ?? ''}|${l.description ?? ''}|${l.amount}`
  const seen = new Map<string, number>()
  for (const l of counted) seen.set(key(l), (seen.get(key(l)) ?? 0) + 1)
  const dupes = counted.filter((l) => (seen.get(key(l)) ?? 0) > 1)
  const exact = gap > 0 ? counted.filter((l) => Math.abs(l.amount - gap) < 0.005) : []
  const suspects = [...new Map([...dupes, ...exact].map((l) => [l.id, l])).values()].slice(0, 6)
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm space-y-1">
      <div>
        月結單上面印嘅總數讀到係 {fmtMoney(stated)}，但逐行加埋係 {fmtMoney(linesSum)}（{gap > 0 ? `多咗 ${fmtMoney(gap)}` : `少咗 ${fmtMoney(-gap)}`}）。撳「睇原檔」核對：
      </div>
      <ul className="list-disc pl-5 text-xs space-y-0.5">
        {gap > 0 ? (
          <>
            <li>如果原檔冇印總數（例如只係手寫），或者印嘅其實係 {fmtMoney(linesSum)} — 即係呢個總數 AI 讀錯，唔使理，照睇同成本錄入差幾多。</li>
            <li>如果真係 {fmtMoney(stated)} — 即係有行讀多咗或者讀重複，嗰行撳「標記」→「唔關我哋事」（原因：重複讀），再睇同成本錄入差幾多。</li>
          </>
        ) : (
          <li>可能有行讀漏 — 對住原檔睇吓少咗邊行；成本錄入有嘅話差額會顯示出嚟。</li>
        )}
      </ul>
      {suspects.length > 0 && (
        <div className="text-xs">
          可疑嘅行：
          {suspects.map((l) => (
            <span key={l.id} className="inline-block mr-2">
              {l.docNoRaw ?? ''} {l.description ?? ''} {fmtMoney(l.amount)}{(seen.get(key(l)) ?? 0) > 1 ? '（出現咗兩次）' : '（金額啱啱等於差額）'}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
