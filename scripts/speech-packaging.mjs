import { join } from 'node:path'
import { access, readFile, readdir } from 'node:fs/promises'
import { listPackage, extractFile } from '@electron/asar'

const architectures = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

export async function beforePack(context) {
  const { verifySpeechAssets, verifySpeechNative } = await import('./speech-assets.mjs')
  await verifySpeechAssets(join(context.packager.projectDir, 'resources', 'speech', 'sensevoice-int8'))
  await verifySpeechNative(join(context.packager.projectDir, 'node_modules'), context.electronPlatformName, architectures[context.arch])
}

export async function afterPack(context) {
  const { verifySpeechAssets, verifySpeechNative } = await import('./speech-assets.mjs')
  const platform = context.electronPlatformName
  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  await verifySpeechAssets(join(resources, 'speech', 'sensevoice-int8'))
  const entries = await readdir(join(resources, 'speech', 'sensevoice-int8'))
  if (entries.some(name => !['model.int8.onnx', 'tokens.txt', 'MODEL_LICENSE', 'RUNTIME_LICENSE', 'manifest.json'].includes(name))) {
    throw new Error('Unexpected test or temporary files in packaged speech resources')
  }
  const archive = join(resources, 'app.asar')
  const files = listPackage(archive)
  for (const file of ['/out/main/speech-worker.js', '/node_modules/sherpa-onnx-node/sherpa-onnx.js']) {
    if (!files.includes(file)) throw new Error(`Missing packaged speech entry: ${file}`)
  }
  await access(join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'))
  await verifySpeechNative(join(resources, 'app.asar.unpacked', 'node_modules'), platform, architectures[context.arch])
  if (platform === 'darwin') {
    const plist = await readFile(join(resources, '..', 'Info.plist'), 'utf8')
    if (!plist.includes('NSMicrophoneUsageDescription')) throw new Error('Missing macOS microphone usage description')
  }
  const metadata = JSON.parse(extractFile(archive, 'package.json').toString())
  console.log(`Verified packaged offline speech: ${metadata.version}, ${platform}/${architectures[context.arch]}`)
}
