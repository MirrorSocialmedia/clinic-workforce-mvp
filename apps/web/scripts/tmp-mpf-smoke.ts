import { calcMPF } from '../src/lib/payroll-engine'
import { getMpfExemption } from '../src/lib/mpf-exemption'

const d = (s: string) => new Date(`${s}T00:00:00+08:00`)
const C = { enabled: true, rate: 0.05, min: 7100, max: 30000 }
let fail = 0
function eq(name: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 0.005
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${name}: got ${got}, want ${want}`)
}

// #12 59 日（在職 endRef = 月尾 9/30：8/3 入 → 29+30 = 59 日）
eq('59日 在職 9月', calcMPF(20000, C, { joinDate: d('2026-08-03'), periodMonth: d('2026-09-01') }), 0)
// #11 啱啱 60 日（8/2 入 → 9/30 末 = 30+30 = 60 日）→ 要供
eq('60日邊界 在職 9月', calcMPF(20000, C, { joinDate: d('2026-08-02'), periodMonth: d('2026-09-01') }), 1000)
// #2 離職 45 日（lastDay 含尾）：7/28 入 → lastDay 9/11 = 46 日？算 7/28..9/11: 4+31+11=46 → 用 7/29 入 → 45
eq('離職45日', calcMPF(20000, C, { joinDate: d('2026-07-29'), periodMonth: d('2026-09-01'), lastDay: d('2026-09-11') }), 0)
// #3 入職 7/1，7 月 → 免供款期
eq('7/1入 7月', calcMPF(20000, C, { joinDate: d('2026-07-01'), periodMonth: d('2026-07-01') }), 0)
// #4 入職 7/1，8 月 → 開始供
eq('7/1入 8月', calcMPF(20000, C, { joinDate: d('2026-07-01'), periodMonth: d('2026-08-01') }), 1000)
// #5 入職 1/16，2 月 → $0（不完整糧期）
eq('1/16入 2月', calcMPF(20000, C, { joinDate: d('2026-01-16'), periodMonth: d('2026-02-01') }), 0)
// #6 入職 1/16，3 月 → 開始供
eq('1/16入 3月', calcMPF(20000, C, { joinDate: d('2026-01-16'), periodMonth: d('2026-03-01') }), 1000)
// #7 長役 $18,000 → 900
eq('長役 18000', calcMPF(18000, C, { joinDate: d('2025-01-01'), periodMonth: d('2026-09-01') }), 900)
// #8 $40,000 → 1500 封頂
eq('40000 cap', calcMPF(40000, C, { joinDate: d('2024-01-01'), periodMonth: d('2026-09-01') }), 1500)
// #10 ctx 傳唔到 → 舊行為
eq('無ctx 舊行為', calcMPF(20000, C), 1000)
// ③ 長役 <$7,100 → 0
eq('長役 7099', calcMPF(7099.99, C, { joinDate: d('2025-01-01'), periodMonth: d('2026-09-01') }), 0)
// disabled → 0
eq('disabled', calcMPF(20000, { enabled: false }), 0)
// 免供款期邊界：入職 7/2 → day30 = 7/31（啱啱月尾）→ 7 月免、8 月供
eq('7/2入 7月(免)', calcMPF(20000, C, { joinDate: d('2026-07-02'), periodMonth: d('2026-07-01') }), 0)
eq('7/2入 8月(供)', calcMPF(20000, C, { joinDate: d('2026-07-02'), periodMonth: d('2026-08-01') }), 1000)
// 離職 71 日 Selina 式（7/3 入 → lastDay 9/11 = 71 日）→ 60 日過，但入息 < 7100 → 0
eq('Selina 71日 <7100', calcMPF(5639.27, C, { joinDate: d('2026-07-03'), periodMonth: d('2026-09-01'), lastDay: d('2026-09-11') }), 0)
// 離職 71 日 + 高薪 → 供
eq('71日高薪', calcMPF(20000, C, { joinDate: d('2026-07-03'), periodMonth: d('2026-09-01'), lastDay: d('2026-09-11') }), 1000)
// employedDays 驗證（7/1→9/9 = 71 日）
const ex = getMpfExemption({ joinDate: d('2026-07-01'), periodMonth: d('2026-09-01'), lastDay: d('2026-09-09') })
console.log(`${ex?.employedDays === 71 ? '✅' : '❌'} employedDays 7/1→9/9 = ${ex?.employedDays} (want 71)`)
if (ex?.employedDays !== 71) fail++

process.exit(fail ? 1 : 0)
