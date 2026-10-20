import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SpeechSettingsStore } from './speech-settings-store'
import { SPEECH_MODEL_ASSETS } from './speech-assets'

describe('persistent local speech consent', () => {
  it('survives restarts and never stores transcripts or restores an old grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-speech-consent-'))
    try {
      const store = new SpeechSettingsStore(root)
      assert.equal(await store.read(), 'prompt')
      await store.write('granted')
      assert.equal(await new SpeechSettingsStore(root).read(), 'granted')
      await store.write('denied')
      assert.deepEqual(JSON.parse(await readFile(join(root, 'speech', 'settings.json'), 'utf8')), { version: 1, permission: 'denied' })
      await writeFile(join(root, 'speech', 'settings.json.bak'), JSON.stringify({ version: 1, permission: 'granted' }))
      await writeFile(join(root, 'speech', 'settings.json'), '{broken')
      assert.equal(await store.read(), 'denied')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('fails closed for unreadable or invalid authorization files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-speech-consent-'))
    try {
      await mkdir(join(root, 'speech', 'settings.json'), { recursive: true })
      assert.equal(await new SpeechSettingsStore(root).read(), 'denied')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('pins exactly the assets verified by the successful offline POC', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../resources/speech/sensevoice-int8/manifest.json', import.meta.url), 'utf8')) as { files: { path: string; bytes: number; sha256?: string; gitSha1?: string }[] }
    for (const asset of SPEECH_MODEL_ASSETS) {
      const expected = manifest.files.find(file => file.path === asset.path)!
      assert.equal(asset.bytes, expected.bytes)
      assert.equal(asset.hash, expected.sha256 ?? expected.gitSha1)
    }
  })
})
