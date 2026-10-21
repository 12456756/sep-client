import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const speechDirectory = fileURLToPath(new URL('../resources/speech/sensevoice-int8/', import.meta.url))
export const speechFiles = ['model.int8.onnx', 'tokens.txt', 'MODEL_LICENSE', 'RUNTIME_LICENSE', 'manifest.json']
export const speechManifest = JSON.parse(await readFile(join(speechDirectory, 'manifest.json'), 'utf8'))

export async function verifySpeechFile(path, expected) {
  const info = await lstat(path).catch(() => { throw new Error(`Missing speech asset: ${path}`) })
  if (!info.isFile() || info.size !== expected.bytes) throw new Error(`Speech asset size mismatch: ${path}`)
  const hash = createHash(expected.sha256 ? 'sha256' : 'sha1')
  if (!expected.sha256) hash.update(`blob ${info.size}\0`)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== (expected.sha256 ?? expected.gitSha1)) throw new Error(`Speech asset checksum mismatch: ${path}`)
}

export async function verifySpeechAssets(directory = speechDirectory, manifest = speechManifest) {
  const actual = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error('Packaged speech manifest differs from the pinned source')
  for (const file of ['model.int8.onnx', 'tokens.txt']) {
    const expected = manifest.files.find(asset => asset.path === file)
    if (!expected) throw new Error(`Missing pinned metadata for ${file}`)
    await verifySpeechFile(join(directory, file), expected)
  }
  for (const file of ['MODEL_LICENSE', 'RUNTIME_LICENSE']) {
    const source = await readFile(join(speechDirectory, file))
    const packaged = await readFile(join(directory, file))
    if (!packaged.length || !packaged.equals(source)) throw new Error(`Missing or changed speech license: ${file}`)
  }
}

export function speechNativePackage(platform, arch) {
  if (!['x64', 'arm64'].includes(arch) || !['darwin', 'win32', 'linux'].includes(platform)
    || (platform === 'win32' && arch !== 'x64')) throw new Error(`Unsupported speech target: ${platform}/${arch}`)
  return `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`
}

export async function verifySpeechNative(modulesDirectory, platform, arch) {
  const name = speechNativePackage(platform, arch)
  const directory = join(modulesDirectory, name)
  for (const pkg of ['sherpa-onnx-node', name]) {
    const metadata = JSON.parse(await readFile(join(modulesDirectory, pkg, 'package.json'), 'utf8'))
    if (metadata.version !== '1.13.8') throw new Error(`Expected ${pkg}@1.13.8, got ${metadata.version}`)
  }
  const libraries = platform === 'win32'
    ? ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll']
    : platform === 'darwin'
      ? ['libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib']
      : ['libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so']
  const realDirectory = await realpath(directory)
  for (const file of ['sherpa-onnx.node', ...libraries]) {
    // Some Linux packages use versioned library symlinks; these must resolve inside the package.
    const resolved = await realpath(join(directory, file))
    const info = await stat(resolved)
    if (dirname(resolved) !== realDirectory || !info.isFile() || !info.size) throw new Error(`Invalid speech native library: ${file}`)
  }
}
