import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LocalMediaSettingsStore } from '../data/local-media-settings-store'
import { LocalMediaSettingsService } from './local-media-settings-service'

test('the selected scratch location persists and never falls back if removed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'csep-settings-test-')))
  try {
    const defaultPath = join(root, 'default')
    const custom = join(root, '自定义位置')
    const service = new LocalMediaSettingsService(new LocalMediaSettingsStore(root), defaultPath, true)
    assert.equal(await service.prepare(), defaultPath)
    await mkdir(custom)
    await assert.rejects(service.configure(custom, () => { throw new Error('session changed') }), /session changed/)
    assert.equal((await service.settings()).custom, false)
    await service.configure(custom, () => undefined)
    const reopened = new LocalMediaSettingsService(new LocalMediaSettingsStore(root), defaultPath, true)
    assert.equal(await reopened.prepare(), custom)
    await rmdir(custom)
    await assert.rejects(reopened.prepare(), /目录不可用/)
    await reopened.configure(null, () => undefined)
    assert.equal(await reopened.prepare(), defaultPath)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('default scratch uses the generated file location unless scratch is explicitly configured', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'csep-settings-test-')))
  try {
    const selected = join(root, 'generated'), internal = join(root, 'internal'), custom = join(root, 'custom')
    await mkdir(selected)
    const service = new LocalMediaSettingsService(new LocalMediaSettingsStore(root), internal, true, async () => selected)
    assert.equal((await service.settings()).path, join(selected, '.csep-media-temp'))
    assert.equal(await service.prepare(), join(selected, '.csep-media-temp'))
    await rmdir(join(selected, '.csep-media-temp'))
    await rmdir(selected)
    await assert.rejects(service.prepare(), /目录不可用/)
    await mkdir(custom)
    await service.configure(custom, () => undefined)
    assert.equal(await service.prepare(), custom)
  } finally { await rm(root, { recursive: true, force: true }) }
})
