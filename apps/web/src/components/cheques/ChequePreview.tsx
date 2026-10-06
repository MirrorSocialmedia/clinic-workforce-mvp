'use client'

// ★ cwm-chequeprint-20261005：支票預覽（SVG，mm 比例，支票座標）
//   灰色 = 匯豐支票本身印好（量度自實物，唔會印）；藍字 = 打印機會印；虛線框 = 欄位
//   editable：撳欄位揀、拖動、方向鍵微調（0.5mm；Shift = 2mm）
import { useRef } from 'react'
import { FIELD_LABEL, HSBC_ARTWORK, charMm, type FieldKey, type LayoutFields, type PrintItem, type PrinterMode } from '@/lib/cheque-print/layout'
import { TEXT_COL_MM, TEXT_ROW_MM } from '@/lib/cheque-print/encode'

export function ChequePreview({ fields, items, mode, width = 720, selected, onSelect, onMove }: {
  fields: LayoutFields
  /** 預覽用 layoutItems(..., {x:0,y:0}) —— 打印機起點偏移唔畫 */
  items: PrintItem[]
  mode: PrinterMode
  width?: number
  selected?: FieldKey | null
  onSelect?: (k: FieldKey) => void
  /** 拖動或者方向鍵：移幾多 mm */
  onMove?: (k: FieldKey, dx: number, dy: number) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ key: FieldKey; x: number; y: number } | null>(null)
  const { w, h } = fields.paper
  const A = HSBC_ARTWORK
  const editable = !!onMove

  const toMm = (ev: React.PointerEvent) => {
    const svg = svgRef.current
    const m = svg?.getScreenCTM()
    if (!svg || !m) return null
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  }
  const snap = (it: PrintItem) => mode === 'TEXT'
    ? { x: Math.round(it.x / TEXT_COL_MM) * TEXT_COL_MM, y: Math.round(it.y / TEXT_ROW_MM) * TEXT_ROW_MM }
    : { x: it.x, y: it.y }

  // 欄位框
  const dateW = (n: number) => (n - 1) * fields.datePitch + charMm(10)
  const boxes: Array<{ k: FieldKey; x: number; y: number; w: number }> = [
    { k: 'day', ...fields.day, w: dateW(2) }, { k: 'month', ...fields.month, w: dateW(2) }, { k: 'year', ...fields.year, w: dateW(4) },
    ...(['payee', 'words1', 'words2', 'amount'] as const).map(k => ({ k, x: fields[k].x, y: fields[k].y, w: fields[k].width })),
  ]

  const onKey = (ev: React.KeyboardEvent) => {
    if (!onMove || !selected) return
    const step = ev.shiftKey ? 2 : 0.5
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key]
    if (!d) return
    ev.preventDefault()
    onMove(selected, d[0], d[1])
  }

  return (
    <svg ref={svgRef} viewBox={`-2 -2 ${w + 4} ${h + 4}`} width={width} style={{ maxWidth: '100%', height: 'auto', touchAction: editable ? 'none' : undefined, outline: 'none' }}
      role="img" aria-label="支票預覽" tabIndex={editable ? 0 : undefined} onKeyDown={onKey}
      onPointerMove={ev => {
        const d = drag.current
        if (!d || !onMove) return
        const p = toMm(ev)
        if (!p) return
        const dx = Math.round((p.x - d.x) * 2) / 2, dy = Math.round((p.y - d.y) * 2) / 2
        if (dx || dy) { onMove(d.key, dx, dy); drag.current = { ...d, x: d.x + dx, y: d.y + dy } }
      }}
      onPointerUp={() => { drag.current = null }} onPointerLeave={() => { drag.current = null }}>
      <rect x={0} y={0} width={w} height={h} rx={1.5} fill="#f4efd9" stroke="#c9bfa6" strokeWidth={0.4} />

      {/* 匯豐支票本身印好嘅嘢 */}
      <g fill="none" stroke="#b9ae92" strokeWidth={0.3}>
        {A.dateBoxes.map((b, i) => <rect key={i} x={b.x} y={A.dateBoxY} width={b.w} height={A.dateBoxH} />)}
        {A.lines.map((l, i) => <line key={i} x1={l.x1} x2={l.x2} y1={l.y} y2={l.y} />)}
        <rect x={A.payeeOnlyBox.x} y={A.payeeOnlyBox.y} width={A.payeeOnlyBox.w} height={A.payeeOnlyBox.h} />
        <rect x={A.amountBox.x} y={A.amountBox.y} width={A.amountBox.w} height={A.amountBox.h} />
      </g>
      <g fill="#a39a80" fontSize={2.2} fontFamily='"Noto Sans HK", sans-serif'>
        {A.labels.map((l, i) => <text key={i} x={l.x} y={l.y}>{l.t}</text>)}
        <text x={A.payeeOnlyBox.x + 1} y={A.payeeOnlyBox.y + 14} fontSize={1.8}>A/C Payee</text>
        <text x={9.5} y={A.micrY} fontSize={2.6} letterSpacing={0.6}>⑈000000⑈ 004⑆000⑆ 000000⑈001⑈（MICR）</text>
      </g>

      {/* 欄位框（可揀／拖） */}
      {boxes.map(b => (
        <rect key={b.k} x={b.x - 0.5} y={b.y - 0.8} width={b.w + 1} height={5}
          fill={selected === b.k ? 'rgba(47,93,134,0.12)' : 'transparent'}
          stroke={selected === b.k ? '#2f5d86' : '#9fb3c8'} strokeWidth={selected === b.k ? 0.35 : 0.2} strokeDasharray={selected === b.k ? undefined : '1 0.8'}
          style={{ cursor: editable ? 'move' : undefined }}
          onPointerDown={ev => {
            if (!editable) return
            onSelect?.(b.k)
            const p = toMm(ev)
            if (p) drag.current = { key: b.k, ...p }
            svgRef.current?.focus()
          }} />
      ))}

      {/* 打印內容 */}
      {items.map(it => {
        const p = snap(it)
        const ascii = !/[^\x20-\x7e]/.test(it.text)
        const cw = charMm(mode === 'TEXT' ? 10 : it.cpi)
        return (
          <text key={it.key} x={p.x} y={p.y + 3} fill="#1f4f9c" fontWeight={600} pointerEvents="none"
            fontFamily={ascii ? '"IBM Plex Mono", ui-monospace, monospace' : '"Noto Sans HK", sans-serif'}
            fontSize={ascii ? Math.min(3.6, cw / 0.6) : 3.4}
            {...(ascii ? { textLength: cw * it.text.length, lengthAdjust: 'spacingAndGlyphs' } : {})}>
            {it.text}
          </text>
        )
      })}
      {selected && editable && (
        <text x={w - 2} y={h - 2} fontSize={2.4} fill="#2f5d86" textAnchor="end">已揀：{FIELD_LABEL[selected]} · 拖動或者用方向鍵（Shift = 2mm）</text>
      )}
    </svg>
  )
}
