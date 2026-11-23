import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { applicationResourcesDirectory } from '../../data/application-resources'
import type { PiEncodingToolSdk } from './pi-coding-agent-adapter'

type SdkResolver = PiEncodingToolSdk['getShellConfig']
export type BashShellResolver = () => ReturnType<SdkResolver> & { binPath?: string }

function regularFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true
}

function systemWsl(path: string): boolean {
  return /\\(?:system32|sysnative|syswow64)\\bash\.exe$/i.test(win32.normalize(path))
}

export function resolveBashShell(sdk: SdkResolver, options = {
  platform: process.platform as string,
  resources: applicationResourcesDirectory,
  env: process.env,
  isFile: regularFile,
}): ReturnType<BashShellResolver> {
  if (options.platform !== 'win32') return sdk()
  const { isFile, env } = options
  const bundled = win32.join(options.resources(), 'bash-runtime', 'usr', 'bin')
  const shell = win32.join(bundled, 'bash.exe')
  if (isFile(shell)) return { shell, args: ['--noprofile', '--norc', '-c'], binPath: bundled }

  // The SDK recognizes default Git installs, but its PATH fallback can select the WSL launcher.
  try {
    const local = sdk()
    if (!systemWsl(local.shell)) return local
  } catch { /* Check Git installations whose cmd, but not bin, is on PATH. */ }
  const path = env[Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'] ?? ''
  for (const dir of path.split(';')) {
    const absolute = dir.trim().replace(/^"|"$/g, '')
    if (!/^[a-z]:[\\/]/i.test(absolute)) continue
    const direct = win32.join(absolute, 'bash.exe')
    if (!systemWsl(direct) && isFile(direct)) return sdk(direct)
    if (win32.basename(absolute).toLowerCase() === 'cmd' && isFile(win32.join(absolute, 'git.exe'))) {
      const sibling = win32.join(absolute, '..', 'bin', 'bash.exe')
      if (isFile(sibling)) return sdk(sibling)
    }
  }
  throw new Error('Bash is unavailable. Reinstall the Windows x64 client or install Git for Windows for development.')
}

export function bashEnvironment(env: NodeJS.ProcessEnv, binPath: string): NodeJS.ProcessEnv {
  const result = { ...env }
  const key = Object.keys(result).find(name => name.toLowerCase() === 'path') ?? 'Path'
  result[key] = [binPath, result[key]].filter(Boolean).join(';')
  delete result.BASH_ENV
  return result
}
