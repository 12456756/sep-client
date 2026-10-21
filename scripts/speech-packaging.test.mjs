import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPackage } from '@electron/asar'
import { afterPack } from './speech-packaging.mjs'
import { createBuilderConfig } from './generate-builder-config.mjs'
import { speechDirectory, speechFiles, speechNativePackage, verifySpeechAssets, verifySpeechNative } from './speech-assets.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sep-speech-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const files = []
  for (const [path, content] of [['model.int8.onnx', 'model fixture'], ['tokens.txt', 'vocabulary fixture']]) {
    const bytes = Buffer.from(content)
    files.push(path.endsWith('.onnx')
      ? { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      : { path, bytes: bytes.length, gitSha1: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') })
    await writeFile(join(directory, path), bytes)
  }
  const manifest = { model: 'test', revision: 'pinned', files }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  for (const file of ['MODEL_LICENSE', 'RUNTIME_LICENSE']) await copyFile(join(speechDirectory, file), join(directory, file))
  return { directory, manifest }
}

test('afterPack accepts native archive paths and rejects a missing speech worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-speech-after-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resources = join(root, 'resources')
  const source = join(root, 'source')
  await mkdir(join(source, 'out', 'main'), { recursive: true })
  await mkdir(join(source, 'node_modules', 'sherpa-onnx-node'), { recursive: true })
  await writeFile(join(source, 'out', 'main', 'speech-worker.js'), 'worker fixture')
  await writeFile(join(source, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'), 'runtime fixture')
  await writeFile(join(source, 'package.json'), JSON.stringify({ version: 'test' }))
  const packagedSpeech = join(resources, 'speech', 'sensevoice-int8')
  await mkdir(packagedSpeech, { recursive: true })
  for (const name of ['model.int8.onnx', 'tokens.txt', 'MODEL_LICENSE', 'RUNTIME_LICENSE', 'manifest.json']) {
    await copyFile(join(speechDirectory, name), join(packagedSpeech, name))
  }
  const modules = join(resources, 'app.asar.unpacked', 'node_modules')
  await cp(join(source, 'node_modules'), modules, { recursive: true })
  await mkdir(join(modules, 'sherpa-onnx-win-x64'))
  for (const name of ['sherpa-onnx-node', 'sherpa-onnx-win-x64']) {
    await writeFile(join(modules, name, 'package.json'), JSON.stringify({ version: '1.13.8' }))
  }
  for (const file of ['sherpa-onnx.node', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll']) {
    await writeFile(join(modules, 'sherpa-onnx-win-x64', file), 'native fixture')
  }
  const context = { appOutDir: root, electronPlatformName: 'win32', arch: 1 }
  await createPackage(source, join(resources, 'app.asar'))
  await afterPack(context)
  await rm(join(source, 'out', 'main', 'speech-worker.js'))
  await createPackage(source, join(resources, 'missing-worker.asar'))
  const missingContext = { ...context, appOutDir: join(root, 'missing') }
  await mkdir(join(root, 'missing', 'resources'), { recursive: true })
  await cp(join(resources, 'speech'), join(root, 'missing', 'resources', 'speech'), { recursive: true })
  await copyFile(join(resources, 'missing-worker.asar'), join(root, 'missing', 'resources', 'app.asar'))
  await assert.rejects(afterPack(missingContext), /Missing packaged speech entry: \/out\/main\/speech-worker.js/)
})

test('speech packaging verifies both pinned hash formats and retained licenses', async t => {
  const { directory, manifest } = await fixture(t)
  await verifySpeechAssets(directory, manifest)
})

test('speech packaging rejects missing assets and same-size model corruption', async t => {
  const { directory, manifest } = await fixture(t)
  const model = join(directory, 'model.int8.onnx')
  await writeFile(model, 'model fixturf')
  await assert.rejects(verifySpeechAssets(directory, manifest), /checksum mismatch/)
  await rm(model)
  await assert.rejects(verifySpeechAssets(directory, manifest), /Missing speech asset/)
})

test('speech packaging rejects changed manifests, vocabulary and license notices', async t => {
  const { directory, manifest } = await fixture(t)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, revision: 'unapproved' }))
  await assert.rejects(verifySpeechAssets(directory, manifest), /manifest differs/)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(directory, 'tokens.txt'), 'bad')
  await assert.rejects(verifySpeechAssets(directory, manifest), /size mismatch/)
  await writeFile(join(directory, 'tokens.txt'), 'vocabulary fixture')
  await writeFile(join(directory, 'MODEL_LICENSE'), 'replacement')
  await assert.rejects(verifySpeechAssets(directory, manifest), /changed speech license/)
})

test('speech packaging rejects a model symlink instead of bundling external data', { skip: process.platform === 'win32' }, async t => {
  const { directory, manifest } = await fixture(t)
  await copyFile(join(directory, 'model.int8.onnx'), join(directory, 'external.onnx'))
  await rm(join(directory, 'model.int8.onnx'))
  await symlink('external.onnx', join(directory, 'model.int8.onnx'))
  await assert.rejects(verifySpeechAssets(directory, manifest), /size mismatch/)
})

test('Windows speech package requires every DLL and the pinned native version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-speech-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['sherpa-onnx-node', 'sherpa-onnx-win-x64']) {
    await mkdir(join(root, name))
    await writeFile(join(root, name, 'package.json'), JSON.stringify({ version: '1.13.8' }))
  }
  const directory = join(root, 'sherpa-onnx-win-x64')
  const files = ['sherpa-onnx.node', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll']
  for (const file of files) await writeFile(join(directory, file), 'native fixture')
  await verifySpeechNative(root, 'win32', 'x64')
  await rm(join(directory, 'onnxruntime_providers_shared.dll'))
  await assert.rejects(verifySpeechNative(root, 'win32', 'x64'), /ENOENT/)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '9.0.0' }))
  await assert.rejects(verifySpeechNative(root, 'win32', 'x64'), /Expected .*1.13.8/)
})

test('both channels and signing modes inherit speech resources, native unpacking and hooks', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const channel of ['beta', 'stable']) {
    for (const signed of [false, true]) {
      const config = createBuilderConfig(pkg.build, channel, { signed, platform: 'darwin', env: { SEP_MAC_TEAM_ID: 'ABCDE12345', APPLE_KEYCHAIN_PROFILE: 'test' } })
      assert.deepEqual(config.extraResources, [{ from: 'resources/speech/sensevoice-int8', to: 'speech/sensevoice-int8', filter: speechFiles }])
      assert.ok(config.asarUnpack.includes('node_modules/sherpa-onnx-*/**/*'))
      assert.equal(config.beforePack, 'scripts/speech-before-pack.cjs')
      assert.equal(config.afterPack, 'scripts/speech-after-pack.cjs')
      assert.ok(config.mac.extendInfo.NSMicrophoneUsageDescription)
    }
  }
  assert.equal(speechNativePackage('darwin', 'arm64'), 'sherpa-onnx-darwin-arm64')
  assert.equal(speechNativePackage('win32', 'x64'), 'sherpa-onnx-win-x64')
  assert.throws(() => speechNativePackage('darwin', 'universal'), /Unsupported/)
})
