/**
 * Provider-neutral tool policy. SDK-specific hooks live in electron/pi/sdk.
 *
 * The side-effecting tool list has one shared definition in electron/common/constants.ts.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { hasSideEffects, SIDE_EFFECT_TOOLS } from '../electron/common/constants'
import type { ConversationArtifactDirectory } from '../electron/domain/conversation-artifacts'

export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
export const BUILTIN_TOOL_NAMES = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'] as const
export type ToolPermissionPreset = 'read-only' | 'workspace-edit' | 'full-local'

export interface ApprovedSkillReadPath {
  readonly entryPath: string
  readonly packageRoot?: string
  readonly sha256?: string
  readonly label?: Readonly<{ name: string; description: string }>
}

export interface ToolPolicy {
  /** Persisted permission preset. Full-local + auto-approve is the unrestricted mode. */
  preset?: ToolPermissionPreset
  allowedTools: readonly string[]
  allowedPaths: readonly string[]
  deniedPaths: readonly string[]
  commandPolicy: 'disabled' | 'restricted' | 'confirm-each'
  approvalMode: 'confirm-each' | 'auto-approve'
  workspaceDir: string
  fileAccess?: 'workspace' | 'local'
  unattended?: boolean
  allowExternalSaveAs?: boolean
  applicationDataRoot?: string
  /** Host-owned default for conversation outputs; this grants no additional access. */
  conversationOutput?: ConversationArtifactDirectory
  originalFiles?: ReadonlyMap<string, { path: string; identity: string }>
  /** Canonical paths fixed by the host from this run's approved skill snapshot. */
  approvedSkillPaths?: readonly ApprovedSkillReadPath[]
  /** Exact host-verified delivery snapshot files; never a directory-wide write grant. */
  readableDeliveryPaths?: readonly string[]
  /** Exact host-verified attachment snapshot files; read-only only. */
  readableAttachmentPaths?: readonly string[]
  /** Display names keyed by canonical attachment snapshot path; metadata only. */
  attachmentNamesByPath?: ReadonlyMap<string, string>
}

export type RegisteredToolPermissions = ReadonlyMap<string, 'confirm-each' | 'auto-approve'>

export interface ToolDecision {
  allowed: boolean
  requiresApproval: boolean
  reason?: string
}

export function isUnrestrictedToolPolicy(
  policy: Pick<ToolPolicy, 'preset' | 'approvalMode'> | undefined,
): boolean {
  return policy?.preset === 'full-local' && policy.approvalMode === 'auto-approve' && !('fileAccess' in policy && policy.fileAccess)
}

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName)
}

export function requiresToolApproval(toolName: string): boolean {
  return SIDE_EFFECT_TOOLS.has(toolName)
}

export function isKnownTool(toolName: string): boolean {
  return isReadOnlyTool(toolName) || requiresToolApproval(toolName)
}

/**
 * Final provider-neutral task policy check. It does not execute tools or touch Electron IPC.
 */
export function evaluateToolCall(
  toolName: string, input: unknown, policy: ToolPolicy, registeredTools?: RegisteredToolPermissions,
): ToolDecision {
  if (isUnrestrictedToolPolicy(policy)) {
    if (isKnownTool(toolName) || registeredTools?.has(toolName)) {
      return { allowed: true, requiresApproval: false }
    }
    return { allowed: false, requiresApproval: false, reason: 'unknown-tool' }
  }

  const registeredApproval = registeredTools?.get(toolName)
  if (registeredApproval) {
    if (!policy.allowedTools.includes(toolName)) return { allowed: false, requiresApproval: false, reason: 'tool-not-allowed' }
    return { allowed: true, requiresApproval: registeredApproval !== 'auto-approve' }
  }
  if (!isKnownTool(toolName)) return { allowed: false, requiresApproval: false, reason: 'unknown-tool' }
  if (!policy.allowedTools.includes(toolName)) return { allowed: false, requiresApproval: false, reason: 'tool-not-allowed' }

  if (policy.fileAccess) {
    if (toolName === 'bash') return { allowed: false, requiresApproval: false, reason: 'command-disabled' }
    const requestedPath = readString(input, ['path', 'filePath', 'file_path', 'filename', 'target'])
      ?? (toolName === 'ls' || toolName === 'grep' || toolName === 'find' ? policy.workspaceDir : null)
    const path = toolName === 'write' && requestedPath ? managedWriteTarget(requestedPath, policy) : requestedPath
    const writing = toolName === 'write' || toolName === 'edit'
    if (path && (writing ? policy.preset !== 'read-only' && (boundOriginal(path, policy) || managedFilePath(path, policy, true) || externalEditCandidate(path, policy)) :
      managedFilePath(path, policy) || toolName === 'read' && (isManagedReadException(path, policy) || externalFileCandidate(path, policy)))) {
      return { allowed: true, requiresApproval: false }
    }
    return { allowed: false, requiresApproval: false, reason: 'path-not-allowed' }
  }

  if (toolName === 'bash') {
    if (policy.commandPolicy === 'disabled') return { allowed: false, requiresApproval: false, reason: 'command-disabled' }
    const command = readString(input, ['command', 'cmd'])
    if (!command || isDangerousCommand(command) || containsOutsideWorkspacePath(command, policy)) {
      return { allowed: false, requiresApproval: false, reason: 'unsafe-command' }
    }
  } else if (hasSideEffects(toolName) || isReadOnlyTool(toolName)) {
    const path = readString(input, ['path', 'filePath', 'file_path', 'filename', 'target'])
    const optionalPath = toolName === 'grep' || toolName === 'find' || toolName === 'ls'
    const candidatePath = path ?? (optionalPath ? policy.workspaceDir : null)
    if (!candidatePath || (!isAllowedPath(candidatePath, policy)
      && !(toolName === 'read' && (isApprovedSkillRead(candidatePath, policy) || isApprovedDeliveryRead(candidatePath, policy) || isApprovedAttachmentRead(candidatePath, policy))))) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: path || optionalPath ? 'path-not-allowed' : 'path-required',
      }
    }
  }

  return {
    allowed: true,
    requiresApproval: hasSideEffects(toolName) && policy.approvalMode !== 'auto-approve',
  }
}

/** Resolves native paths without guessing another spelling for an existing file. */
function normalizedManagedPath(candidate: string, policy: ToolPolicy): string | null {
  if (!candidate || candidate !== candidate.trim() || [...candidate].some(char => char.charCodeAt(0) < 32)) return null
  if (process.platform === 'win32' && (/^(?:[\\/]{1,2}|[A-Za-z]:(?![\\/]))/.test(candidate) || /:/.test(candidate.replace(/^[A-Za-z]:/, '')))) return null
  const target = resolve(policy.workspaceDir, candidate)
  const parts = target.slice(parse(target).root.length).split(sep)
  if (parts.some(part => /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.agents|\.pi-runs|\.pi-sessions|\.npmrc|\.netrc|\.env(?:\..*)?)$/i.test(part) ||
    process.platform === 'win32' && (/[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) return null
  if (policy.deniedPaths.some(path => containsNativePath(resolve(policy.workspaceDir, path), target))) return null
  if (policy.allowedPaths.length && !policy.allowedPaths.some(path => containsNativePath(resolve(policy.workspaceDir, path), target))) return null
  if (policy.applicationDataRoot && containsNativePath(policy.applicationDataRoot, target)) {
    const workspaces = join(policy.applicationDataRoot, 'task-workspaces', 'v1')
    const workspace = resolve(policy.workspaceDir)
    if (workspace === workspaces || !containsNativePath(workspaces, workspace) || !containsNativePath(workspace, target)) return null
  }
  return target
}

export function externalEditCandidate(input: string, policy: ToolPolicy): string | null {
  return policy.preset === 'read-only' ? null : externalFileCandidate(input, policy)
}

export function managedWriteTarget(input: string, policy: ToolPolicy): string | null {
  const output = policy.conversationOutput
  if (!output || !input || input !== input.trim() || input === '.' || input === '..' || /[/\\:]/.test(input)) return input
  return output.status === 'unsafe' ? null : join(output.relativePath, input)
}

export function boundOriginal(input: string, policy: ToolPolicy) {
  const original = !policy.unattended && policy.preset !== 'read-only' ? policy.originalFiles?.get(input) : undefined
  if (!original || !managedFilePath(original.path, { ...policy, fileAccess: 'local' }, true)) return undefined
  return original
}

export function externalFileCandidate(input: string, policy: ToolPolicy): string | null {
  if (policy.fileAccess !== 'workspace' || policy.unattended || !isAbsolute(input)) return null
  const target = normalizedManagedPath(input, policy)
  return target && !containsNativePath(resolve(policy.workspaceDir), target) ? target : null
}

export function isManagedReadException(path: string, policy: ToolPolicy): boolean {
  return isApprovedSkillRead(path, policy) || isApprovedDeliveryRead(path, policy) || isApprovedAttachmentRead(path, policy)
}

export function managedFilePath(candidate: string, policy: ToolPolicy, writing = false): string | null {
  const target = normalizedManagedPath(candidate, policy)
  if (!target) return null
  try {
    if (policy.fileAccess !== 'local') {
      const root = realpathSync(policy.workspaceDir)
      if (!containsNativePath(resolve(policy.workspaceDir), target) || !containsNativePath(root, target)) return null
    }
    let current = target
    while (true) {
      try {
        const info = lstatSync(current)
        if (info.isSymbolicLink() || realpathSync(current) !== current || (info.isFile() && info.nlink !== 1)) return null
        if (current === target) return writing ? info.isFile() ? target : null : info.isFile() || info.isDirectory() ? target : null
        return info.isDirectory() ? target : null
      } catch (error) {
        if (!writing || (error as NodeJS.ErrnoException).code !== 'ENOENT') return null
        const parent = dirname(current)
        if (parent === current) return null
        current = parent
      }
    }
  } catch { return null }
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

function containsNativePath(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate)
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
}

function isApprovedDeliveryRead(candidate: string, policy: ToolPolicy): boolean {
  if (!policy.readableDeliveryPaths?.length) return false
  try {
    const absolute = resolve(policy.workspaceDir, candidate)
    const actual = realpathSync(absolute)
    if (!statSync(actual).isFile()) return false
    if (policy.deniedPaths.some(path => {
      const denied = resolve(policy.workspaceDir, path)
      if (containsNativePath(denied, absolute) || containsNativePath(denied, actual)) return true
      try { return containsNativePath(realpathSync(denied), actual) } catch { return false }
    })) return false
    return policy.readableDeliveryPaths.some(path => path === actual && realpathSync(path) === path)
  } catch { return false }
}

function isApprovedAttachmentRead(candidate: string, policy: ToolPolicy): boolean {
  if (!policy.readableAttachmentPaths?.length) return false
  try {
    const absolute = resolve(policy.workspaceDir, candidate)
    const actual = realpathSync(absolute)
    if (!statSync(actual).isFile()) return false
    if (policy.deniedPaths.some(path => {
      const denied = resolve(policy.workspaceDir, path)
      if (containsNativePath(denied, absolute) || containsNativePath(denied, actual)) return true
      try { return containsNativePath(realpathSync(denied), actual) } catch { return false }
    })) return false
    return policy.readableAttachmentPaths.some(path => {
      try { return realpathSync(path) === path && actual === path } catch { return false }
    })
  } catch { return false }
}

export function isApprovedSkillRead(candidate: string, policy: ToolPolicy): boolean {
  if (!policy.approvedSkillPaths?.length) return false
  try {
    const absolute = resolve(policy.workspaceDir, candidate)
    const actual = realpathSync(absolute)
    if (!statSync(actual).isFile()) return false
    if (policy.deniedPaths.some(configured => {
      const denied = resolve(policy.workspaceDir, configured)
      if (containsNativePath(denied, absolute) || containsNativePath(denied, actual)) return true
      try { return containsNativePath(realpathSync(denied), actual) } catch { return false }
    })) return false
    return policy.approvedSkillPaths.some(({ entryPath, packageRoot }) => {
      // A replaced entry/root symlink must not redefine the frozen grant.
      if (realpathSync(entryPath) !== entryPath) return false
      if (!packageRoot) return actual === entryPath
      return realpathSync(packageRoot) === packageRoot && containsNativePath(packageRoot, actual)
    })
  } catch {
    return false
  }
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
