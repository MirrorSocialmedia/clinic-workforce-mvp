// ★ cwm-patientsearch-20261003：病人搜尋共用顯示（成本錄入／醫生轉介）
//   第二期 cwm-datasource-20261003：由成本錄入頁抽出，轉介頁共用

/** 每個資料來源嘅搜尋狀態（失敗／冇結果唔再靜靜消失） */
export interface SearchSource { label: string; ok: boolean; found: number; error?: string }

/** 病人搜尋結果下面嘅來源狀態：只喺有來源失敗或者 0 筆時顯示 */
export function SourceStatusLine({ sources }: { sources: SearchSource[] }) {
  const notable = sources.filter(s => !s.ok || s.found === 0)
  if (!notable.length) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs mt-1">
      {notable.map(s => s.ok
        ? <span key={s.label} className="text-gray-400">{s.label}：冇結果</span>
        : <span key={s.label} className="text-red-600">⚠ {s.label}：{s.error ?? '連線失敗'}</span>)}
    </div>
  )
}

/** 結果行嘅診所標籤 */
export function ClinicChip({ label }: { label?: string }) {
  if (!label) return null
  return <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">{label}</span>
}
