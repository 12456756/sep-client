import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPackage } from '@electron/asar'
import { verifyAfterPack, verifyPackagedRuntime } from './verify-packaged-runtime.mjs'

const provider = '@earendil-works/pi-ai'

async function fixture(t, { nested = false, version = '0.83.0', source = 'export function streamSimple() {}', dependency = 'production' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sep-packaged-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const app = join(directory, 'app')
  const providerRoot = join(app, 'node_modules', ...(nested ? ['@earendil-works/pi-coding-agent', 'node_modules'] : []), provider)
  await mkdir(join(app, 'out/main/chunks'), { recursive: true })
  await mkdir(join(providerRoot, 'dist/api'), { recursive: true })
  await writeFile(join(app, 'package.json'), JSON.stringify({
    name: 'runtime-fixture', version: '0.2.0', type: 'module',
    [dependency === 'production' ? 'dependencies' : 'devDependencies']: { [provider]: '0.83.0' },
  }))
  await writeFile(join(app, 'out/main/chunks/pi-task-worker-fixture.js'), 'export {}')
  await writeFile(join(providerRoot, 'package.json'), JSON.stringify({
    name: provider, version, type: 'module',
    exports: { './api/*': { import: './dist/api/*.js' } },
  }))
  await writeFile(join(providerRoot, 'dist/api/openai-completions.js'), source)
  const resources = join(directory, 'resources')
  await mkdir(resources)
  const archive = join(resources, 'app.asar')
  await createPackage(app, archive)
  return { archive, directory, resources }
}

test('imports a packaged provider with Electron, including Chinese and spaced archive paths', async t => {
  const { archive, directory } = await fixture(t)
  const destination = join(directory, '\u5ba2\u6237\u7aef with spaces')
  await mkdir(destination)
  const moved = join(destination, 'app.asar')
  await rename(archive, moved)
  const result = await verifyPackagedRuntime(moved)
  assert.equal(result.version, '0.2.0')
  assert.equal(result.module, `${provider}/api/openai-completions`)
  assert.match(result.electron, /^33\./)
})

test('rejects the released nested-only dependency layout even when development has a root copy', async t => {
  const { archive } = await fixture(t, { nested: true })
  await assert.rejects(verifyPackagedRuntime(archive), /Missing packaged runtime dependency/)
})

test('rejects missing transitive imports rather than only checking package presence', async t => {
  const { archive } = await fixture(t, { source: "import 'missing-packaged-transport'; export function streamSimple() {}" })
  await assert.rejects(verifyPackagedRuntime(archive), /Packaged runtime import failed[\s\S]*missing-packaged-transport/)
})

test('rejects a broken provider export', async t => {
  const { archive } = await fixture(t, { source: 'export const streamSimple = undefined' })
  await assert.rejects(verifyPackagedRuntime(archive), /Missing provider streamSimple export/)
})

test('rejects development-only dependencies and unapproved SDK versions', async t => {
  const dev = await fixture(t, { dependency: 'development' })
  await assert.rejects(verifyPackagedRuntime(dev.archive), /must be a production dependency/)
  const wrongVersion = await fixture(t, { version: '0.84.0' })
  await assert.rejects(verifyPackagedRuntime(wrongVersion.archive), /Expected packaged .*0\.83\.0/)
})

test('afterPack verifies the target archive for macOS and Windows layouts', async t => {
  for (const platform of ['darwin', 'win32']) {
    const { archive, directory } = await fixture(t)
    if (platform === 'darwin') {
      const resources = join(directory, 'Client.app/Contents/Resources')
      await mkdir(resources, { recursive: true })
      await rename(archive, join(resources, 'app.asar'))
    }
    await verifyAfterPack({ appOutDir: directory, electronPlatformName: platform, packager: { appInfo: { productFilename: 'Client' } } })
  }
})
