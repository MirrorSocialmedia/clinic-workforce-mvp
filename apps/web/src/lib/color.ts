/** 依 WCAG 相對亮度決定膠囊文字用黑定白 */
export function textOn(hex?: string | null): string {
  if (!hex) return '#1f2937'
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  if (full.length !== 6) return '#1f2937'
  const ch = (i: number) => parseInt(full.slice(i, i + 2), 16)
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const L = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4))
  return L > 0.45 ? '#1f2937' : '#ffffff'
}

/** hex → HSL */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16) / 255
  const g = parseInt(m.slice(2, 4), 16) / 255
  const b = parseInt(m.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s, l }
}

/** HSL → hex */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const toHex = (n: number) => {
    const hex = Math.round((n + m) * 255).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * 由店舖顏色衍生同色系嘅更次顏色。
 * 同一間店嘅唔同更次 → 同色相、唔同明度，一眼睇到係邊間店、又分得開係邊一更。
 *
 * @param baseHex  店舖顏色
 * @param index    更次喺該店模板清單入面嘅次序（0 起）
 * @param total    該店更次模板總數
 */
export function shiftShade(baseHex: string, index: number, total: number): string {
  const { h, s } = hexToHsl(baseHex)
  if (total <= 1) return baseHex
  // 明度由 34% 排到 66% —— 兩端都保證同白/黑字都夠對比
  const lo = 0.34, hi = 0.66
  const l = lo + (hi - lo) * (index / Math.max(1, total - 1))
  // 飽和度略降，避免深色端太刺眼
  const sat = Math.min(s, 0.62)
  return hslToHex(h, sat, l)
}
