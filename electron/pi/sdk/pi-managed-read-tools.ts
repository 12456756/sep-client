import { constants, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, join, matchesGlob, relative, resolve } from 'node:path'
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, defineTool } from '@earendil-works/pi-coding-agent'
import { externalFileCandidate, isManagedReadException, managedFilePath } from '../../../pi-extension/guard'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import { decodeToolText } from './pi-text-encoding'
import { isScheduledSkillAlias, type bindScheduledSkills } from './pi-scheduled-skill-read'

export function managedReadTools(config: PiAgentSessionConfig, resolveSkill?: ReturnType<typeof bindScheduledSkills>['resolve']) {
  const cwd = config.workspaceDir
  const policy = config.toolPolicy!
  function checked(input: string, fileException = false, selected = false) {
    const path = managedFilePath(input, selected ? { ...policy, fileAccess: 'local' } : policy)
    if (path) return path
    if (fileException && isManagedReadException(input, policy)) return resolve(cwd, input)
    throw new Error('File access denied by task policy.')
  }
  async function contents(path: string, limit: number, requireCanonical = false) {
    // Check frozen grants with the same canonicalizer used to create them (Windows short names).
    const canonical = requireCanonical ? realpathSync(path) : await realpath(path)
    if (requireCanonical && path !== canonical) throw new Error('File changed.')
    const before = await lstat(canonical, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.ino === 0n || before.size > limit) throw new Error('Unsupported file.')
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await handle.stat({ bigint: true })
      if (info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1n || info.size > limit ||
          (requireCanonical ? realpathSync(path) : await realpath(path)) !== canonical) throw new Error('File changed.')
      const buffer = Buffer.alloc(Number(info.size) + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (BigInt(bytesRead) !== info.size) throw new Error('File changed.')
      return buffer.subarray(0, bytesRead)
    } finally { await handle.close() }
  }
  async function* walk(path: string, glob: string, signal?: AbortSignal) {
    const pending = [checked(path)]
    let scanned = 0
    while (pending.length && scanned++ < 4096) {
      signal?.throwIfAborted()
      const candidate = pending.pop()!
      if (!managedFilePath(candidate, policy)) continue
      try {
        const info = await lstat(candidate)
        if (info.isDirectory()) {
          for (const name of (await readdir(candidate)).slice(0, 4096 - pending.length)) pending.push(join(candidate, name))
        } else if (info.isFile() && matchesGlob(glob.includes('/') ? relative(path, candidate).replaceAll('\\', '/') : basename(candidate), glob)) yield candidate
      } catch { /* Entries can disappear while searching. */ }
    }
  }
  const read = createReadToolDefinition(cwd)
  const find = createFindToolDefinition(cwd)
  const grep = createGrepToolDefinition(cwd)
  return [defineTool({ ...read, async execute(id, input, signal, onUpdate, ctx) {
    if (resolveSkill && isScheduledSkillAlias(input.path)) {
      const target = resolveSkill(input.path)
      if (!target) throw new Error('Unknown skill or resource. Use an exact @skill alias from the available skills list.')
      const unavailable = async (): Promise<never> => {
        await config.reportPolicyEvent?.('tool_call_blocked', { toolName: 'read', reason: 'scheduled-skill-unavailable' })
        throw new Error('The approved scheduled skill could not be read.')
      }
      if (target === 'unavailable') return unavailable()
      signal?.throwIfAborted()
      let bytes: Buffer
      try {
        bytes = await contents(target.path, 24 * 1024 * 1024, true)
        const current = resolveSkill(input.path)
        if (!current || current === 'unavailable' || current.path !== target.path ||
          (target.sha256 && createHash('sha256').update(bytes).digest('hex') !== target.sha256)) throw new Error('Skill changed.')
      } catch {
        signal?.throwIfAborted()
        return unavailable()
      }
      signal?.throwIfAborted()
      const tool = createReadToolDefinition(cwd, { operations: { access: async () => {}, readFile: async () => bytes } })
      return tool.execute(id, input, signal, onUpdate, ctx)
    }
    const exception = isManagedReadException(input.path, policy)
    const outside = !exception && externalFileCandidate(input.path, policy)
    const approved = outside ? await config.authorizeTool({ toolName: 'file_select_original', input: { path: outside } }) : false
    if (outside && !approved) throw new Error('The original file was not selected.')
    signal?.throwIfAborted()
    const path = checked(input.path, exception, approved)
    const tool = createReadToolDefinition(cwd, { operations: {
      access: async () => { checked(input.path, exception, approved) },
      readFile: async () => contents(checked(input.path, exception, approved), 24 * 1024 * 1024),
    } })
    return tool.execute(id, { ...input, path }, signal, onUpdate, ctx)
  } }), defineTool(createLsToolDefinition(cwd, { operations: {
    exists: path => !!managedFilePath(path, policy),
    stat: path => lstat(checked(path)),
    async readdir(path) { return (await readdir(checked(path))).filter(name => managedFilePath(join(path, name), policy)) },
  } })), defineTool({ ...find, async execute(_id, input, signal) {
    const path = checked(input.path ?? cwd)
    const results: string[] = []
    for await (const file of walk(path, input.pattern, signal)) {
      results.push(relative(path, file) || basename(file))
      if (results.length >= Math.max(1, Math.min(input.limit ?? 200, 500))) break
    }
    return { content: [{ type: 'text', text: results.join('\n') || 'No matching files.' }], details: undefined }
  } }), defineTool({ ...grep, description: 'Search permitted UTF-8 text files for a literal string.', async execute(_id, input, signal) {
    if (!input.pattern || input.pattern.length > 512) throw new Error('Provide a literal search string of at most 512 characters.')
    const path = checked(input.path ?? cwd)
    const literal = input.ignoreCase ? input.pattern.toLowerCase() : input.pattern
    const results: string[] = []
    let searched = 0
    for await (const file of walk(path, input.glob ?? '*', signal)) {
      if (searched++ >= 256) break
      const bytes = await contents(checked(file), 512 * 1024).catch(() => null)
      if (!bytes || bytes.includes(0)) continue
      const lines = decodeToolText(bytes).split(/\r?\n/)
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!
        if ((input.ignoreCase ? line.toLowerCase() : line).includes(literal)) results.push(`${relative(path, file) || basename(file)}:${index + 1}: ${line.slice(0, 400)}`)
        if (results.length >= Math.max(1, Math.min(input.limit ?? 100, 100))) break
      }
      if (results.length >= Math.max(1, Math.min(input.limit ?? 100, 100))) break
    }
    return { content: [{ type: 'text', text: results.join('\n') || 'No matching lines in the files searched.' }], details: undefined }
  } })]
}
