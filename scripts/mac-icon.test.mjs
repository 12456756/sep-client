import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { executeAppBuilderAsJson, executeAppBuilderAndWriteJson } from 'app-builder-lib/out/util/appBuilder.js'
import yaml from 'js-yaml'
import { afterMacIconPack } from './mac-icon.mjs'

const root = resolve(import.meta.dirname, '..')
const iconName = 'mac-icon'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sep-mac-icon-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const contents = join(directory, 'Client with spaces.app', 'Contents')
  const resources = join(contents, 'Resources')
  await mkdir(resources, { recursive: true })
  const plist = join(contents, 'Info.plist')
  const original = { CFBundleIdentifier: 'cn.longdao.test', CFBundleIconFile: 'legacy.icns',
    CFBundleShortVersionString: '0.5.8', NSMicrophoneUsageDescription: 'Keep microphone permission',
    ElectronAsarIntegrity: { 'Resources/app.asar': { algorithm: 'SHA256', hash: 'fixture' } } }
  await executeAppBuilderAndWriteJson(['encode-plist'], { [plist]: original })
  await writeFile(join(resources, 'legacy.icns'), 'legacy-icon-fixture')
  const calls = []
  const runner = async (command, args) => {
    calls.push({ command, args })
    const output = args[args.indexOf('--compile') + 1]
    await writeFile(join(output, 'Assets.car'), 'native-catalog-fixture')
    const partial = args[args.indexOf('--output-partial-info-plist') + 1]
    await executeAppBuilderAndWriteJson(['encode-plist'], { [partial]: { CFBundleIconName: iconName, CFBundleIconFile: `${iconName}.icns` } })
    return { stdout: '', stderr: '' }
  }
  const context = { electronPlatformName: 'darwin', appOutDir: directory,
    packager: { projectDir: root, appInfo: { productFilename: 'Client with spaces' } } }
  return { context, runner, calls, resources, plist, original }
}

test('Mac icon source separates a white background from transparent brand artwork', async () => {
  const source = join(root, 'build', `${iconName}.icon`)
  const icon = JSON.parse(await readFile(join(source, 'icon.json'), 'utf8'))
  assert.equal(icon.fill.solid, 'srgb:1.00000,1.00000,1.00000,1.00000')
  assert.equal(icon.groups.length, 1)
  const group = icon.groups[0]
  assert.equal(group.layers.length, 1)
  assert.equal(group.layers[0].glass, false)
  assert.equal(group.translucency.enabled, false)
  const svg = await readFile(join(source, 'Assets', group.layers[0]['image-name']), 'utf8')
  assert.match(svg, /width="1024" height="1024"/)
  assert.doesNotMatch(svg, /<image|<filter|<rect[^>]+width="(?:128|1024)"/)
  const original = await readFile(join(root, 'assets/logo-source/yuanji-A-icon.svg'), 'utf8')
  assert.deepEqual(svg.match(/<(?:path|rect|circle)\b[^>]*\/>/g), original.match(/<(?:path|rect|circle)\b[^>]*\/>/g))
})

test('other platforms do not invoke Apple tools or inspect a Mac bundle', async () => {
  for (const platform of ['win32', 'linux']) {
    await afterMacIconPack({ electronPlatformName: platform }, { runner: () => assert.fail('Apple compiler must not run') })
  }
})

test('afterPack embeds the compiled catalog, preserving legacy icons and unrelated plist keys', async t => {
  const f = await fixture(t)
  await afterMacIconPack(f.context, { runner: f.runner })
  assert.equal(f.calls.length, 1)
  const [{ command, args }] = f.calls
  assert.equal(command, '/usr/bin/xcrun')
  assert.equal(args[0], 'actool')
  assert.ok(args.includes(join(root, 'build', `${iconName}.icon`)))
  assert.equal(args[args.indexOf('--app-icon') + 1], iconName)
  assert.equal(args[args.indexOf('--platform') + 1], 'macosx')
  const [plist] = await executeAppBuilderAsJson(['decode-plist', '-f', f.plist])
  assert.deepEqual(plist, { ...f.original, CFBundleIconName: iconName })
  assert.equal(await readFile(join(f.resources, 'legacy.icns'), 'utf8'), 'legacy-icon-fixture')
  assert.equal(await readFile(join(f.resources, 'Assets.car'), 'utf8'), 'native-catalog-fixture')
  await assert.rejects(stat(args[args.indexOf('--compile') + 1]), { code: 'ENOENT' })
})

test('compiler failure blocks packaging without changing the application', async t => {
  const f = await fixture(t)
  const before = await readFile(f.plist)
  await assert.rejects(afterMacIconPack(f.context, { runner: async () => { throw new Error('Xcode missing') } }), /Xcode 26/)
  assert.deepEqual(await readFile(f.plist), before)
  assert.deepEqual(await readdir(f.resources), ['legacy.icns'])
})

test('missing, empty or mismatched compiler outputs block packaging', async t => {
  for (const failure of ['missing', 'empty', 'wrong-name']) {
    const f = await fixture(t)
    const before = await readFile(f.plist)
    const runner = async (command, args) => {
      await f.runner(command, args)
      const output = args[args.indexOf('--compile') + 1]
      if (failure === 'missing') await rm(join(output, 'Assets.car'))
      if (failure === 'empty') await writeFile(join(output, 'Assets.car'), '')
      if (failure === 'wrong-name') {
        const partial = args[args.indexOf('--output-partial-info-plist') + 1]
        await executeAppBuilderAndWriteJson(['encode-plist'], { [partial]: { CFBundleIconName: 'wrong' } })
      }
      return { stdout: '', stderr: '' }
    }
    await assert.rejects(afterMacIconPack(f.context, { runner }))
    assert.deepEqual(await readFile(f.plist), before)
    assert.deepEqual(await readdir(f.resources), ['legacy.icns'])
  }
})

test('an existing asset catalog is not silently overwritten', async t => {
  const f = await fixture(t)
  await writeFile(join(f.resources, 'Assets.car'), 'existing-catalog')
  await assert.rejects(afterMacIconPack(f.context, { runner: f.runner }), /existing.*catalog/i)
  assert.equal(await readFile(join(f.resources, 'Assets.car'), 'utf8'), 'existing-catalog')
  assert.equal(f.calls.length, 0)
})

test('a missing legacy icon blocks the build instead of breaking older Macs', async t => {
  const f = await fixture(t)
  await rm(join(f.resources, 'legacy.icns'))
  await assert.rejects(afterMacIconPack(f.context, { runner: f.runner }), /legacy icon/i)
  assert.equal(f.calls.length, 0)
})

test('release chooses Xcode 26 and runs the icon hook before signing', async () => {
  const workflow = yaml.load(await readFile(join(root, '.github/workflows/client-release.yml'), 'utf8'))
  const steps = workflow.jobs['build-mac'].steps
  const select = steps.findIndex(step => step.uses === 'maxim-lobanov/setup-xcode@v1')
  assert.ok(select >= 0)
  assert.equal(steps[select].with['xcode-version'], '^26')
  assert.ok(select < steps.findIndex(step => step.run?.startsWith('npm run package:ci:stable:mac')))
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const hook = await readFile(join(root, pkg.build.afterPack), 'utf8')
  assert.match(hook, /afterMacIconPack\(context\)/)
  assert.ok(pkg.scripts['test:packaging'].includes('scripts/mac-icon.test.mjs'))
  assert.equal(pkg.build.mac.icon, 'build/desktop-icon.icns')
  assert.equal(pkg.build.win.icon, 'build/desktop-icon.ico')
})

test('Apple compiler accepts the real source on a Mac build host', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t)
  await afterMacIconPack(f.context)
  assert.ok((await stat(join(f.resources, 'Assets.car'))).size > 0)
})
