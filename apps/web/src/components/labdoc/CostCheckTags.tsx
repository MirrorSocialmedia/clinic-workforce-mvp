'use client'

// ============================================================
// ★ 2026-10-11／13（cost-entry）→ cwm-paycostcheck-20261014 抽去共用：
//   成本錄入同醫生月結預覽用同一套「月結單／invoice 核對」標示，唔好兩邊各自寫。
// ============================================================

export interface StatementMarkProp {
  status: 'OK' | 'OK_DIFF' | 'CHANGED' | 'PARTIAL' | 'IN_PROGRESS'
  docId: string; diff: number; reasons: string[]; changedBy: number; uncoveredTotal: number
}
export interface StatementLinkProp {
  state: 'OK' | 'CHANGED' | 'MISSING'; docId: string; sectionId: string; confirmedFinalCost: number | null
}

// ★ 2026-10-11：按 lab 總數旁邊嘅月結核對標示（API cost-statement-marks.ts；只喺到貨日＋揀咗月份先有）
export function StatementMarkPill({ mark }: {
  mark?: StatementMarkProp
}) {
  if (!mark) return null
  const money = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  const meta: Record<typeof mark.status, { text: string; cls: string; title: string }> = {
    OK: { text: '✓ 月結已核對', cls: 'bg-green-100 text-green-700', title: '月結單全部分段已確認，總數一致' },
    OK_DIFF: { text: `✓ 月結已核對（差 ${money(mark.diff)}）`, cls: 'bg-green-100 text-green-700', title: mark.reasons.length ? `原因：${mark.reasons.join('；')}` : '確認時有差額' },
    CHANGED: { text: '⚠ 核對後成本有改', cls: 'bg-amber-100 text-amber-800', title: `確認之後成本錄入改咗 ${mark.changedBy > 0 ? '+' : '−'}${money(mark.changedBy)} — 返月結單睇吓` },
    PARTIAL: { text: `⚠ 有 ${money(mark.uncoveredTotal)} 唔喺月結單`, cls: 'bg-amber-100 text-amber-800', title: '成本錄入有呢間 Lab 嘅成本，但月結單冇嗰位醫生／診所嘅分段' },
    IN_PROGRESS: { text: '月結對緊', cls: 'bg-slate-100 text-slate-600', title: '月結單未全部分段確認' },
  }
  const m = meta[mark.status]
  return (
    <a href={`/lab-docs/statements/${mark.docId}`} title={m.title} className={`px-1.5 rounded text-[11px] font-medium whitespace-nowrap ${m.cls}`}>{m.text}</a>
  )
}

// ★ 2026-10-13：逐筆月結單核對（API lib/labdoc/cost-statement-links.ts）— 撳落去開月結單嗰段
export function StatementLinkTag({ link, finalCost }: { link?: StatementLinkProp | null; finalCost: number | null }) {
  if (!link) return null
  const href = `/lab-docs/statements/${link.docId}/sections/${link.sectionId}`
  const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (link.state === 'OK') {
    return <a href={href} title="月結單已確認、配對到呢筆 — 撳去睇" className="ml-1 px-1 rounded bg-violet-100 text-violet-700 text-[10px] font-medium hover:bg-violet-200 underline-offset-2 hover:underline">月</a>
  }
  const title = link.state === 'CHANGED'
    ? (link.confirmedFinalCost != null && finalCost != null
      ? `月結單確認時係 ${money(link.confirmedFinalCost)}，而家係 ${money(finalCost)} — 撳去月結單睇吓`
      : '月結單確認之後，呢筆嘅 Lab／診所／醫生／月份改咗 — 撳去月結單睇吓')
    : '呢個月嘅月結單已經確認，但冇一行配到呢筆 — 可能 Lab 漏咗收、或者入錯月份'
  return (
    <a href={href} title={title} className="ml-1 px-1 rounded bg-amber-100 text-amber-800 text-[10px] font-medium hover:bg-amber-200 whitespace-nowrap">
      {link.state === 'MISSING' ? '月結冇呢筆' : link.confirmedFinalCost != null ? '核對後改咗價' : '核對後改咗資料'}
    </a>
  )
}


/** ★ cwm-paycostcheck-20261014：已連 Lab invoice（撳去睇） */
export function InvoiceTag({ inv }: { inv: { id: string; docNo: string | null } }) {
  return (
    <a href={`/lab-docs/invoices/${inv.id}`} title={`已同 Lab invoice ${inv.docNo ?? ''} 配對 — 撳去睇`}
      className="ml-1 px-1 rounded bg-blue-100 text-blue-700 text-[10px] font-medium hover:bg-blue-200">單</a>
  )
}
