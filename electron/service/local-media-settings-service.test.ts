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
