import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { prepareWecom } from './wecom-assets.mjs'

test('WeCom verifies pinned archives for Windows and macOS and rejects tampering or unsupported targets', async () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64']]) {
    const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'wecom-assets-'))
    await mkdir(join(root, 'package', 'bin'), { recursive: true })
    await mkdir(join(root, 'assets'))
    const executable = platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli'
    await writeFile(join(root, 'package', 'bin', executable), 'verified-native-code')
    await writeFile(join(root, 'package.json'), '{"version":"1.3.4"}')
    await writeFile(join(root, 'LICENSE'), 'fixture MIT notice')
    const archive = join(root, 'assets', `cli-${platform}-${arch}-1.3.4.tgz`)
    execFileSync('tar', ['-czf', archive, '-C', root, `package/bin/${executable}`], { windowsHide: true })
    const bytes = await readFile(archive)
    const manifest = { version: '1.3.4', integrities: { [`${platform}-${arch}`]: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } }
    const destination = join(root, 'output')
    const target = await prepareWecom(destination, platform, arch, root, async () => { throw new Error('Unexpected network') }, manifest)
    assert.equal(await readFile(target, 'utf8'), 'verified-native-code')
    assert.equal(await readFile(join(destination, 'LICENSE'), 'utf8'), 'fixture MIT notice')
    await writeFile(archive, 'tampered')
    await assert.rejects(prepareWecom(destination, platform, arch, root, async () => new Response('invalid'), manifest), /checksum/)
    await assert.rejects(prepareWecom(destination, 'win32', 'arm64', root, undefined, manifest), /Unsupported/)
  }
})
