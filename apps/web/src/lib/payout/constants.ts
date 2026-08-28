// MD-G: Item type preset values for cost-entry dropdown
export const ITEM_TYPES = [
  'CR&BR&Venner',
  'Implant',
  'Denture',
  'Nightguard',
  'Retainer',
  'Implant Denture',
  // ★ 2026-08-28 cwm-matedit T3 §4 #29/#30：隱形矯正併入 LAB 後， itemType 仍要揀得到
  'Invisalign',
  'Others',
] as const

// MD-R: SP 2人$1k package pricing
export const SP_2P1K_PACKAGE = 1000
export const SP_2P1K_PER_PERSON = SP_2P1K_PACKAGE / 2 // 500
