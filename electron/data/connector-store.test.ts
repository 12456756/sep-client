import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ConnectorStore } from './connector-store'
import { ScopePath } from './scope-path'

test('connector storage encrypts credentials, isolates owner and clears without plaintext backups', async () => {
  const dir = await mkdtemp(resolve('..', '20261112-钉钉接入测试', 'work', 'oauth-store-'))
  const key = randomBytes(32)
  const store = new ConnectorStore(dir, {
    available: () => true,
    encrypt: value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64') },
    decrypt: value => { const data = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8') },
  })
  const owner = { enterpriseId: 'a', memberId: 'member' }
  const value = { access_token: 'fixture-sensitive-token' }
  await store.write(owner, value)
  assert.deepEqual(await store.read(owner), value)
  assert.equal(await store.read({ ...owner, memberId: 'other' }), undefined)
  assert.equal(await store.read({ ...owner, enterpriseId: 'other' }), undefined)
  const path = join(new ScopePath(dir).ownerRoot(owner), 'connectors', 'dingtalk.json')
  assert.doesNotMatch(await readFile(path, 'utf8'), /fixture-sensitive-token|access_token/)
  await store.write(owner, null)
  assert.equal(await store.read(owner), null)
  await assert.rejects(readFile(path + '.bak'))
  await writeFile(path, '{broken')
  await assert.rejects(store.read(owner), /Cannot read secure/)
  const unavailable = new ConnectorStore(dir, { available: () => false, encrypt: () => '', decrypt: () => '' })
  await assert.rejects(unavailable.write(owner, value), /unavailable/)
  await assert.rejects(unavailable.read(owner), /unavailable/)
})
