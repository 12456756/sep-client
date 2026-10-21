import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { speechDirectory, speechManifest, verifySpeechAssets, verifySpeechFile } from './speech-assets.mjs'

if (process.argv.slice(2).some(arg => arg !== '--test-audio') || process.argv.length > 3) throw new Error('usage: node scripts/prepare-speech-assets.mjs [--test-audio]')
for (const asset of speechManifest.files) {
  if (asset.path === 'test_wavs/zh.wav' && !process.argv.includes('--test-audio')) continue
  const destination = join(speechDirectory, asset.path)
  try { await verifySpeechFile(destination, asset); console.log(`Verified: ${asset.path}`); continue } catch { /* Download missing or damaged pinned assets. */ }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.download`
  try {
    console.log(`Downloading pinned speech asset: ${asset.path}`)
    const response = await fetch(`${speechManifest.repository}/resolve/${speechManifest.revision}/${asset.path}`, { signal: AbortSignal.timeout(900_000) })
    if (!response.ok || !response.body) throw new Error(`Speech download failed (${response.status})`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary), { signal: AbortSignal.timeout(900_000) })
    await verifySpeechFile(temporary, asset)
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
}
await verifySpeechAssets()
console.log('Pinned speech model and vocabulary verified; recognition needs no downloads.')
