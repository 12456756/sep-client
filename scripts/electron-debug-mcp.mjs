import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOOL_VERSION = '1.10.0'
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toolRoot = join(PROJECT_ROOT, 'output', 'electron-debug-mcp', 'tool')
const packageRoot = join(toolRoot, 'node_modules', 'electron-debug-mcp')

export async function ensureElectronDebugMcp() {
  const entry = join(packageRoot, 'build', 'index.js')
  try {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    await access(entry)
    if (pkg.version === TOOL_VERSION) return entry
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error
  }

  // Version 1.10.0 omits its postinstall script. Attach mode needs no second Electron.
  const args = ['install', '--prefix', toolRoot, '--ignore-scripts', '--omit=optional',
    '--no-audit', '--no-fund', 'electron-debug-mcp@' + TOOL_VERSION]
  const npmCli = process.env.npm_execpath
  const child = npmCli
    ? spawn(process.execPath, [npmCli, ...args], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args,
      { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  // stdout belongs exclusively to MCP JSON-RPC when started by a host.
  child.stdout.pipe(process.stderr)
  child.stderr.pipe(process.stderr)
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('MCP install exited ' + code)))
  })
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (pkg.version !== TOOL_VERSION) throw new Error('Installed MCP version does not match pin')
  await access(entry)
  return entry
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entry = await ensureElectronDebugMcp()
  if (process.argv.includes('--install')) {
    process.stderr.write('electron-debug-mcp ' + TOOL_VERSION + ' ready\n')
  } else {
    const child = spawn(process.execPath, [entry], { cwd: PROJECT_ROOT, env: process.env, stdio: 'inherit' })
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
      process.exitCode = code ?? (signal ? 1 : 0)
    })
  }
}
