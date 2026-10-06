import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerLabel, missingNameZh, normProviderName, duplicateNameIds } from './provider-label'

test('providerLabel：簡稱 · 中文全名', () => {
  assert.equal(providerLabel({ name: 'Dr.Ho', nameZh: '何嘉俊' }), 'Dr.Ho · 何嘉俊')
  assert.equal(providerLabel({ name: ' Dr.Ho ', nameZh: ' 何嘉俊 ' }), 'Dr.Ho · 何嘉俊')
})

test('providerLabel：未填中文全名 → 淨簡稱', () => {
  assert.equal(providerLabel({ name: 'Dr.Ho Pak Hei', nameZh: null }), 'Dr.Ho Pak Hei')
  assert.equal(providerLabel({ name: 'Dr.Ho', nameZh: '  ' }), 'Dr.Ho')
  assert.equal(providerLabel({ name: 'Dr.Ho' }), 'Dr.Ho')
})

test('providerLabel：簡稱空 → 淨中文全名', () => {
  assert.equal(providerLabel({ name: '', nameZh: '何嘉俊' }), '何嘉俊')
})

test('missingNameZh', () => {
  assert.equal(missingNameZh({ name: 'Dr.Ho', nameZh: null }), true)
  assert.equal(missingNameZh({ name: 'Dr.Ho', nameZh: ' ' }), true)
  assert.equal(missingNameZh({ name: 'Dr.Ho', nameZh: '何嘉俊' }), false)
})

test('normProviderName：大細階／空格／點唔理', () => {
  assert.equal(normProviderName('Dr. Ho'), normProviderName('dr.ho'))
  assert.equal(normProviderName('DR HO'), normProviderName('Dr.Ho'))
  assert.notEqual(normProviderName('Dr.Ho'), normProviderName('Dr.Ho Pak Hei'))
})

test('duplicateNameIds：同簡稱嘅醫生全部標出，唔同嘅唔標', () => {
  const dup = duplicateNameIds([
    { id: 'a', name: 'Dr.Ho' },
    { id: 'b', name: 'Dr. Ho' },
    { id: 'c', name: 'Dr.Ho Pak Hei' },
    { id: 'd', name: 'Dr.Lau' },
    { id: 'e', name: '' },
    { id: 'f', name: '' },
  ])
  assert.deepEqual([...dup].sort(), ['a', 'b'])
})
