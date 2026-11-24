import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sevenZip from '7zip-bin'
import { zstdDecompressSync } from 'node:zlib'

const upstream = 'https://repo.msys2.org/msys/'
const project = fileURLToPath(new URL('../', import.meta.url))
const budgetBytes = 15_000_000
const licenseEntries = {
  'gcc-libs': ['usr/share/licenses/gcc-libs/COPYING.LIB', 'usr/share/licenses/gcc-libs/COPYING3', 'usr/share/licenses/gcc-libs/RUNTIME.LIBRARY.EXCEPTION'],
  mpfr: ['usr/share/doc/mpfr/COPYING', 'usr/share/doc/mpfr/COPYING.LESSER'],
  'msys2-runtime': ['usr/share/doc/Cygwin/COPYING', 'usr/share/doc/Cygwin/CYGWIN_LICENSE'],
  ncurses: ['usr/share/licenses/ncurses/LICENSE'],
}

export function runtimePackages(lock) {
  const seen = new Set()
  return Object.entries(lock).map(([name, [version, sha256, files, source = name]]) => {
    if (![name, source].every(value => /^[a-z0-9][a-z0-9-]*$/.test(value)) ||
        !/^[\d.]+(?:~[\d.]+)?-\d+$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256) ||
        !files.length || files.some(file => !/^[a-z0-9][a-z0-9.+_-]*\.(exe|dll)$/.test(file))) {
      throw new Error(`Invalid Bash package lock: ${name}`)
    }
    for (const file of files) {
      if (seen.has(file)) throw new Error(`Duplicate Bash runtime file: ${file}`)
      seen.add(file)
    }
    return { name, version, sha256, files, archive: `${name}-${version}-x86_64.pkg.tar.zst`, sourceUrl: `${upstream}sources/${source}-${version}.src.tar.zst` }
  })
}

async function loadPackages(root) {
  return runtimePackages(JSON.parse(await readFile(join(root, 'resources/bash-runtime/packages.json'), 'utf8')))
}

export function verifyArchive(spec, bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) {
    throw new Error(`MSYS2 Bash archive checksum mismatch: ${spec.archive}`)
  }
}

export function unpackBashArchive(spec, bytes) {
  verifyArchive(spec, bytes)
  return zstdDecompressSync(bytes, { maxOutputLength: 512 * 1024 * 1024 })
}

async function archiveBytes(spec, cache) {
  if (cache) return readFile(join(cache, spec.archive))
  const response = await fetch(`${upstream}x86_64/${spec.archive}`, { signal: AbortSignal.timeout(90_000) })
  if (!response.ok) throw new Error(`Cannot download ${spec.archive}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function run(tool, args, options = {}) {
  const result = spawnSync(tool, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`${tool} failed (${result.status}): ${result.error?.message ?? result.stderr ?? result.stdout}`)
  }
  return result.stdout
}

export function smokeBashRuntime(directory, packages, env = process.env) {
  const bin = join(directory, 'usr', 'bin')
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const clean = { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: env.TEMP, TMP: env.TMP,
    Path: `${bin};${join(systemRoot, 'System32')}`, LANG: 'C.UTF-8' }
  const commands = packages.flatMap(spec => spec.files).filter(file => file.endsWith('.exe'))
  const script = [
    'set -euo pipefail',
    'test -d /tmp; test -w /tmp',
    'cd /usr/bin',
    ...commands.map(file => `./${file} --version >/dev/null`),
    "test \"$(printf 'alpha\\nBETA\\n' | grep -i beta | sed 's/BETA/beta/' | awk '{print $1}')\" = beta",
    "test \"$(printf 'abc\\n' | xargs printf '%s')\" = abc",
    "test \"$(./find.exe . -maxdepth 1 -name bash.exe -print)\" = ./bash.exe",
    'test "$(ls -1 bash.exe | head -n 1)" = bash.exe',
    'test ! -e git.exe',
    'printf "bash-runtime-ok\\n"',
  ].join('\n')
  const output = run(join(bin, 'bash.exe'), ['--noprofile', '--norc', '-c', script], { env: clean, cwd: directory })
  if (output.trim() !== 'bash-runtime-ok') throw new Error(`Bash smoke test failed: ${output}`)
}

export async function checkBashSources(root = project) {
  const response = await fetch(`${upstream}sources/`, { signal: AbortSignal.timeout(45_000) })
  if (!response.ok) throw new Error(`Cannot verify MSYS2 corresponding source: HTTP ${response.status}`)
  const index = await response.text()
  for (const spec of await loadPackages(root)) {
    if (!index.includes(`href="${new URL(spec.sourceUrl).pathname.split('/').at(-1)}"`)) {
      throw new Error(`Missing Bash corresponding source: ${spec.sourceUrl}`)
    }
  }
}

export async function stageBashRuntime(appOutDir, root = project, cache = process.env.SEP_BASH_ARCHIVE_DIR) {
  const resources = join(appOutDir, 'resources')
  const packages = await loadPackages(root)
  await mkdir(resources, { recursive: true })
  const parent = await mkdtemp(join(await realpath(resources), '.bash-stage-'))
  const stage = join(parent, 'bash-runtime')
  const destination = join(resources, 'bash-runtime')
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  try {
    await mkdir(stage)
    await mkdir(join(stage, 'etc'))
    await writeFile(join(stage, 'etc/fstab'), 'none /tmp usertemp binary,posix=0,noacl 0 0\n')
    const archive = join(parent, 'package.tar')
    for (const spec of packages) {
      const bytes = await archiveBytes(spec, cache)
      await writeFile(archive, unpackBashArchive(spec, bytes))
      const entries = [...spec.files.map(file => `usr/bin/${file}`), ...(licenseEntries[spec.name] ?? [])]
      run(tar, ['-xf', archive, '-C', stage, '--', ...entries])
      for (const entry of entries) {
        const info = await lstat(join(stage, entry))
        if (!info.isFile() || !info.size) throw new Error(`Invalid Bash runtime entry: ${entry}`)
      }
    }
    await copyFile(join(root, 'resources/bash-runtime/PCRE-LICENCE'), join(stage, 'PCRE-LICENCE'))
    await copyFile(join(root, 'resources/bash-runtime/packages.json'), join(stage, 'packages.json'))
    await writeFile(join(stage, 'THIRD-PARTY-NOTICES.txt'), [
      'This directory contains unmodified MSYS2 programs and runtime libraries, distributed separately from CSEP.',
      'See usr/share/doc, usr/share/licenses and PCRE-LICENCE for license terms and notices.',
      'Exact corresponding source archives (including upstream package build recipes and patches):',
      ...packages.map(spec => `${spec.name} ${spec.version}: ${spec.sourceUrl}`), '',
    ].join('\n'))

    if (process.platform === 'win32') smokeBashRuntime(stage, packages)
    // NSIS uses LZMA compression; this checks the payload budget, not the final installer delta.
    const estimate = join(parent, 'payload.7z')
    run(sevenZip.path7za, ['a', '-t7z', '-m0=lzma2', '-mx=7', '-bd', estimate, 'bash-runtime'], { cwd: parent })
    const bytes = (await stat(estimate)).size
    if (bytes > budgetBytes) throw new Error(`Compressed Bash runtime exceeds ${budgetBytes} bytes: ${bytes}`)
    await rename(stage, destination)
    console.log(`Verified bundled Bash runtime (compressed payload estimate: ${bytes} bytes)`)
    return { destination, bytes }
  } finally {
    if (dirname(parent) === await realpath(resources)) await rm(parent, { recursive: true, force: true })
  }
}

export async function afterBashRuntimePack(context) {
  if (context.electronPlatformName !== 'win32' || context.arch !== 1) return
  await stageBashRuntime(context.appOutDir, context.packager.projectDir)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--check-sources' && process.argv.length === 3) await checkBashSources()
  else if (process.argv[2] === '--stage' && process.argv.length === 4 && process.platform === 'win32' && process.arch === 'x64') {
    await stageBashRuntime(resolve(process.argv[3]))
  } else throw new Error('Usage: node scripts/bash-runtime-packaging.mjs --check-sources | --stage <win-x64-app-out-dir>')
}
