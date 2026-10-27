import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelPreferenceKey, readDefaultModel, resolveTaskModel, saveDefaultModel } from './model-preferences'

const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
function storagePort(rows = new Map<string, string>()) {
  return { rows, getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value) } }
}

test('default model survives a new reader and is isolated by enterprise and member', () => {
  const storage = storagePort()
  const key = modelPreferenceKey(scope)!
  assert.equal(saveDefaultModel(storage, key, 'gpt-test'), true)
  assert.equal(readDefaultModel(storagePort(storage.rows), key), 'gpt-test')
  for (const other of [{ ...scope, enterpriseId: 'enterprise-b' }, { ...scope, memberId: 'member-b' }]) {
    assert.equal(readDefaultModel(storage, modelPreferenceKey(other)), '')
  }
  assert.notEqual(modelPreferenceKey({ enterpriseId: 'a:b', memberId: 'c' }), modelPreferenceKey({ enterpriseId: 'a', memberId: 'b:c' }))
  assert.deepEqual(JSON.parse(storage.rows.get(key)!), { version: 1, defaultModelId: 'gpt-test' })
})

test('following the system default clears the saved model without changing the scope', () => {
  const storage = storagePort(), key = modelPreferenceKey(scope)!
  saveDefaultModel(storage, key, 'gpt-test')
  assert.equal(saveDefaultModel(storage, key, ''), true)
  assert.equal(readDefaultModel(storage, key), '')
})

test('missing identity cannot read or save an unscoped model preference', () => {
  const storage = storagePort()
  for (const key of [modelPreferenceKey(null), modelPreferenceKey({ ...scope, memberId: '' }), modelPreferenceKey({ ...scope, enterpriseId: ' ' })]) {
    assert.equal(key, null)
    assert.equal(readDefaultModel(storage, key), '')
    assert.equal(saveDefaultModel(storage, key, 'gpt-test'), false)
  }
  assert.equal(storage.rows.size, 0)
})

test('invalid, oversized, private or unknown-version stored values are ignored', () => {
  const storage = storagePort(), key = modelPreferenceKey(scope)!
  for (const raw of ['{', 'x'.repeat(4097), 'null', JSON.stringify({ version: 2, defaultModelId: 'gpt' }),
    JSON.stringify({ version: 1, defaultModelId: 1 }), JSON.stringify({ version: 1, defaultModelId: 'x'.repeat(513) }),
    JSON.stringify({ version: 1, defaultModelId: 'gpt', token: 'private' })]) {
    storage.rows.set(key, raw)
    assert.equal(readDefaultModel(storage, key), '')
  }
  assert.equal(saveDefaultModel(storage, key, 'x'.repeat(513)), false)
})

test('storage denial falls back on read and reports unsuccessful saves', () => {
  const denied = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(readDefaultModel(denied, 'key'), '')
  assert.equal(readDefaultModel(null, 'key'), '')
  assert.equal(saveDefaultModel(denied, 'key', 'gpt'), false)
  assert.equal(saveDefaultModel(null, 'key', 'gpt'), false)
})

test('explicit task selection wins over the default and model ordering changes', () => {
  assert.equal(resolveTaskModel(['first', 'gpt', 'manual'], 'gpt', 'manual'), 'manual')
  assert.equal(resolveTaskModel(['gpt', 'first', 'manual'], 'first', 'manual'), 'manual')
})

test('new tasks use an authorized default or fall back without mutating the preference', () => {
  assert.equal(resolveTaskModel(['first', 'gpt'], 'gpt'), 'gpt')
  assert.equal(resolveTaskModel(['first'], 'gpt'), 'first')
  assert.equal(resolveTaskModel(['first', 'gpt'], 'gpt', 'revoked'), 'gpt')
  assert.equal(resolveTaskModel([], 'gpt', 'manual'), '')
  assert.equal(resolveTaskModel(['first', 'second'], ''), 'first')
})
