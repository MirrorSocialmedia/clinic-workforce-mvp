/**
 * ★ cwm-datasource-20261003：資料來源設定 —— 憑證解析／健康／編號格式
 * 跑法: TZ=UTC npx tsx --test src/lib/apricot/source-pure.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCredentialInput, credentialHealth, keywordPattern, parsePrefixList, nextSourceAccount } from './source-pure'

const A = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-_A'
const R = 'r3fr3sh.t0ken_value-1'

describe('parseCredentialInput', () => {
  it('瀏覽器 Copy request headers（cookie 行）', () => {
    const text = `accept: application/json\ncookie: lang=zh; access_token=${A}; refresh_token=${R}; iat=1759460000\nuser-agent: x`
    assert.deepEqual(parseCredentialInput({ cookie: text }), { ok: true, creds: { accessToken: A, refreshToken: R, iat: '1759460000' } })
  })
  it('DevTools Cookies 表逐行（Tab 分隔）', () => {
    const text = `access_token\t${A}\t.example.test\t/\nrefresh_token\t${R}\t.example.test\t/\niat\t1759460000\t.example.test\t/`
    const r = parseCredentialInput({ cookie: text })
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.creds.refreshToken, R)
  })
  it('三格分開填優先', () => {
    const r = parseCredentialInput({ cookie: `access_token=OLD; refresh_token=${R}; iat=1759460000`, accessToken: ` ${A} ` })
    assert.equal(r.ok && r.creds.accessToken, A)
  })
  it('唔會將 x_access_token 當 access_token', () => {
    const r = parseCredentialInput({ cookie: `x_access_token=BAD; refresh_token=${R}; iat=1759460000` })
    assert.deepEqual(r, { ok: false, error: '搵唔到 access_token' })
  })
  it('缺欄／iat 格式錯', () => {
    assert.deepEqual(parseCredentialInput({ cookie: '' }), { ok: false, error: '搵唔到 access_token、refresh_token、iat' })
    assert.deepEqual(parseCredentialInput({ accessToken: A, refreshToken: R, iat: '123' }), { ok: false, error: 'iat 應該係 10 位數字' })
  })
})

describe('credentialHealth', () => {
  const now = new Date('2026-10-03T04:00:00Z')
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000)
  it('冇 row = 未設定', () => assert.equal(credentialHealth(null, now).code, 'MISSING'))
  it('auth failed = 失效（error）', () => {
    const r = credentialHealth({ lastOkAt: ago(1), lastError: 'auth failed HTTP 401', refreshExpiry: null }, now)
    assert.deepEqual([r.level, r.code], ['error', 'EXPIRED'])
  })
  it('refreshExpiry 已過 = 失效', () => assert.equal(credentialHealth({ lastOkAt: ago(1), lastError: null, refreshExpiry: ago(1) }, now).code, 'EXPIRED'))
  it('限流 = warn', () => assert.equal(credentialHealth({ lastOkAt: ago(1), lastError: 'rate limited 429', refreshExpiry: null }, now).level, 'warn'))
  it('啱貼未驗證', () => assert.equal(credentialHealth({ lastOkAt: null, lastError: null, refreshExpiry: null }, now).code, 'UNVERIFIED'))
  it('兩日內過期／超過一日冇連線', () => {
    assert.equal(credentialHealth({ lastOkAt: ago(1), lastError: null, refreshExpiry: new Date(now.getTime() + 3600_000) }, now).code, 'EXPIRING')
    assert.equal(credentialHealth({ lastOkAt: ago(30), lastError: null, refreshExpiry: null }, now).code, 'STALE')
  })
  it('正常', () => assert.equal(credentialHealth({ lastOkAt: ago(0.2), lastError: null, refreshExpiry: new Date(now.getTime() + 6 * 86400_000) }, now).level, 'ok'))
})

describe('編號格式／前綴／代號', () => {
  it('keywordPattern', () => {
    assert.equal(keywordPattern('003213'), 'NUMERIC')
    assert.equal(keywordPattern('tw007446'), 'PREFIXED')
    assert.equal(keywordPattern('陳大文'), null)
  })
  it('parsePrefixList', () => assert.deepEqual(parsePrefixList('tkw, TK、tk  1x'), ['TKW', 'TK']))
  it('nextSourceAccount', () => assert.equal(nextSourceAccount(['MAIN', 'TY', 's2']), 'S3'))
})
