export const TIMEBANK_TYPE_LABEL: Record<string, string> = {
  OT: '加班',
  LATE: '遲到',
  EARLY: '早退',
  MAKEUP: '補鐘',
  LEAVE_CONVERT: '換假',
  LEAVE_SWAP_BACK: '換回',
  ROSTER_DIFF: '編更差額',
  REST_TO_ACCOUNT: '休息日轉帳戶',
}

export const TIMEBANK_TARGET_LABEL: Record<string, string> = {
  LATE: '遲到',
  EARLY_LEAVE: '早退',
  ABSENT: '缺勤',
}

/** 'MAKEUP' + targetType 'LATE' → '補鐘 (遲到)' */
export function timebankLabel(type: string, targetType?: string | null): string {
  const base = TIMEBANK_TYPE_LABEL[type] ?? type
  if (type === 'MAKEUP' && targetType) {
    const t = TIMEBANK_TARGET_LABEL[targetType] ?? targetType
    return `${base} (${t})`
  }
  return base
}
