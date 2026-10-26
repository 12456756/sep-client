import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, mkdir, mkdtemp, cp, rm, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { officeManifest, verifyOfficeAssets, afterOfficePack } from './office-assets.mjs'
import { createBuilderConfig } from './generate-builder-config.mjs'
import signAdhoc from './mac-adhoc-sign.cjs'
import afterSign from './office-after-sign.cjs'

test('Office packaging keeps only the target executable and includes the common skill and licenses', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  for (const channel of ['beta', 'stable']) {
    const build = createBuilderConfig(pkg.build, channel)
    assert.equal(build.afterPack, 'scripts/speech-after-pack.cjs')
    assert.equal(build.afterSign, 'scripts/office-after-sign.cjs')
    assert.ok(build.extraResources.some(item => item.to === 'common-skills'))
    assert.ok(build.extraResources.find(item => item.to === 'office').filter.includes('LICENSE'))
    assert.ok(!build.extraResources.some(item => item.filter.some(pattern => pattern.includes('officecli-'))))
  }
  assert.equal(officeManifest.version, '1.0.156')
  assert.equal(Object.keys(officeManifest.assets).length, 4)
})

test('local and signed macOS builds preserve only the pinned Office executable signature', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  for (const signed of [false, true]) {
    const build = createBuilderConfig(pkg.build, 'beta', { signed, platform: 'darwin', env: {
      SEP_MAC_TEAM_ID: 'ABCDE12345', APPLE_KEYCHAIN_PROFILE: 'release',
    } })
    const ignored = file => build.mac.signIgnore.some(pattern => new RegExp(pattern).test(file))
    assert.equal(build.afterSign, 'scripts/office-after-sign.cjs')
    for (const arch of ['arm64', 'x64']) {
      assert.equal(ignored(`/tmp/硅基员工平台.app/Contents/Resources/office/officecli-mac-${arch}`), true)
    }
    for (const file of ['Contents/MacOS/Client', 'Contents/Resources/office/other',
      'Contents/Resources/office/officecli-mac-arm64.backup', 'Contents/Resources/other/officecli-mac-arm64']) {
      assert.equal(ignored(`/tmp/Client.app/${file}`), false)
    }
  }
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

for (const arch of ['arm64', 'x64']) {
  test(`macOS ${arch} signing preserves Office integrity and seals the bundle`, { skip: process.platform !== 'darwin' }, async t => {
    const asset = officeManifest.assets[`darwin-${arch}`]
    if (!existsSync(join('resources/office', asset.file))) { t.skip('Pinned target binary is not prepared'); return }
    const root = await mkdtemp(join(tmpdir(), 'sep-office-sign-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const app = join(root, '硅基员工平台.app')
    const resources = join(app, 'Contents/Resources')
    await mkdir(join(resources, 'office'), { recursive: true })
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true })
    await cp('/usr/bin/true', join(app, 'Contents/MacOS/Client'))
    await writeFile(join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.longdao.office-sign-test</string><key>CFBundleExecutable</key><string>Client</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    await cp('resources/common-skills', join(resources, 'common-skills'), { recursive: true })
    for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) {
      await cp(join('resources/office', name), join(resources, 'office', name))
    }
    const context = { appOutDir: root, electronPlatformName: 'darwin', arch: arch === 'arm64' ? 3 : 1,
      packager: { projectDir: resolve('.'), appInfo: { productFilename: '硅基员工平台' } } }
    await afterOfficePack(context)
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    const config = createBuilderConfig(pkg.build, 'beta')
    await signAdhoc({ app, platform: 'darwin', ignore: file => config.mac.signIgnore.some(pattern => new RegExp(pattern).test(file)) })
    const verification = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
    assert.equal(verification.status, 0, verification.stderr)
    await afterSign(context)
    const executable = join(resources, 'office', asset.file)
    assert.deepEqual(await readFile(executable), await readFile(join('resources/office', asset.file)))
    await writeFile(executable, 'substituted')
    await assert.rejects(afterSign(context), /checksum/)
    assert.notEqual(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status, 0)
  })
}
