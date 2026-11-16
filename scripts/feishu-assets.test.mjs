import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { zipSync, strToU8 } from 'fflate'
import { prepareFeishu } from './feishu-assets.mjs'

async function fixture(platform) {
  const root = await mkdtemp(join(process.env.CSEP_TEST_TEMP ?? tmpdir(), 'feishu-assets-'))
  const name = `lark-cli-1.0.100-${platform === 'win32' ? 'windows-amd64.zip' : 'darwin-arm64.tar.gz'}`
  const cache = join(root, 'assets')
  await mkdir(cache)
  let bytes
  if (platform === 'win32') bytes = zipSync({ 'lark-cli.exe': strToU8('verified-fixture-code') })
  else {
    await writeFile(join(root, 'lark-cli'), 'verified-fixture-code')
    execFileSync('tar', ['-czf', join(cache, name), '-C', root, 'lark-cli'], { windowsHide: true })
    bytes = await readFile(join(cache, name))
  }
  await writeFile(join(cache, name), bytes)
  await writeFile(join(root, 'checksums.txt'), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)
  await writeFile(join(root, 'package.json'), '{"version":"1.0.100"}')
  await writeFile(join(root, 'LICENSE'), 'MIT fixture notice')
  return { root, cache, name, bytes }
}
test('Feishu packages verified native Windows and macOS executables with notices', async () => {
  for (const platform of ['win32', 'darwin']) {
    const f = await fixture(platform)
    const target = await prepareFeishu(join(f.root, 'output'), platform, platform === 'win32' ? 'x64' : 'arm64', f.root, async () => { throw new Error('Unexpected network') })
    assert.equal(await readFile(target, 'utf8'), 'verified-fixture-code')
    assert.equal(await readFile(join(f.root, 'output', 'LICENSE'), 'utf8'), 'MIT fixture notice')
  }
})
test('Feishu repairs a tampered cache only with matching pinned checksums', async () => {
  const f = await fixture('win32')
  await writeFile(join(f.cache, f.name), 'tampered')
  let downloads = 0
  await prepareFeishu(join(f.root, 'output'), 'win32', 'x64', f.root, async url => { downloads++; assert.match(String(url), /^https:\/\/github.com\/larksuite\/cli\/releases\/download\/v1\.0\.100\//); return new Response(f.bytes) })
  assert.equal(downloads, 1)
  await writeFile(join(f.cache, f.name), 'tampered-again')
  await assert.rejects(prepareFeishu(join(f.root, 'rejected'), 'win32', 'x64', f.root, async () => new Response('unverified')))
})
