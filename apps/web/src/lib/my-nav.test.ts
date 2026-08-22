/**
 * ★ cw-mobexp-20260822-a1: MY_NAV 三處一致性測試
 * 背景：「我的」清單原本三份硬編碼（mobile-more / my/more / layout navItems），
 *       加一頁要改三處，實際漏咗兩次（雜費入口）。現單一事實來源 = lib/my-nav.ts。
 * 跑法: cd apps/web && npx tsx --test src/lib/my-nav.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MY_NAV } from './my-nav'
import { hasPermission } from './permissions'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8')

const mmSrc = read('../app/(protected)/mobile-more/page.tsx')
const moreSrc = read('../app/(protected)/my/more/page.tsx')
const layoutSrc = read('../app/(protected)/layout.tsx')

// my/more 刻意只列五項（dashboard／班表喺底部 nav、改密碼喺其他位）—— 呢五個 key 必須係 EXTRA 全數
const MORE_EXTRA_KEYS = ['/my/leave', '/my/punches', '/my/expenses', '/my/face-enroll', '/my/notifications']

describe('MY_NAV — 單一事實來源（lib/my-nav.ts）', () => {
  it('恰好八項，href 順序固定（驗收 #6 / #8 底層）', () => {
    assert.deepEqual(
      MY_NAV.map(m => m.href),
      [
        '/my/dashboard',
        '/my/schedule',
        '/my/leave',
        '/my/punches',
        '/my/expenses',
        '/my/face-enroll',
        '/my/notifications',
        '/my/change-password',
      ],
    )
  })

  it('href 全部 /my/ 前綴 + 唯一；label 非空 + 唯一', () => {
    const hrefs = MY_NAV.map(m => m.href)
    assert.equal(new Set(hrefs).size, hrefs.length, 'href 唔可以重複')
    for (const h of hrefs) assert.ok(h.startsWith('/my/'), `href 要 /my/ 前綴：${h}`)
    const labels = MY_NAV.map(m => m.label)
    assert.equal(new Set(labels).size, labels.length, 'label 唔可以重複')
    for (const l of labels) assert.ok(l.trim().length > 0, 'label 唔可以空')
  })

  it('雜費入口恰好一次，label 統一「雜項報銷」（驗收 #5：同一功能唔應該三個名）', () => {
    const expenses = MY_NAV.filter(m => m.href === '/my/expenses')
    assert.equal(expenses.length, 1)
    assert.equal(expenses[0].label, '雜項報銷')
  })

  it('tuple 長度固定為 8（as const readonly —— .push 會 TS error，tsc gate 驗證）', () => {
    assert.equal(MY_NAV.length, 8)
  })
})

describe('三處消費者接入（source 級一致性，防再分家）', () => {
  it('mobile-more：import MY_NAV + 直接 MY_NAV.map，冇硬編碼 href 剩', () => {
    assert.match(mmSrc, /import \{ MY_NAV \} from '@\/lib\/my-nav'/)
    assert.match(mmSrc, /MY_NAV\.map\(/)
    assert.doesNotMatch(mmSrc, /href: '\/my\//, 'mobile-more 唔应该有硬編碼 /my/ href（已收歸 MY_NAV）')
  })

  it('my/more：import MY_NAV + EXTRA filter（★驗收 #7：保持五項唔多三項）', () => {
    assert.match(moreSrc, /import \{ MY_NAV \} from '@\/lib\/my-nav'/)
    assert.match(moreSrc, /MY_NAV\.filter\(m => EXTRA\[m\.href\]\)/)
    assert.doesNotMatch(moreSrc, /href: '\/my\//, 'my/more 唔应该有硬編碼 /my/ href（已收歸 MY_NAV）')
    // 五項鐵律：EXTRA keys filter 落 MY_NAV = 恰好五項，順序 = MY_NAV 順序
    const shown = MY_NAV.filter(m => MORE_EXTRA_KEYS.includes(m.href as string))
    assert.equal(shown.length, 5, 'my/more 必須保持五項（驗收 #7）')
    assert.deepEqual(
      shown.map(m => m.href),
      MORE_EXTRA_KEYS,
    )
    // dashboard／班表／改密碼唔應該入五項（佢哋喺底部 nav／其他位）
    for (const excluded of ['/my/dashboard', '/my/schedule', '/my/change-password']) {
      assert.ok(!shown.some(m => m.href === excluded), `${excluded} 唔應該喺 my/more`)
    }
  })

  it('layout navItems：import MY_NAV + MY_ICONS 八個 key 齊 + fallback ?? ClipboardList（驗收 #8 / #9）', () => {
    assert.match(layoutSrc, /import \{ MY_NAV \} from '@\/lib\/my-nav'/)
    assert.match(layoutSrc, /MY_NAV\.map\(/)
    const iconsBlock = layoutSrc.match(/const MY_ICONS[\s\S]*?\n  \}/)
    assert.ok(iconsBlock, 'layout.tsx 要有 MY_ICONS')
    const iconKeys = [...iconsBlock[0].matchAll(/'(\/my\/[a-z-]+)'/g)].map(x => x[1])
    assert.equal(iconKeys.length, 8, 'MY_ICONS 要齊八個 key（驗收 #8）')
    assert.equal(new Set(iconKeys).size, 8, 'MY_ICONS 唔可以重複 key')
    const navHrefs = new Set(MY_NAV.map(m => m.href as string))
    for (const k of iconKeys) assert.ok(navHrefs.has(k), `MY_ICONS key ${k} 要喺 MY_NAV 入面`)
    for (const h of navHrefs) assert.ok(iconKeys.includes(h), `MY_ICONS 漏咗 ${h}`)
    // 驗收 #9：漏一個 icon 唔會 crash —— 必有 fallback
    assert.match(layoutSrc, /\?\? ClipboardList/, 'icon 要有 ?? ClipboardList fallback（驗收 #9）')
  })
})

describe('§三 醫生時間表 perm — KIOSK 手機入口（驗收 #10 code 層實證）', () => {
  // 同 mobile-more/page.tsx visibleItems 一致嘅 filter 邏輯：roles OR perm（陣列 = 有其中一個就得）
  const visible = (roles: string[], perm: string | string[] | null, role: string, grant: string[], deny: string[]) => {
    if (roles.includes(role)) return true
    if (perm) {
      const perms = Array.isArray(perm) ? perm : [perm]
      if (perms.some(p => hasPermission(role, p as any, grant, deny))) return true
    }
    return false
  }

  it("mobile-more 醫生時間表 source：perm 已改陣列 [provider_schedule, scheduling]", () => {
    assert.match(mmSrc, /perm: \['provider_schedule', 'scheduling'\]/)
  })

  it('KIOSK（只有 provider_schedule，ROLE_DEFAULTS）→ 改後經 perm 支線過（★驗收 #10）', () => {
    assert.ok(hasPermission('KIOSK', 'provider_schedule' as any, [], []), '前提：KIOSK 預設有 provider_schedule')
    assert.ok(!hasPermission('KIOSK', 'scheduling' as any, [], []), '前提：KIOSK 預設冇 scheduling')
    assert.equal(visible(['OWNER', 'MANAGER'], ['provider_schedule', 'scheduling'], 'KIOSK', [], []), true,
      'KIOSK 手機應該見到醫生時間表')
  })

  it('反證：舊 perm: \'scheduling\' 單 key → KIOSK 唔過（证明呢個 fix 有效）', () => {
    assert.equal(visible(['OWNER', 'MANAGER'], 'scheduling', 'KIOSK', [], []), false)
  })

  it('OWNER 經 roles 支線過（唔受 perm 影響）；普通 EMPLOYEE 兩者都唔過', () => {
    assert.equal(visible(['OWNER', 'MANAGER'], ['provider_schedule', 'scheduling'], 'OWNER', [], []), true)
    assert.equal(visible(['OWNER', 'MANAGER'], ['provider_schedule', 'scheduling'], 'EMPLOYEE', [], []), false)
  })
})
