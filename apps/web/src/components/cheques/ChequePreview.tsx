'use client'

// ★ cwm-chequeprint-20261005：支票預覽（SVG，mm 比例）。藍字 = 打印機會印；灰框 = 欄位位置
import { charMm, dateDigitXs, type LayoutFields, type PrintItem, type PrinterMode } from '@/lib/cheque-print/layout'
import { TEXT_COL_MM, TEXT_ROW_MM } from '@/lib/cheque-print/encode'

export function ChequePreview({ fields, items, mode, offset, width = 720 }: {
  fields: LayoutFields
  items: PrintItem[]
  mode: PrinterMode
  offset: { x: number; y: number }
  width?: number
}) {
  const { w, h } = fields.paper
  // TEXT 模式：位置會黐埋 10cpi × 6lpi 格，預覽照實際
  const snap = (it: PrintItem) => mode === 'TEXT'
    ? { x: Math.round(it.x / TEXT_COL_MM) * TEXT_COL_MM, y: Math.round(it.y / TEXT_ROW_MM) * TEXT_ROW_MM }
    : { x: it.x, y: it.y }
  const box = (x: number, y: number, bw: number, label: string) => (
    <g key={label}>
      <rect x={x} y={y - 1} width={bw} height={5.5} fill="none" stroke="#c9bfa6" strokeWidth={0.25} strokeDasharray="1 0.8" />
      <text x={x} y={y - 1.6} fontSize={2.2} fill="#8f8674">{label}</text>
    </g>
  )
  return (
    <svg viewBox={`-2 -2 ${w + 4} ${h + 4}`} width={width} style={{ maxWidth: '100%', height: 'auto' }} role="img" aria-label="支票預覽">
      <rect x={0} y={0} width={w} height={h} rx={1.5} fill="#fbf7ec" stroke="#c9bfa6" strokeWidth={0.4} />
      {dateDigitXs(fields.date).map((x, i) => (
        <rect key={i} x={x} y={fields.date.y - 1} width={fields.date.pitch} height={5.5} fill="none" stroke="#c9bfa6" strokeWidth={0.25} />
      ))}
      <text x={fields.date.x} y={fields.date.y - 1.6} fontSize={2.2} fill="#8f8674">日期 DDMMYYYY</text>
      {box(fields.payee.x, fields.payee.y, fields.payee.width, '抬頭 Pay')}
      {box(fields.words1.x, fields.words1.y, fields.words1.width, '大寫 第 1 行')}
      {box(fields.words2.x, fields.words2.y, fields.words2.width, '大寫 第 2 行')}
      {box(fields.amount.x, fields.amount.y, fields.amount.width, '金額 $')}
      <text x={4} y={h - 4} fontSize={2.4} fill="#8f8674">A/C Payee Only 已預印 · 簽名人手簽</text>
      {(offset.x !== 0 || offset.y !== 0) && (
        <text x={w - 4} y={h - 4} fontSize={2.2} fill="#8f8674" textAnchor="end">校準 {offset.x >= 0 ? '+' : ''}{offset.x} / {offset.y >= 0 ? '+' : ''}{offset.y} mm</text>
      )}
      {items.map(it => {
        const p = snap(it)
        const ascii = !/[^\x20-\x7e]/.test(it.text)
        const cw = charMm(mode === 'TEXT' ? 10 : it.cpi)
        return (
          <text key={it.key} x={p.x} y={p.y + 3.2} fill="#1f4f9c" fontWeight={600}
            fontFamily={ascii ? '"IBM Plex Mono", ui-monospace, monospace' : '"Noto Sans HK", sans-serif'}
            fontSize={ascii ? cw / 0.6 : 3.4}
            {...(ascii ? { textLength: cw * it.text.length, lengthAdjust: 'spacingAndGlyphs' } : {})}>
            {it.text}
          </text>
        )
      })}
    </svg>
  )
}
