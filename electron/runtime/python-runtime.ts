import { spawn, type ChildProcess } from 'node:child_process'
import { constants, lstatSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { applicationResourcesDirectory } from '../data/application-resources'
import { redactText } from '../common/redact'

export const PYTHON_CODE_LIMIT = 64 * 1024
export const PYTHON_TIMEOUT_SECONDS = 60
export const PYTHON_FILE_LIMIT = 16 * 1024 * 1024
const outputLimit = 16 * 1024

export function bundledPythonExecutable(): string | undefined {
  if (!(process.platform === 'win32' && process.arch === 'x64') &&
      !(process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64'))) return undefined
  const development = !process.versions.electron || process.defaultApp
  const dev = development ? process.env.SEP_PYTHON_DEV_RESOURCES : undefined
  try {
    const appResources = applicationResourcesDirectory()
    const resources = development ? dev && isAbsolute(dev) ? dev : join(dirname(appResources), 'node_modules', '.cache', 'csep-python-wasi') : appResources
    const root = join(resources, 'python-runtime')
    const executable = join(root, process.platform === 'win32' ? 'wasmtime.exe' : 'wasmtime')
    return [executable, join(root, 'python.wasm'), join(root, 'python315.zip'), join(root, 'CSEP-RUNTIME.json')]
      .every(path => lstatSync(path, { throwIfNoEntry: false })?.isFile()) ? executable : undefined
  } catch { return undefined }
}

function stopPython(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return } catch { child.kill('SIGKILL'); return }
  }
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  const killer = spawn(taskkill, ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
  const fallback = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  const timer = setTimeout(fallback, 3_000)
  timer.unref()
  killer.once('error', () => { clearTimeout(timer); fallback() })
  killer.once('exit', code => { clearTimeout(timer); if (code !== 0) fallback() })
}

function boundedOutput(stream: NodeJS.ReadableStream | null) {
  const chunks: Buffer[] = []
  let remaining = outputLimit, truncated = false
  stream?.on('data', (chunk: Buffer) => {
    if (chunk.length > remaining) truncated = true
    if (remaining === 0) return
    const part = chunk.subarray(0, remaining)
    chunks.push(part); remaining -= part.length
  })
  return () => ({ text: redactText(Buffer.concat(chunks).toString('utf8'), outputLimit), truncated })
}

export interface PythonResult {
  status: 'finished' | 'timed-out' | 'cancelled'
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
}

export async function inspectPythonFile(path: string, limit: number) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.ino === 0n || before.size > limit) throw new Error('Unsupported Python file or size exceeds the limit.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1n || info.size > limit || await realpath(path) !== path) throw new Error('Python file changed.')
    const buffer = Buffer.alloc(Number(info.size) + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat({ bigint: true })
    if (BigInt(bytesRead) !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) throw new Error('Python file changed.')
    return { info: after, bytes: buffer.subarray(0, bytesRead) }
  } finally { await handle.close() }
}

export async function readPythonFile(path: string, limit: number): Promise<Buffer> {
  return (await inspectPythonFile(path, limit)).bytes
}

export function pythonGuestFilename(name: string): boolean {
  return /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,119}$/u.test(name) && !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
}

export async function runPython(executable: string, code: string, signal?: AbortSignal,
  options: { inputs?: ReadonlyMap<string, Buffer>; outputs?: readonly string[]; binaryOutput?: string; timeoutMs?: number } = {},
): Promise<PythonResult & { files: Map<string, string>; binaryFile?: Buffer }> {
  signal?.throwIfAborted()
  const inputs = options.inputs ?? new Map<string, Buffer>(), outputs = options.outputs ?? [], binary = options.binaryOutput
  if (!isAbsolute(executable) || Buffer.byteLength(code) > PYTHON_CODE_LIMIT || code.includes('\0') ||
      (binary !== undefined && (outputs.length > 0 || !pythonGuestFilename(binary))) ||
      [...inputs.keys(), ...outputs].some(name => !pythonGuestFilename(name)) ||
      [...inputs.values()].reduce((sum, bytes) => sum + bytes.length, 0) > PYTHON_FILE_LIMIT) throw new Error('Invalid Python input.')
  const tmp = await realpath(tmpdir())
  const root = await mkdtemp(join(tmp, 'csep-python-'))
  try {
    const work = join(root, 'workspace'), lib = join(root, 'stdlib')
    await mkdir(join(work, 'inputs'), { recursive: true })
    await mkdir(join(work, 'outputs'))
    await mkdir(lib)
    // Only disposable copies are preopened; real workspace directories stay in the host.
    await copyFile(join(dirname(executable), 'python315.zip'), join(lib, 'python315.zip'))
    for (const [name, bytes] of inputs) await writeFile(join(work, 'inputs', name), bytes, { flag: 'wx' })
    signal?.throwIfAborted()
    const result = await executePython(executable, root, work, lib, code, signal, options.timeoutMs ?? PYTHON_TIMEOUT_SECONDS * 1_000)
    const files = new Map<string, string>()
    let binaryFile: Buffer | undefined
    if (result.status === 'finished' && result.exitCode === 0) {
      signal?.throwIfAborted()
      const folder = join(work, 'outputs')
      if ((outputs.length || binary !== undefined) && await realpath(folder) !== folder) throw new Error('Python output folder changed.')
      if (binary !== undefined) binaryFile = await readPythonFile(join(folder, binary), PYTHON_FILE_LIMIT)
      for (const name of outputs) {
        signal?.throwIfAborted()
        const bytes = await readPythonFile(join(folder, name), 128 * 1024)
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        if (text.includes('\0')) throw new Error('Python output must be a UTF-8 text file.')
        files.set(name, text)
      }
    }
    return { ...result, files, ...(binaryFile !== undefined ? { binaryFile } : {}) }
  } finally {
    if (dirname(await realpath(root)) === tmp) await rm(root, { recursive: true, force: true })
  }
}

async function executePython(executable: string, cwd: string, work: string, lib: string, code: string, signal: AbortSignal | undefined,
  timeoutMs: number): Promise<PythonResult> {
  // libuv supplies PATH on Windows when the key is omitted.
  const env: NodeJS.ProcessEnv = { PATH: '', TEMP: cwd, TMP: cwd, TMPDIR: cwd }
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const child = spawn(executable, ['run', '-C', 'cache=n',
    '-S', 'inherit-env=n,inherit-network=n,tcp=n,udp=n,allow-ip-name-lookup=n,threads=n,http=n,hostcall-fuel=67108864,max-resources=128',
    '-W', 'max-memory-size=134217728,fuel=5000000000', '--dir', `${lib}::/usr/local/lib`, '--dir', `${work}::.`,
    '--argv0', '/python.wasm', join(dirname(executable), 'python.wasm'), '-I', '-S', '-B', '-X', 'utf8', '-'], {
    cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = boundedOutput(child.stdout), stderr = boundedOutput(child.stderr)
  let status: PythonResult['status'] = 'finished'
  const stop = (reason: 'timed-out' | 'cancelled') => {
    if (status !== 'finished') return
    status = reason
    stopPython(child)
  }
  const abort = () => stop('cancelled')
  const timer = setTimeout(() => stop('timed-out'), timeoutMs)
  let drain: ReturnType<typeof setTimeout> | undefined
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('Could not start the bundled Python runtime.')))
      child.once('close', resolve)
      child.once('exit', code => {
        // Descendants can retain inherited output handles after the interpreter exits.
        clearTimeout(timer)
        drain = setTimeout(() => {
          child.stdout?.destroy(); child.stderr?.destroy()
          resolve(code)
        }, 200)
      })
      child.stdin?.on('error', () => { /* Child exit status and stderr report the failure. */ })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdin?.end(code, 'utf8')
    })
    const out = stdout(), err = stderr()
    return { status, exitCode, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated }
  } finally {
    clearTimeout(timer)
    if (drain) clearTimeout(drain)
    signal?.removeEventListener('abort', abort)
  }
}
