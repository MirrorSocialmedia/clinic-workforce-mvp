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
