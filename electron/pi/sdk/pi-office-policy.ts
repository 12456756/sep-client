import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { evaluateToolCall, isManagedReadException, isUnrestrictedToolPolicy, managedFilePath, type ToolPolicy } from '../../../pi-extension/guard'
import { approvalFileName, type ToolApprovalSummary } from '../../../src/shared/tool-approval'

export { OFFICE_TOOL_NAME } from '../../../src/shared/tool-approval'
export const OFFICE_EXPORT_DOC = 'export-doc'
export const OFFICE_IMPORT_DOC = 'import-doc'
type OfficeApprovalSummary = Extract<ToolApprovalSummary, { kind: 'office' }>
export interface OfficeDecision {
  allowed: boolean
  requiresApproval: boolean
  args: string[]
  lockPaths: string[]
  summary?: OfficeApprovalSummary
  reason?: string
}
const reads = new Set(['get', 'query', 'validate', 'raw', 'view', 'dump'])
const edits = new Set(['create', 'set', 'add', 'remove', 'move', 'swap', 'save', 'close', 'batch', 'import'])
const booleanFlags = new Set(['--json', '--force', '--minimal', '--header', '--stop-on-error'])
const valueFlags = new Set(['--depth', '--type', '--prop', '--to', '--after', '--before', '--index',
  '--start', '--end', '--limit', '--max-lines', '--format', '--locale', '--out', '-o',
  '--commands', '--file', '--delimiter', '--decimal', '--start-cell'])
const resourceKeys = /^(?:path|src|file|filename|source|image|imagepath|imagefile|backgroundimage|poster|audio|video|media|fontfile)$/i
const forbiddenKeys = /(?:xml|relationship|external|ole|embed|script|macro|html|hyperlink|^url$|^href$)/i

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let token = '', quote = '', active = false
  for (const char of command) {
    if (quote) { if (char === quote) quote = ''; else token += char }
    else if (char === '"' || char === "'") { quote = char; active = true }
    else if (/\s/.test(char)) { if (active) tokens.push(token); token = ''; active = false }
    else { token += char; active = true }
  }
  if (quote) throw new Error('Unclosed quote. Use a command argument array for complex text.')
  if (active) tokens.push(token)
  return tokens
}

function within(root: string, candidate: string): boolean {
  const tail = relative(root, candidate)
  return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`)
}

/** Resolve existing parents too, so a new output under a symlink cannot escape its grant. */
function canonicalCandidate(path: string): string {
  const tail: string[] = []
  let current = path
  for (;;) {
    try { lstatSync(current); return join(realpathSync(current), ...tail.reverse()) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) throw new Error('Cannot resolve file path.')
    tail.push(pathSegment(current)); current = parent
  }
}
function pathSegment(path: string): string { return path.slice(dirname(path).length).replace(/^[\\/]/, '') }

export function evaluateOfficeCommand(input: unknown, policy: ToolPolicy): OfficeDecision {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'command')) throw new Error('Expected { command: string | string[] }.')
    const command: unknown = (input as Record<string, unknown>).command
    const args = typeof command === 'string' ? tokenize(command)
      : Array.isArray(command) && command.every(item => typeof item === 'string') ? [...command] as string[] : []
    if (!args.length || args.some(arg => arg.includes('\0'))) throw new Error('A nonempty command is required.')
    const verb = args[0]
    if (verb === 'help' || verb === '--help' || verb === '--version') {
      if (args.slice(1).some(arg => !/^[\w-]+$/.test(arg))) throw new Error('Invalid help argument.')
      return { allowed: true, requiresApproval: false, args, lockPaths: [] }
    }
    const legacyWord = verb === OFFICE_EXPORT_DOC || verb === OFFICE_IMPORT_DOC
    if (!reads.has(verb) && !edits.has(verb) && !legacyWord) throw new Error('Unsupported Office command. Use help or supported document commands.')
    const write = edits.has(verb)
    let requiresApproval = false
    const lockPaths: string[] = []
    const writePaths = new Set<string>()
    const unrestricted = isUnrestrictedToolPolicy(policy)
    function approvalSummary(operation: OfficeApprovalSummary['operation']): OfficeApprovalSummary | undefined {
      const targets = [...writePaths]
      const files = targets.slice(0, 3).map(path => approvalFileName.safeParse(basename(path)))
      const names = files.flatMap(result => result.success ? [result.data] : [])
      return names.length ? { kind: 'office', operation, files: names, additionalFiles: targets.length > names.length } : undefined
    }
    function file(value: string, writing: boolean): string {
      if (!value || /^(?:[a-z][a-z\d+.-]*:\/\/|\\\\)/i.test(value)) throw new Error('Local file paths are required.')
      const absolute = resolve(policy.workspaceDir, value)
      const actual = canonicalCandidate(absolute)
      if (policy.deniedPaths.some(path => {
        const denied = resolve(policy.workspaceDir, path)
        return within(denied, absolute) || within(canonicalCandidate(denied), actual)
      })) throw new Error('File is denied by task policy.')
      if (writing && policy.preset === 'read-only') throw new Error('This task is read-only.')
      if (policy.fileAccess) {
        // Office operates outside the managed text tools; never inherit their external file grants.
        const workspacePolicy = { ...policy, fileAccess: 'workspace' as const }
        if (!policy.allowedTools.includes(writing ? 'write' : 'read') ||
            (!managedFilePath(absolute, workspacePolicy, writing) && (writing || !isManagedReadException(absolute, workspacePolicy)))) {
          throw new Error('File operation is outside this task permission.')
        }
        if (writing && policy.unattended) throw new Error('Office changes require interactive approval.')
        requiresApproval ||= writing
      } else if (!unrestricted) {
        const operation = writing ? 'write' : 'read'
        const decision = evaluateToolCall(operation, { path: actual }, policy)
        if (!decision.allowed) throw new Error('File operation is outside this task permission.')
        if (within(resolve(policy.workspaceDir), absolute) && !within(canonicalCandidate(resolve(policy.workspaceDir)), actual)) {
          throw new Error('File resolves outside the workspace.')
        }
        requiresApproval ||= decision.requiresApproval
      }
      lockPaths.push(actual)
      if (writing) writePaths.add(actual)
      return actual
    }
    if (legacyWord) {
      const importing = verb === OFFICE_IMPORT_DOC
      const sourceExt = importing ? '.doc' : '.docx'
      const destExt = importing ? '.docx' : '.doc'
      if (args.length !== 3 || extname(args[2]).toLowerCase() !== destExt) throw new Error('Use import-doc <input.doc> <new-output.docx> or export-doc <input.docx> <new-output.doc>.')
      for (const path of args.slice(1)) {
        if (/^[\\/]{2}|[<>"|?*]/.test(path) || [...path].some(char => char.charCodeAt(0) < 32)
          || path.slice(/^[a-z]:[\\/]/i.test(path) ? 2 : 0).includes(':')) {
          throw new Error('Use a regular local document path.')
        }
      }
      const source = file(args[1], false)
      const destination = file(args[2], true)
      const attachmentSource = importing && policy.readableAttachmentPaths?.some(path => canonicalCandidate(path) === source)
      if ((!attachmentSource && (extname(args[1]).toLowerCase() !== sourceExt || extname(source).toLowerCase() !== sourceExt))
        || extname(destination).toLowerCase() !== destExt
        || [source, destination].some(path => /^[\\/]{2}/.test(parse(path).root))) {
        throw new Error('Use a supported local Word source and a new local destination.')
      }
      try { lstatSync(resolve(policy.workspaceDir, args[2])); throw new Error('The destination already exists; choose a new path.') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      return { allowed: true, requiresApproval: importing || requiresApproval, args: [verb, source, destination], lockPaths,
        summary: approvalSummary(importing ? 'import-doc' : 'export-doc') }
    }
    function prop(key: string, value: unknown): string {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('Invalid property value.')
      const text = String(value)
      if (forbiddenKeys.test(key) || /<!DOCTYPE|<!ENTITY|TargetMode\s*=|(?:WEBSERVICE|RTD|HYPERLINK)\s*\(|\[[^\]]+\][^!]*!/i.test(text)) {
        throw new Error('External links, raw markup and active content are not supported by this Office integration.')
      }
      if (/formula/i.test(key) && /(?:[|]|https?:|file:|\\\\|\[[^\]]+\])/i.test(text)) throw new Error('External formulas are not supported.')
      if (resourceKeys.test(key) || /(?:file|path|src)$/i.test(key)) return file(text, false)
      return text
    }
    function batch(value: string): string {
      const commands: unknown = JSON.parse(value)
      if (!Array.isArray(commands) || !commands.length) throw new Error('Expected a nonempty batch array.')
      return JSON.stringify(commands.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid batch item.')
        const entry = item as Record<string, unknown>
        if (!['add', 'set', 'remove', 'move', 'swap', 'get', 'query'].includes(String(entry.command))) throw new Error('Unsupported batch verb.')
        if (Object.keys(entry).some(key => !['command', 'parent', 'path', 'selector', 'type', 'props', 'to', 'after', 'before', 'path2', 'index', 'depth'].includes(key))) throw new Error('Unsupported batch field.')
        for (const [key, val] of Object.entries(entry)) if (key !== 'props' && typeof val !== 'string' && typeof val !== 'number') throw new Error('Invalid batch field.')
        let props: Record<string, string> | undefined
        if (entry.props !== undefined) {
          if (!entry.props || typeof entry.props !== 'object' || Array.isArray(entry.props)) throw new Error('Invalid batch props.')
          props = Object.fromEntries(Object.entries(entry.props).map(([key, val]) => [key, prop(key, val)]))
        }
        return { ...entry, ...(props ? { props } : {}) }
      }))
    }
    if (!args[1] || args[1].startsWith('-')) throw new Error('Document path is required.')
    args[1] = file(args[1], write)
    const positionals: number[] = []
    let hasCommands = false
    for (let i = 2; i < args.length; i++) {
      const flag = args[i]
      if (!flag.startsWith('-')) { positionals.push(i); continue }
      if (booleanFlags.has(flag)) continue
      if (!valueFlags.has(flag) || args[i + 1] === undefined) throw new Error('Unsupported or incomplete Office option.')
      const value = args[++i]
      if (flag === '--out' || flag === '-o') {
        args[i] = file(value, true)
      }
      else if (flag === '--file') { if (verb !== 'import') throw new Error('--file is only supported for import.'); args[i] = file(value, false) }
      else if (flag === '--prop') {
        const equal = value.indexOf('=')
        if (equal <= 0) throw new Error('Property must use key=value.')
        args[i] = value.slice(0, equal + 1) + prop(value.slice(0, equal), value.slice(equal + 1))
      } else if (flag === '--commands') {
        if (verb !== 'batch') throw new Error('--commands is only supported for batch.')
        args[i] = batch(value); hasCommands = true
      }
    }
    const maxPositionals = verb === 'import' || verb === 'swap' ? 2
      : ['get', 'query', 'view', 'raw', 'dump', 'set', 'add', 'remove', 'move'].includes(verb) ? 1 : 0
    if (positionals.length > maxPositionals) throw new Error('Unexpected positional argument.')
    if (verb === 'view' && !['text', 'outline', 'stats', 'issues', 'annotated', 'html'].includes(args[positionals[0]])) throw new Error('Unsupported view mode.')
    if (verb === 'import' && positionals[1] !== undefined) args[positionals[1]] = file(args[positionals[1]], false)
    if (verb === 'batch' && !hasCommands) throw new Error('Use an inline --commands batch so all operations can be checked.')
    return { allowed: true, requiresApproval, args, lockPaths: [...new Set(lockPaths)],
      summary: requiresApproval ? approvalSummary(verb === 'batch' ? 'batch' : write && verb !== 'create' ? 'edit' : 'write') : undefined }
  } catch (error) {
    return { allowed: false, requiresApproval: false, args: [], lockPaths: [],
      reason: error instanceof Error ? error.message : 'Invalid Office command.' }
  }
}
