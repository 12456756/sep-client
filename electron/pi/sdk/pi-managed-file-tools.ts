import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { createEditToolDefinition, createWriteToolDefinition, defineTool } from '@earendil-works/pi-coding-agent'
import { boundOriginal, externalEditCandidate, managedFilePath } from '../../../pi-extension/guard'
import type { PiAgentSessionConfig } from './pi-agent-runtime'

const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.css', '.svg', '.yaml', '.yml', '.js', '.ts', '.py'])
const maxBytes = 128 * 1024
const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const committing = new Set<string>()

export function managedFileTools(config: PiAgentSessionConfig) {
  const policy = config.toolPolicy!
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const created = new Map<string, { dev: bigint; ino: bigint }>()
  const safe = (input: string, selected = false) => {
    const path = managedFilePath(input, selected ? { ...policy, fileAccess: 'local' } : policy, true)
    if (!path || policy.preset === 'read-only') throw new Error('File access denied by task policy.')
    return path
  }
  const inspect = async (path: string) => {
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.ino === 0n || before.size > maxBytes) throw new Error('Unsupported text file.')
    const handle = await open(path, constants.O_RDONLY | noFollow)
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || await realpath(path) !== path) throw new Error('File changed.')
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const after = await handle.stat({ bigint: true })
      if (bytesRead > maxBytes || BigInt(bytesRead) !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) throw new Error('File changed.')
      return { info, bytes: buffer.subarray(0, bytesRead) }
    } finally { await handle.close() }
  }
  const read = async (path: string) => {
    if (!textExtensions.has(extname(path).toLowerCase())) throw new Error('Only supported UTF-8 text files can be changed.')
    const result = await inspect(path)
    if (text.decode(result.bytes).includes('\0')) throw new Error('Only supported UTF-8 text files can be changed.')
    return result
  }
  const select = async (input: string, signal: AbortSignal | undefined) => {
    const external = externalEditCandidate(input, policy)
    if (!external) return false
    if (!textExtensions.has(extname(external).toLowerCase())) throw new Error('Only supported UTF-8 text files can be changed.')
    signal?.throwIfAborted()
    if (!await config.authorizeTool({ toolName: 'file_select_original', input: { path: external } })) throw new Error('The original file was not selected.')
    signal?.throwIfAborted()
    return true
  }
  const write = async (input: string, value: string, signal: AbortSignal | undefined, selected: boolean, expected?: Awaited<ReturnType<typeof read>>) => {
    const path = safe(input, selected)
    const bytes = Buffer.from(value, 'utf8')
    if (bytes.length > maxBytes || value.includes('\0')) throw new Error('Text output exceeds the supported limit.')
    let existing = expected
    if (!existing) {
      try { existing = await read(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!existing && selected) throw new Error('Only existing files can be edited outside the workspace. Use Save As for new files.')
    }
    if (!existing) {
      signal?.throwIfAborted()
      await mkdir(dirname(path), { recursive: true })
      if (safe(input) !== path || await realpath(dirname(path)) !== dirname(path)) throw new Error('Output path changed.')
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow)
      try {
        const info = await handle.stat({ bigint: true })
        if (await realpath(path) !== path) throw new Error('Output path changed.')
        await handle.writeFile(bytes)
        created.set(path, info)
      } finally { await handle.close() }
      return
    }
    if (existing.bytes.equals(bytes)) return
    const owned = created.get(path)
    if (selected || (policy.fileAccess !== 'local' && (owned?.dev !== existing.info.dev || owned.ino !== existing.info.ino))) {
      if (policy.unattended) throw new Error('A scheduled task cannot modify a pre-existing file.')
      const approved = await config.authorizeTool({ toolName: 'file_edit_once', input: { path, before: text.decode(existing.bytes), after: value } })
      if (!approved) throw new Error('File change was not approved.')
    }
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (committing.has(key)) throw new Error('Another change is being saved. Request approval again.')
    committing.add(key)
    const temporary = join(dirname(path), `.csep-edit-${randomUUID()}.tmp`)
    let staged = false
    try {
      signal?.throwIfAborted()
      if (safe(input, selected) !== path) throw new Error('File changed; request approval again.')
      const handle = await open(temporary, 'wx', 0o600)
      staged = true
      let identity
      try {
        await handle.writeFile(bytes)
        await handle.chmod(Number(existing.info.mode & 0o777n))
        await handle.sync()
        identity = await handle.stat({ bigint: true })
      } finally { await handle.close() }
      const current = await inspect(path)
      if (current.info.ino !== existing.info.ino || current.info.dev !== existing.info.dev || current.info.mtimeNs !== existing.info.mtimeNs ||
        current.info.ctimeNs !== existing.info.ctimeNs || !current.bytes.equals(existing.bytes) || safe(input, selected) !== path) {
        throw new Error('File changed; request approval again.')
      }
      signal?.throwIfAborted()
      await rename(temporary, path)
      staged = false
      if (owned) created.set(path, identity)
    } finally {
      if (staged) await unlink(temporary).catch(() => undefined)
      committing.delete(key)
    }
  }
  const target = async (input: string, signal?: AbortSignal) => {
    if (!input.startsWith('@original/')) return { input, selected: await select(input, signal), existing: undefined }
    const binding = boundOriginal(input, policy)
    if (!binding) throw new Error('The attachment original is unavailable. Select the original file again.')
    const existing = await read(binding.path)
    if (`${existing.info.dev}:${existing.info.ino}:${existing.info.birthtimeNs}` !== binding.identity) {
      throw new Error('The attachment original changed. Select the original file again.')
    }
    return { input: binding.path, selected: true, existing }
  }
  const baseWrite = createWriteToolDefinition(config.workspaceDir)
  const baseEdit = { ...createEditToolDefinition(config.workspaceDir), renderCall: undefined, renderResult: undefined }
  return [defineTool({
    ...baseWrite,
    async execute(_id, input, signal) {
      const file = await target(input.path, signal)
      await write(file.input, input.content, signal, file.selected, file.existing)
      return { content: [{ type: 'text', text: 'File saved.' }], details: undefined }
    },
  }), defineTool({
    ...baseEdit,
    async execute(id, input, signal, onUpdate, ctx) {
      const file = await target(input.path, signal)
      const path = safe(file.input, file.selected)
      const existing = file.existing ?? await read(path)
      const edit = createEditToolDefinition(config.workspaceDir, { operations: {
        access: async () => undefined,
        readFile: async () => existing.bytes,
        writeFile: async (_path, content) => write(file.input, content, signal, file.selected, existing),
      } })
      return edit.execute(id, input, signal, onUpdate, ctx)
    },
  })]
}
