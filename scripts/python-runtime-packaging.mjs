import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'

const manifest = JSON.parse(await readFile(new URL('../resources/python-runtime/manifest.json', import.meta.url), 'utf8'))
const devResources = fileURLToPath(new URL('../node_modules/.cache/csep-python-wasi/', import.meta.url))
const python = { ...manifest.python,
  url: `https://github.com/brettcannon/cpython-wasi-build/releases/download/v${manifest.python.version}/${manifest.python.archive}` }

export function pythonRelease(target) {
  if (!Object.hasOwn(manifest.targets, target)) return undefined
  const spec = manifest.targets[target]
  const version = manifest.wasmtimeVersion
  const directory = `wasmtime-v${version}-${spec.asset.replace(/\.(?:tar\.xz|zip)$/, '')}`
  const archive = `wasmtime-v${version}-${spec.asset}`
  return { ...spec, archive, directory, version, python, url: `https://github.com/bytecodealliance/wasmtime/releases/download/v${version}/${archive}` }
}

export function verifyPythonArchive(spec, bytes) {
  if (bytes.length !== spec.size || createHash('sha256').update(bytes).digest('hex') !== spec.sha256) {
    throw new Error(`Python archive size or SHA-256 mismatch: ${spec.archive}`)
  }
}

async function archiveBytes(spec, cache) {
  if (cache) return readFile(join(cache, spec.archive))
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error(`Cannot download ${spec.archive}: HTTP ${response.status}`)
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > spec.size) throw new Error(`Python archive exceeded locked size: ${spec.archive}`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

function run(file, args, options = {}) {
  const { status, error, stderr, stdout } = spawnSync(file, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true, ...options })
  if (error || status !== 0) throw new Error(`${file} failed (${status}): ${error?.message ?? stderr}`)
  return stdout
}

export function smokePythonRuntime(resources, target, runtimeDirectory = join(resources, 'python-runtime'), executable) {
  const spec = pythonRelease(target)
  if (!spec || target !== `${process.platform}-${process.arch}`) throw new Error('Python smoke test must use a matching native runner')
  const interpreter = executable ?? join(runtimeDirectory, spec.executable)
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const env = process.platform === 'win32' ? { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: '' } : { LC_ALL: 'C', PATH: '' }
  const output = run(interpreter, ['run', '-C', 'cache=n', '-S', 'inherit-env=n,inherit-network=n,tcp=n,udp=n',
    '--dir', `${runtimeDirectory}::/usr/local/lib`, '--argv0', '/python.wasm', join(runtimeDirectory, 'python.wasm'), '-I', '-S', '-B', '-X', 'utf8', '-c',
    "import csv, json, os, sys; assert sys.platform == 'wasi' and not os.environ; print(json.dumps([sys.version.split()[0], next(csv.reader(['team,total']))]))"], { cwd: resources, env })
  const [version, csv] = JSON.parse(output)
  if (version !== spec.python.version || String(csv) !== 'team,total') throw new Error(`Python smoke test mismatch for ${target}`)
  return interpreter
}

async function standardLibrary(root, entries, prefix = '') {
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = `${prefix}${item.name}`
    if (item.isDirectory() && !['ensurepip', 'site-packages', 'test', '__pycache__'].includes(item.name)) {
      await standardLibrary(root, entries, `${relative}/`)
    } else if (item.isFile()) entries[relative] = await readFile(join(root, relative))
  }
}

export async function stagePythonRuntime(resources, target, cache = process.env.SEP_PYTHON_ARCHIVE_DIR) {
  const spec = pythonRelease(target)
  if (!spec) throw new Error(`Unsupported bundled Python target: ${target}`)
  await mkdir(resources, { recursive: true })
  const root = await realpath(resources)
  const stage = await mkdtemp(join(root, '.python-stage-'))
  try {
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
    const [wasmtimeBytes, pythonBytes] = await Promise.all([archiveBytes(spec, cache), archiveBytes(spec.python, cache)])
    const wasmDir = join(stage, 'wasi-python')
    const payload = join(stage, 'payload')
    await Promise.all([mkdir(wasmDir), mkdir(payload)])
    for (const [asset, bytes, destination] of [[spec, wasmtimeBytes, stage], [spec.python, pythonBytes, wasmDir]]) {
      verifyPythonArchive(asset, bytes)
      const archive = join(stage, asset.archive)
      await writeFile(archive, bytes)
      run(tar, ['-xf', archive, '-C', destination])
    }
    const wasmtime = join(stage, spec.directory)
    await Promise.all([
      copyFile(join(wasmtime, spec.executable), join(payload, spec.executable)),
      copyFile(join(wasmtime, 'LICENSE'), join(payload, 'LICENSE-Wasmtime.txt')),
      copyFile(join(wasmDir, 'LICENSE'), join(payload, 'LICENSE-Python.txt')),
      copyFile(join(wasmDir, 'python.wasm'), join(payload, 'python.wasm')),
    ])
    if (process.platform !== 'win32') await chmod(join(payload, spec.executable), 0o755)
    const entries = Object.create(null)
    await standardLibrary(join(wasmDir, 'lib', `python${spec.python.version.split('.').slice(0, 2).join('.')}`), entries)
    // WASI CPython does not include zlib, so the import archive must use stored entries.
    await writeFile(join(payload, 'python315.zip'), zipSync(entries, { level: 0, mtime: new Date('2000-01-01T12:00:00Z') }))
    const destination = join(root, 'python-runtime')
    if (target === `${process.platform}-${process.arch}`) smokePythonRuntime(root, target, payload, join(wasmtime, spec.executable))
    await mkdir(destination)
    try {
      for (const filename of await readdir(payload)) await copyFile(join(payload, filename), join(destination, filename))
      if (process.platform !== 'win32') await chmod(join(destination, spec.executable), 0o755)
      // Set the readiness marker only after extraction, verification and publication.
      await writeFile(join(destination, 'CSEP-RUNTIME.json'), JSON.stringify({ target, ...spec }, null, 2) + '\n', { flag: 'wx' })
    } catch (error) {
      if (await realpath(destination) === destination && dirname(destination) === root) await rm(destination, { recursive: true, force: true })
      throw error
    }
    process.stdout.write(`Bundled WASI Python ${spec.python.version} / Wasmtime ${spec.version} (${target})\n`)
    return destination
  } finally {
    if (dirname(await realpath(stage)) === root) await rm(stage, { recursive: true, force: true })
  }
}

export async function afterPythonRuntimePack(context) {
  const platform = context.electronPlatformName
  if (platform !== 'win32' && platform !== 'darwin') return
  const arch = ({ 1: 'x64', 3: 'arm64' })[context.arch]
  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  await stagePythonRuntime(resources, `${platform}-${arch}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, resources] = process.argv.slice(2)
  const target = `${process.platform}-${process.arch}`
  if (command === '--dev' && !resources) {
    const spec = pythonRelease(target)
    const staged = join(devResources, 'python-runtime')
    if (spec && !process.env.SEP_PYTHON_DEV_RESOURCES) {
      try {
        const cached = await readFile(join(staged, 'CSEP-RUNTIME.json'), 'utf8').then(JSON.parse).catch(() => undefined)
        if (!cached || cached.sha256 !== spec.sha256 || cached.python?.sha256 !== spec.python.sha256) {
          await stagePythonRuntime(devResources, target)
        }
      } catch (error) {
        process.stderr.write(`Python is unavailable in this dev launch: ${error.message}\n`)
      }
    }
  } else {
    if (!resources || process.argv.length !== 4 || !['--stage', '--smoke'].includes(command)) {
      throw new Error('Usage: node scripts/python-runtime-packaging.mjs --dev | --stage|--smoke <resources-directory>')
    }
    if (command === '--stage') await stagePythonRuntime(resolve(resources), target)
    else process.stdout.write(`Verified ${smokePythonRuntime(resolve(resources), target)}\n`)
  }
}
