import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, mkdtemp, cp, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { officeManifest, verifyOfficeAssets, afterOfficePack } from './office-assets.mjs'
import { createBuilderConfig } from './generate-builder-config.mjs'

test('Office packaging keeps only the target executable and includes the common skill and licenses', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  for (const channel of ['beta', 'stable']) {
    const build = createBuilderConfig(pkg.build, channel)
    assert.equal(build.afterPack, 'scripts/speech-after-pack.cjs')
    assert.ok(build.extraResources.some(item => item.to === 'common-skills'))
    assert.ok(build.extraResources.find(item => item.to === 'office').filter.includes('LICENSE'))
    assert.ok(!build.extraResources.some(item => item.filter.some(pattern => pattern.includes('officecli-'))))
  }
  assert.equal(officeManifest.version, '1.0.156')
  assert.equal(Object.keys(officeManifest.assets).length, 4)
})

test('Office packaging fails rather than silently shipping missing resources', async () => {
  await assert.rejects(verifyOfficeAssets('missing-office-resources', 'win32', 'x64'))
  await assert.rejects(verifyOfficeAssets('missing-office-resources', 'darwin', 'ia32'), /not bundled/)
})

test('Office afterPack copies exactly the unmodified target binary', async t => {
  const asset = officeManifest.assets[`${process.platform}-${process.arch}`]
  if (!asset || !existsSync(join('resources/office', asset.file))) { t.skip('Pinned target binary is not prepared'); return }
  const root = await mkdtemp(join(tmpdir(), 'sep-office-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resources = process.platform === 'darwin' ? join(root, 'SEP.app/Contents/Resources') : join(root, 'resources')
  await mkdir(join(resources, 'office'), { recursive: true })
  await cp('resources/common-skills', join(resources, 'common-skills'), { recursive: true })
  for (const file of ['manifest.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) {
    await cp(join('resources/office', file), join(resources, 'office', file))
  }
  await afterOfficePack({ appOutDir: root, electronPlatformName: process.platform,
    arch: process.arch === 'arm64' ? 3 : 1, packager: { projectDir: resolve('.'), appInfo: { productFilename: 'SEP' } } })
  assert.deepEqual((await readdir(join(resources, 'office'))).filter(file => file.startsWith('officecli-')), [asset.file])
  await verifyOfficeAssets(resources, process.platform, process.arch)
})
