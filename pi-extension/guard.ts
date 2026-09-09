/**
 * Provider-neutral tool policy. SDK-specific hooks live in electron/pi/sdk.
 *
 * 副作用工具清单不在这里定义——它有三个用途（审批、停机、崩溃恢复），
 * 唯一定义点是 electron/common/constants.ts（方案第 6 章）。
 * 这个文件只负责"策略"：哪些算只读、哪些需要批准、哪些是未知工具。
 */
import { hasSideEffects } from '../electron/common/constants'

export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export interface ToolPolicy {
  allowedTools: readonly string[]
  allowedPaths: readonly string[]
  deniedPaths: readonly string[]
  commandPolicy: 'disabled' | 'restricted' | 'confirm-each'
  approvalMode: 'confirm-each' | 'auto-approve'
  workspaceDir: string
}

export interface ToolDecision {
  allowed: boolean
  requiresApproval: boolean
  reason?: string
}

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName)
}

export function requiresToolApproval(toolName: string): boolean {
  return hasSideEffects(toolName)
}

export function isKnownTool(toolName: string): boolean {
  return isReadOnlyTool(toolName) || requiresToolApproval(toolName)
}

/**
 * 任务级工具策略的最后一道纯判断。它不执行工具，也不接触 Electron/IPC，
 * 由 Pi adapter 在 tool_call hook 中调用。路径策略默认收紧到共享 workspace。
 */
export function evaluateToolCall(toolName: string, input: unknown, policy: ToolPolicy): ToolDecision {
  if (!isKnownTool(toolName)) return { allowed: false, requiresApproval: false, reason: 'unknown-tool' }
  if (!policy.allowedTools.includes(toolName)) return { allowed: false, requiresApproval: false, reason: 'tool-not-allowed' }

  if (toolName === 'bash') {
    if (policy.commandPolicy === 'disabled') return { allowed: false, requiresApproval: false, reason: 'command-disabled' }
    const command = readString(input, ['command', 'cmd'])
    if (!command || isDangerousCommand(command) || containsOutsideWorkspacePath(command, policy)) {
      return { allowed: false, requiresApproval: false, reason: 'unsafe-command' }
    }
  } else if (hasSideEffects(toolName) || isReadOnlyTool(toolName)) {
    const path = readString(input, ['path', 'filePath', 'file_path', 'filename', 'target'])
    if (!path || !isAllowedPath(path, policy)) {
      return { allowed: false, requiresApproval: false, reason: 'path-not-allowed' }
    }
  }

  return {
    allowed: true,
    requiresApproval: hasSideEffects(toolName) && policy.approvalMode !== 'auto-approve',
  }
}

function readString(input: unknown, keys: readonly string[]): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim()
  }
  return null
}

function isDangerousCommand(command: string): boolean {
  return /(?:^|[;&|])\s*(?:rm\s+-rf|rmdir|del\s+\/s|format(?:\.com)?|mkfs|diskpart)\b/i.test(command) ||
    /(?:curl|wget|invoke-webrequest|iwr)[^\n|]*\|\s*(?:sh|bash|pwsh|powershell)/i.test(command) ||
    /(?:chmod|chown)\s+777/i.test(command)
}

function isAllowedPath(candidate: string, policy: ToolPolicy): boolean {
  const resolved = resolvePath(policy.workspaceDir, candidate)
  if (!resolved || !isContained(policy.workspaceDir, resolved)) return false
  if (policy.deniedPaths.some(path => matchesPath(resolved, policy.workspaceDir, path))) return false
  if (policy.allowedPaths.length === 0) return true
  return policy.allowedPaths.some(path => matchesPath(resolved, policy.workspaceDir, path))
}

function containsOutsideWorkspacePath(command: string, policy: ToolPolicy): boolean {
  const candidates = command.match(/(?:[A-Za-z]:[\\/][^\s"']+|\/[^\s"']+)/g) ?? []
  return candidates.some(candidate => !isAllowedPath(candidate, policy))
}

function matchesPath(resolvedCandidate: string, workspaceDir: string, configured: string): boolean {
  const resolvedConfigured = resolvePath(workspaceDir, configured)
  return Boolean(resolvedConfigured && isContained(resolvedConfigured, resolvedCandidate))
}

function resolvePath(root: string, candidate: string): string | null {
  const normalizedRoot = normalizePath(root)
  const raw = candidate.trim().replaceAll('\\', '/')
  if (!raw) return null
  const absolute = /^[A-Za-z]:\//.test(raw) || raw.startsWith('/')
  const joined = absolute ? raw : `${normalizedRoot}/${raw}`
  const drive = /^[A-Za-z]:/.exec(joined)?.[0] ?? ''
  const pathBody = drive ? joined.slice(drive.length) : joined
  const pieces: string[] = []
  for (const piece of pathBody.split('/')) {
    if (!piece || piece === '.') continue
    if (piece === '..') {
      if (pieces.length === 0) return null
      pieces.pop()
      continue
    }
    pieces.push(piece)
  }
  const prefix = drive ? `${drive}/` : '/'
  return `${prefix}${pieces.join('/')}`.replace(/\/$/, '')
}

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/\/$/, '')
}

function isContained(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePath(root).toLowerCase()
  const normalizedCandidate = normalizePath(candidate).toLowerCase()
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}
