import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDingTalk, afterDingTalkPack } from './dingtalk-assets.mjs'

test('pinned DingTalk archives prepare independent Windows and macOS binaries with notices', async () => {
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'dingtalk-package-'))
  const win = await prepareDingTalk(join(root, 'windows'), 'win32', 'x64')
  assert.equal((await readFile(win)).subarray(0, 2).toString(), 'MZ')
  assert.match(await readFile(join(root, 'windows', 'LICENSE'), 'utf8'), /Apache License/)
  const context = { arch: 3, electronPlatformName: 'darwin', appOutDir: join(root, 'mac'), packager: { appInfo: { productFilename: 'Client' } } }
  await afterDingTalkPack(context)
  const mac = await readFile(join(root, 'mac/Client.app/Contents/Resources/dingtalk/dws'))
  assert.equal(mac.readUInt32LE(0), 0xfeedfacf)
  await assert.rejects(prepareDingTalk(join(root, 'unsupported'), 'win32', 'ia32'), /Unsupported/)
})
