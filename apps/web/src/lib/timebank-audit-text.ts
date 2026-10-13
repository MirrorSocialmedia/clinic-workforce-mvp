// ============================================================
// ★ cwm-empoverview-20261014：員工總覽「操作記錄」—— 審計紀錄變人話（純函數，client／test 用）
//   老闆：動作要講明係乜、JSON 員工睇唔明。
//   ⚠️ 唔再顯示 beforeJson/afterJson 嘅 balanceMinutes：嗰個係「所有手動紀錄加埋」（唔包 OT 自動計算），
//      唔係時間帳戶餘額，同上面逐月表期末對唔上，會誤導。只顯示呢次 +／− 幾多。
// ============================================================

export interface AuditRowIn { action: string; beforeJson: string | null; afterJson: string | null; notes: string | null }
export interface AuditText {
  /** 做咗乜（中文） */
  title: string
  /** 時間帳戶變化（分鐘；冇變化／唔適用 = null） */
  delta: number | null
  /** 一句話詳情 */
  detail: string
}

const parse = (s: string | null): any => {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}
const md = (d: unknown) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(5, 10) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const MAKEUP_TYPE: Record<string, string> = { LATE: '遲到', LATE_LUNCH: '午飯遲返', EARLY_LEAVE: '早走' }

/** 分鐘 → 「+36 分鐘」／「−1 小時 5 分」／「−8 小時」 */
export function fmtMinutesSigned(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  const a = Math.abs(Math.round(n))
  if (a < 60) return `${sign}${a} 分鐘`
  const h = Math.floor(a / 60), m = a % 60
  return `${sign}${h} 小時${m ? ` ${m} 分` : ''}`
}

const join = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ')

export function describeTimebankAudit(a: AuditRowIn): AuditText {
  const n = parse(a.notes)
  const before = parse(a.beforeJson)
  const after = parse(a.afterJson)
  switch (a.action) {
    case 'TIMEBANK_MAKEUP': {
      const t = MAKEUP_TYPE[n?.targetType] ?? ''
      return {
        title: `補鐘（扣 OT 鐘）`,
        delta: num(n?.delta),
        detail: join(`補 ${md(n?.date)} ${t}`.trim(), n?.reason ? `原因：${n.reason}` : null, n?.source === 'BATCH' ? '批量補鐘' : null),
      }
    }
    case 'TIMEBANK_MAKEUP_BATCH':
      return {
        title: '批量補鐘（總結）',
        delta: null,
        detail: join(
          n ? `申請 ${n.requested ?? 0} 筆：成功 ${n.success ?? 0}、略過 ${n.skipped ?? 0}、失敗 ${n.failed ?? 0}` : null,
          n?.reason ? `原因：${n.reason}` : null,
        ),
      }
    case 'TIMEBANK_CONVERT': {
      const days = num(n?.days) ?? 0
      return {
        title: n?.direction === 'to_leave' ? 'OT 鐘換假' : '假換返 OT 鐘',
        delta: num(n?.delta),
        detail: n?.direction === 'to_leave' ? `用 OT 鐘換 ${days} 日補假` : `${days} 日假換返做 OT 鐘`,
      }
    }
    case 'TIMEBANK_REST_TO_ACCOUNT':
      return {
        title: '休息日還鐘',
        delta: num(n?.minutes),
        detail: join(`用 ${num(n?.days) ?? 0} 日休息日還返拖欠嘅鐘`, n?.note ? `備註：${n.note}` : null),
      }
    case 'TIMEBANK_INIT_ADJUST': {
      const b = num(before?.initMinutes), af = num(after?.initMinutes)
      return {
        title: '初始化時間帳戶',
        delta: b != null && af != null ? af - b : null,
        detail: join(n?.effectiveMonth ? `由 ${n.effectiveMonth} 起，期初設為 ${fmtMinutesSigned(num(n?.minutes) ?? 0).replace(/^\+/, '')}` : null, n?.reason ? `原因：${n.reason}` : null),
      }
    }
    case 'TIMEBANK_ABSENT_DEDUCT':
      return { title: '缺勤扣 OT 鐘', delta: num(n?.delta), detail: `${md(n?.date)} 缺勤，用 OT 鐘抵`.trim() }
    case 'TIMEBANK_OT_BACKPAY': {
      const days: Array<{ date: string; diff: number }> = Array.isArray(after?.days) ? after.days : []
      const src = typeof after?.sourceMonth === 'string' ? `${Number(after.sourceMonth.slice(5, 7))} 月` : '之前月份'
      const tgt = typeof after?.targetMonth === 'string' ? `${Number(after.targetMonth.slice(5, 7))} 月` : '本月'
      return {
        title: '補回之前少計嘅 OT',
        delta: num(after?.minutes),
        detail: `${src} OT 門檻設錯${num(after?.threshold) != null ? `（${after.threshold} 分鐘）` : ''}少計咗，補入 ${tgt}`
          + (days.length ? `：${days.filter(d => num(d.diff)).map(d => `${md(d.date)} +${d.diff}`).join('、')}` : ''),
      }
    }
    default: {
      // 未知動作：notes 係純文字就照出；係 JSON 就唔出（員工睇唔明）
      const plain = a.notes && !n ? a.notes : ''
      return { title: a.action.replace(/^TIMEBANK_/, '時間帳戶：'), delta: num(n?.delta), detail: plain }
    }
  }
}
