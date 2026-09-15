/**
 * phone.ts 單測（cwi-followup-p0-20260915 S1 — MD §1.2 逐字 spec）
 *
 * 覆蓋：8 位本地號／11 位 852／+852／19 字多號／其他國家／唔合法／去重／空值。
 * 固定向量錨定（同 phone-hash.test.ts 慣例）— normalize 行為鎖死，
 * 改咗 spec 要同步改 MD §1.2 同 W 側。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHkPhones, phoneHashes } from './phone'

const KEY = 'phone-test-key-fup0-0123456789abcdef'

// 固定向量（HMAC-SHA256 over E.164，KEY 如上）
const H_PLUS852_9123 = '3f2b21b65d326ef050ad31a6f2acf099dff8b2e3aa9b8624fb77d32dc9fe094b' // +85291234567
const H_PLUS852_6123 = '5f3a32e797caf75bb44877935fa53b6b1973a80fa7619215d856c353df9a0291' // +85261234567
const H_PLUS852_2312 = '4d8318b66d69df7636a35e06e17534bc3c5cbf5a1df7d67a50b8de44675a00b1' // +85223123456

describe('normalizeHkPhones — HK 正規化 + 多號', () => {
  it('8 位本地號（2-9 開頭）→ +852 前綴', () => {
    assert.deepEqual(normalizeHkPhones('91234567'), ['+85291234567'])
    assert.deepEqual(normalizeHkPhones('61234567'), ['+85261234567'])
    assert.deepEqual(normalizeHkPhones('23123456'), ['+85223123456'])
  })

  it('11 位 852 開頭（無 +）→ 補 +', () => {
    assert.deepEqual(normalizeHkPhones('85291234567'), ['+85291234567'])
  })

  it('+852 開頭 → 原樣', () => {
    assert.deepEqual(normalizeHkPhones('+85291234567'), ['+85291234567'])
  })

  it('19 字多號（852 號 + 本地號，分隔符）→ 兩個 E.164', () => {
    assert.deepEqual(normalizeHkPhones('85291234567 61234567'), ['+85291234567', '+85261234567'])
    assert.deepEqual(normalizeHkPhones('85291234567,61234567'), ['+85291234567', '+85261234567'])
    assert.deepEqual(normalizeHkPhones('91234567;61234567'), ['+85291234567', '+85261234567'])
    assert.deepEqual(normalizeHkPhones('91234567、61234567'), ['+85291234567', '+85261234567'])
  })

  it('號內空位 = 分隔符（MD spec 逐字：fragment 各 4 位唔合法 → 丟）', () => {
    // 「9123 4567 / 6123 4567」→ split 後 ['9123','4567','6123','4567'] → 全唔合法 → []
    // （MD §1.2 逐字行為 — S4 驗證腳本會量真數據影響；如 <90% 停手檢討）
    assert.deepEqual(normalizeHkPhones('9123 4567 / 6123 4567'), [])
    assert.deepEqual(normalizeHkPhones('+852 9123 4567'), []) // 同理：+852 / 9123 / 4567 → 全丟
  })

  it('其他國家（+ 開頭 8-15 位）→ 原樣保留', () => {
    assert.deepEqual(normalizeHkPhones('+6591234567'), ['+6591234567'])
    assert.deepEqual(normalizeHkPhones('+14155552671'), ['+14155552671'])
    assert.deepEqual(normalizeHkPhones('+819012345678'), ['+819012345678'])
  })

  it('唔合法 → 丟', () => {
    assert.deepEqual(normalizeHkPhones('12345'), []) // 太短
    assert.deepEqual(normalizeHkPhones('11111111'), []) // 8 位但 1 開頭（唔係 HK 本地）
    assert.deepEqual(normalizeHkPhones('01234567'), []) // 0 開頭
    assert.deepEqual(normalizeHkPhones('123456789012345678901'), []) // 太長
  })

  it('空值 → 空陣列', () => {
    assert.deepEqual(normalizeHkPhones(''), [])
    assert.deepEqual(normalizeHkPhones(null), [])
    assert.deepEqual(normalizeHkPhones(undefined), [])
    assert.deepEqual(normalizeHkPhones('   /  , '), []) // 淨分隔符
  })

  it('去重（同義寫法正規化後同值 → 一條）', () => {
    assert.deepEqual(normalizeHkPhones('91234567 / 91234567'), ['+85291234567'])
    assert.deepEqual(normalizeHkPhones('91234567,85291234567'), ['+85291234567']) // 本地 8 位 vs 852 11 位 → 同一 E.164
    assert.deepEqual(normalizeHkPhones('+85291234567 91234567'), ['+85291234567'])
  })
})

describe('phoneHashes — 多號 HMAC-SHA256', () => {
  it('固定向量錨定（canon hash = 預計算值）', () => {
    assert.deepEqual(phoneHashes('91234567', KEY), [H_PLUS852_9123])
    assert.deepEqual(phoneHashes('+85291234567', KEY), [H_PLUS852_9123]) // 同 E.164 → 同 hash
    assert.deepEqual(phoneHashes('85291234567', KEY), [H_PLUS852_9123])
    assert.deepEqual(phoneHashes('61234567', KEY), [H_PLUS852_6123])
    assert.deepEqual(phoneHashes('23123456', KEY), [H_PLUS852_2312])
  })

  it('多號 → 逐個 hash（順序保留）', () => {
    assert.deepEqual(phoneHashes('85291234567 61234567', KEY), [H_PLUS852_9123, H_PLUS852_6123])
    assert.deepEqual(phoneHashes('85291234567,61234567', KEY), [H_PLUS852_9123, H_PLUS852_6123])
  })

  it('hash 長度 64 hex + 同 length 對 normalized 數目', () => {
    const out = phoneHashes('85291234567,61234567,+6591234567', KEY)
    assert.equal(out.length, 3)
    for (const h of out) assert.match(h, /^[0-9a-f]{64}$/)
    assert.deepEqual(out.slice(0, 2), [H_PLUS852_9123, H_PLUS852_6123])
  })

  it('空/全唔合法 → 空陣列', () => {
    assert.deepEqual(phoneHashes('', KEY), [])
    assert.deepEqual(phoneHashes(null, KEY), [])
    assert.deepEqual(phoneHashes('abc 12345', KEY), [])
  })

  it('key 唔同 → hash 唔同（key 係 part of 算法）', () => {
    const other = 'another-test-key-0123456789abcdef0123456789abcdef'
    assert.notEqual(phoneHashes('91234567', other)[0], H_PLUS852_9123)
  })
})
