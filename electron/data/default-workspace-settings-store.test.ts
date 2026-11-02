import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DefaultWorkspaceSettingsStore } from './default-workspace-settings-store'

describe('default workspace settings store', () => {
  it('persists and clears the configured parent directory across instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-default-workspace-'))
    try {
      const store = new DefaultWorkspaceSettingsStore(root)
      const path = join(root, 'work')
      assert.equal(await store.read(), null)
      await store.write(path)
      assert.equal(await new DefaultWorkspaceSettingsStore(root).read(), path)
      assert.deepEqual(JSON.parse(await readFile(join(root, 'workspace', 'settings.json'), 'utf8')), { version: 1, path })
      await store.write(null)
      assert.equal(await store.read(), null)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails closed for malformed settings and rejects relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-default-workspace-'))
    try {
      const store = new DefaultWorkspaceSettingsStore(root)
      await writeFile(join(root, 'unrelated.json'), '{}')
      await store.write(join(root, 'workspace'))
      await writeFile(join(root, 'workspace', 'settings.json'), '{broken')
      assert.equal(await store.read(), null)
      assert.equal(await store.write('relative/path').then(() => false, () => true), true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
