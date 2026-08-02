// ════════════════════════════════════════════════════════════════════
//  匯入香港公眾假期（1823 政府熱線官方 iCal JSON）
//  來源：https://www.1823.gov.hk/common/ical/gc/en.json
//
//  ★ HKPublicHoliday 表係 monthlyWorkingDays 嘅唯一來源。
//    表空 = 公眾假期當 0 = 扣薪日率算錯（2026-08-02 撞過）。
//
//  跑法：
//    docker cp hk_holiday.json clinic-prod-app:/app/
//    docker cp scripts/import-hk-holidays.mjs clinic-prod-app:/app/
//    docker exec -w /app clinic-prod-app node import-hk-holidays.mjs hk_holiday.json
//    # 確認之後：
//    docker exec -w /app -e DRY_RUN=0 clinic-prod-app node import-hk-holidays.mjs hk_holiday.json
// ════════════════════════════════════════════════════════════════════
import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const DRY_RUN = process.env.DRY_RUN !== '0'

const NAME_MAP = {
  'The first day of January': '元旦',
  'Lunar New Year\u2019s Day': '農曆年初一',      // ★ iCal 用彎引號 U+2019
  "Lunar New Year's Day": '農曆年初一',           // 直引號後備
  'The second day of Lunar New Year': '農曆年初二',
  'The third day of Lunar New Year': '農曆年初三',
  'The fourth day of Lunar New Year': '農曆年初四',
  'Ching Ming Festival': '清明節',
  'The day following Ching Ming Festival': '清明節翌日',
  'Good Friday': '耶穌受難節',
  'The day following Good Friday': '耶穌受難節翌日',
  'Easter Monday': '復活節星期一',
  'The day following Easter Monday': '復活節星期一翌日',
  'Labour Day': '勞動節',
  'The Birthday of the Buddha': '佛誕',
  'The day following the Birthday of the Buddha': '佛誕翌日',
  'Tuen Ng Festival': '端午節',
  'Hong Kong Special Administrative Region Establishment Day': '香港特別行政區成立紀念日',
  'Chinese Mid-Autumn Festival': '中秋節',
  'The day following the Chinese Mid-Autumn Festival': '中秋節翌日',
  'National Day': '國慶日',
  'The day following National Day': '國慶日翌日',
  'Chung Yeung Festival': '重陽節',
  'The day following Chung Yeung Festival': '重陽節翌日',
  'Christmas Day': '聖誕節',
  'The first weekday after Christmas Day': '聖誕節後第一個週日',
}

const file = process.argv[2]
if (!file) { console.error('用法：node import-hk-holidays.mjs <hk_holiday.json>'); process.exit(1) }

async function main() {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const events = raw?.vcalendar?.[0]?.vevent
  if (!Array.isArray(events)) throw new Error('格式唔啱 —— 搵唔到 vcalendar[0].vevent')

  const rows = []
  for (const ev of events) {
    const ds = ev?.dtstart?.[0]
    if (!ds || !/^\d{8}$/.test(ds)) {
      console.warn(`⚠️ 跳過（dtstart 格式唔啱）：${JSON.stringify(ev?.dtstart)}`)
      continue
    }
    const ymd = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`
    // ★ 一定要 HK 午夜 —— 存 UTC 午夜會令 getPublicHolidayDays 嘅
    //   月份範圍查詢（HK 邊界）漏咗月頭／月尾嗰日。
    const date = new Date(`${ymd}T00:00:00+08:00`)
    const name = NAME_MAP[ev.summary] ?? ev.summary
    if (!NAME_MAP[ev.summary]) console.warn(`⚠️ 冇中文對應，用原文：${ev.summary}`)
    rows.push({ ymd, date, name })
  }

  rows.sort((a, b) => a.ymd.localeCompare(b.ymd))
  const byYear = {}
  rows.forEach(r => { const y = r.ymd.slice(0,4); byYear[y] = (byYear[y] ?? 0) + 1 })

  console.log(`解析到 ${rows.length} 筆：`)
  Object.entries(byYear).forEach(([y, n]) => console.log(`  ${y}：${n} 日`))

  // ★ 每年應該 17 日左右 —— 明顯偏離就唔好入
  for (const [y, n] of Object.entries(byYear)) {
    if (n < 12 || n > 20) throw new Error(`${y} 年得 ${n} 日，明顯唔對（正常 17 日）—— 請檢查來源檔案`)
  }

  const existing = await prisma.hKPublicHoliday.findMany({
    where: { date: { gte: rows[0].date, lte: rows[rows.length - 1].date } },
    select: { date: true },
  })
  const existingSet = new Set(existing.map(e => e.date.getTime()))
  console.log(`\nDB 現有（同範圍）：${existing.length} 筆`)

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN —— 唔會寫入。確認之後跑：')
    console.log(`   docker exec -w /app -e DRY_RUN=0 clinic-prod-app node import-hk-holidays.mjs ${file}`)
    rows.filter(r => r.ymd.startsWith('2026')).forEach(r => console.log(`   ${r.ymd}  ${r.name}`))
    return
  }

  let created = 0, updated = 0
  for (const r of rows) {
    // ★ date 有 @unique，upsert 令重複跑係冪等
    await prisma.hKPublicHoliday.upsert({
      where: { date: r.date },
      update: { name: r.name },
      create: { date: r.date, name: r.name },
    })
    existingSet.has(r.date.getTime()) ? updated++ : created++
  }

  console.log(`\n✅ 新增 ${created}、更新 ${updated}`)
  console.log('⚠️ 匯入之後一定要清時間帳戶快取（公眾假期影響工作日數）：')
  console.log('   DELETE FROM "TimeBank";')
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
  .finally(() => prisma.$disconnect())
