import * as assert from 'node:assert/strict'
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WindowCloseSettings } from './window-close-settings'

test('close preference survives reload and missing/invalid settings safely ask', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'window-close-'))
  const file = join(directory, 'window-close.json')
  t.after(async () => { await rm(file, { force: true }); await rmdir(directory) })
  const settings = new WindowCloseSettings(directory)
  assert.equal(await settings.read(), 'ask')
  for (const behavior of ['minimize', 'quit', 'ask'] as const) {
    await settings.write(behavior)
    assert.equal(await new WindowCloseSettings(directory).read(), behavior)
  }
  await writeFile(file, '{"version":2,"behavior":"quit"}')
  assert.equal(await settings.read(), 'ask')
})
