import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { SkillImportDeviceStore, type SkillImportEncryption } from './skill-import-device-store'

function encryption(available = true, backend = 'keychain'): SkillImportEncryption {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: value => Buffer.from(value, 'utf8').toString('base64'),
    decryptString: value => Buffer.from(value, 'base64').toString('utf8'),
  }
}

async function setup(secure = true) {
  const dir = await mkdtemp(join(tmpdir(), 'sep-skill-device-'))
  const store = new SkillImportDeviceStore({ file: join(dir, 'devices.json'), osUserId: 'os-user-a', encryption: encryption(secure) })
  return { dir, store }
}

function input(store: SkillImportDeviceStore, rememberDevice = true) {
  const identity = store.createIdentity()
  return {
    identity,
    value: {
      instanceId: 'stable', ownerUserId: 'device-owner', deviceId: 'device-1', keyFingerprint: identity.keyFingerprint,
      label: 'This Mac', platform: 'darwin', clientVersion: '0.3.2', scope: 'user' as const,
      rootIds: ['root-b', 'root-a', 'root-a'], roots: [
        { rootId: 'root-a', label: 'Personal', path: '/private/a', scope: 'user' as const, sources: ['codex'] },
        { rootId: 'root-b', label: 'Project', path: '/private/b', scope: 'project' as const, sources: ['shared'] },
      ], privateKeyPkcs8: identity.privateKeyPkcs8, rememberDevice,
    },
  }
}

describe('SkillImportDeviceStore', () => {
  it('persists encrypted bindings and never exposes paths in views', async () => {
    const { dir, store } = await setup()
    try {
      const created = input(store)
      const saved = await store.saveBinding(created.value)
      assert.equal(saved.persisted, true)
      assert.deepEqual(saved.binding.rootIds, ['root-a', 'root-b'])
      assert.equal('path' in saved.binding.roots[0]!, false)
      const raw = await readFile(join(dir, 'devices.json'), 'utf8')
      assert.equal(raw.includes(created.identity.privateKeyPkcs8), false)
      const loaded = await store.findBinding({ instanceId: 'stable', ownerUserId: 'device-owner', rootIds: ['root-b', 'root-a'] })
      assert.equal(loaded?.privateKeyPkcs8, created.identity.privateKeyPkcs8)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps a non-persistent identity only in memory when encryption is unavailable', async () => {
    const { dir, store } = await setup(false)
    try {
      const created = input(store)
      const saved = await store.saveBinding(created.value)
      assert.equal(saved.persisted, false)
      assert.equal((await store.getBinding('device-1'))?.privateKeyPkcs8, created.identity.privateKeyPkcs8)
      await assert.rejects(readFile(join(dir, 'devices.json')))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects persistence on the basic_text backend', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sep-skill-device-'))
    const store = new SkillImportDeviceStore({ file: join(dir, 'devices.json'), osUserId: 'os-user-a', encryption: encryption(true, 'basic_text') })
    try { assert.equal(store.canPersist(), false); assert.equal((await store.saveBinding(input(store).value)).persisted, false) }
    finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('isolates bindings by operating system user and keeps pending revocation unusable', async () => {
    const { dir, store } = await setup()
    try {
      await store.saveBinding(input(store).value)
      await store.markRevokePending('device-1')
      assert.equal(await store.findBinding({ instanceId: 'stable', ownerUserId: 'device-owner' }), null)
      assert.equal((await store.listBindings())[0]?.revokePending, true)
      await store.confirmRevoke('device-1')
      assert.equal((await store.listBindings()).length, 0)
      const other = new SkillImportDeviceStore({ file: join(dir, 'devices.json'), osUserId: 'os-user-b', encryption: encryption() })
      assert.equal((await other.listBindings()).length, 0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('scopes device disable and revocation by instance when device ids collide', async () => {
    const { dir, store } = await setup()
    try {
      const first = input(store)
      const second = input(store)
      second.value.instanceId = 'preview'
      await store.saveBinding(first.value)
      await store.saveBinding(second.value)

      await store.markRevokePending('device-1', 'stable')
      assert.equal((await store.getBinding('device-1', 'stable'))?.revokePending, true)
      assert.equal((await store.getBinding('device-1', 'preview'))?.revokePending, false)

      await store.confirmRevoke('device-1', 'stable')
      assert.equal(await store.getBinding('device-1', 'stable'), null)
      assert.equal((await store.getBinding('device-1', 'preview'))?.instanceId, 'preview')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
