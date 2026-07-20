export const PUNCH_TYPE_LABEL: Record<string, string> = {
  CLOCK_IN: '上班',
  CLOCK_OUT: '下班',
  LUNCH_START: '午休開始',
  LUNCH_END: '午休結束',
}

export const punchLabel = (t: string) => PUNCH_TYPE_LABEL[t] || '未知'

export const PUNCH_TYPE_COLOR: Record<string, string> = {
  CLOCK_IN: 'text-green-600',
  CLOCK_OUT: 'text-red-600',
  LUNCH_START: 'text-amber-600',
  LUNCH_END: 'text-blue-600',
}

export const punchColor = (t: string) => PUNCH_TYPE_COLOR[t] || 'text-gray-600'

export const PUNCH_TYPE_BG: Record<string, string> = {
  CLOCK_IN: '#e8f5e9',
  CLOCK_OUT: '#ffebee',
  LUNCH_START: '#fff8e1',
  LUNCH_END: '#e3f2fd',
}

export const PUNCH_TYPE_TEXT_COLOR: Record<string, string> = {
  CLOCK_IN: '#2e7d32',
  CLOCK_OUT: '#c62828',
  LUNCH_START: '#f57f17',
  LUNCH_END: '#1565c0',
}

export const punchBg = (t: string) => PUNCH_TYPE_BG[t] || '#f0f0f0'
export const punchTextColor = (t: string) => PUNCH_TYPE_TEXT_COLOR[t] || '#888'
