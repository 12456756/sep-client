import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep, basename, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { skillZipHeaders, skillZipEnd } from '../common/skill-zip-format'
// @ts-expect-error js-yaml is an existing runtime dependency without local typings.
import { load, CORE_SCHEMA } from 'js-yaml'

export interface SkillImportRoot {
  id: string
  label: string
  scope: 'user' | 'project'
  sources: string[]
  path: string
}
export interface SkillImportCandidate {
  candidateId: string
  revision: number
  name: string
  description: string | null
  sources: string[]
  scope: 'user' | 'project'
  locations: Array<{ rootId: string; rootLabel: string; relativePath: string }>
  treeHash: string | null
  availability: 'previewable' | 'blocked'
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'blocking' }>
}
export interface SkillImportPreview {
  requestId: string; candidateId: string; snapshotId: string; expiresAt: string; content: string; treeHash: string
  fileCount: number; totalUncompressedBytes: number; estimatedPackageBytes: number
  files: Array<{ relativePath: string; bytes: number }>; nextFilesCursor: null
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'blocking' }>
}
export class SkillImportFileError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'SkillImportFileError'; this.code = code }
}
interface FileEntry { relativePath: string; absolutePath: string; bytes: number; dev: number; ino: number; mtimeMs: number; mode: number }
type FileWarning = SkillImportPreview['warnings'][number]
interface CandidateInternal extends Omit<SkillImportCandidate, 'treeHash'> { treeHash: string | null; directory: string; rootPath: string; files: FileEntry[]; rootIds: string[] }
interface Snapshot { id: string; candidateId: string; treeHash: string; expiresAt: string; files: FileEntry[]; directories: string[]; fileHashes: Map<string, string>; content: string; fileCount: number; totalBytes: number }
interface Options { homeDir?: string; tempDir: string; xdgConfigHome?: string; platform?: NodeJS.Platform }
interface ScanOptions { signal?: AbortSignal }
interface PreviewRequest { requestId: string; candidateId: string; revision: number; expiresAt?: string }
interface PackageRequest { candidateId: string; snapshotId: string; operationId: string }

const ignoredDirs = new Set(['.git', 'node_modules', '.cache', 'cache'])
const projectAgentSources: Record<string, string> = {
  '.agents': 'agents', '.claude': 'claude-code', '.codex': 'codex', '.gemini': 'gemini-cli', '.opencode': 'opencode',
  '.workbuddy': 'workbuddy', '.codebuddy': 'codebuddy', '.qoder': 'qoder', '.qwen': 'qwen-code', '.kimi': 'kimi-code',
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let crc = n; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc >>> 0 })
function crcUpdate(crc: number, bytes: Buffer): number { for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!; return crc >>> 0 }
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..') }
async function canonicalRootPath(path: string): Promise<string> {
  const missing: string[] = []
  let ancestor = path
  for (;;) {
    try { return resolve(await realpath(ancestor), ...missing.reverse()) }
    catch (error) {
      const parent = dirname(ancestor)
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT' || parent === ancestor) throw error
      missing.push(basename(ancestor))
      ancestor = parent
    }
  }
}
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error('IMPORT_CANCELLED') }
function safePath(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.includes('\\') && ![...value].some(char => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127
  }) && value.split('/').every(part => part && part !== '.' && part !== '..')
}
function safeFilename(value: string): string { return value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill' }
function publicPath(root: string, path: string): string { return relative(root, path).split(sep).join('/') || 'SKILL.md' }

function candidateSources(root: SkillImportRoot, directory: string): string[] {
  if (root.scope === 'user') return [...root.sources]
  const parts = [basename(dirname(root.path)), basename(root.path), ...relative(root.path, directory).split(sep)]
  for (let i = parts.length - 2; i >= 0; i--) {
    const source = projectAgentSources[parts[i]!]
    if (source && (parts[i + 1] === 'skills' || (source === 'opencode' && parts[i + 1] === 'skill'))) return [source]
  }
  return ['project']
}

function parseSkill(content: string): { name: string; description: string | null } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const match = /^---[\t ]*\n([\s\S]*?)\n---[\t ]*(?:\n|$)/.exec(normalized)
  if (!match) throw new Error('INVALID_SKILL_FRONTMATTER')
  let metadata: unknown
  try { metadata = load(match[1]!, { schema: CORE_SCHEMA, maxAliasCount: 20 }) } catch { throw new Error('INVALID_SKILL_FRONTMATTER') }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('INVALID_SKILL_FRONTMATTER')
  const value = metadata as Record<string, unknown>
  const name = typeof value['name'] === 'string' && value['name'].trim() ? value['name'].trim() : ''
  const description = typeof value['description'] === 'string' && value['description'].trim() ? value['description'].trim() : null
  if (!name) throw new Error('INVALID_SKILL_FRONTMATTER')
  return { name, description }
}

export class SkillImportFiles {
  private readonly homeDir: string
  private readonly tempDir: string
  private readonly xdgConfigHome: string
  private readonly platform: NodeJS.Platform
  private roots = new Map<string, SkillImportRoot>()
  private candidates = new Map<string, CandidateInternal>()
  private snapshots = new Map<string, Snapshot>()
  private packages = new Set<string>()
  private readonly removedRootIds = new Set<string>()
  private readonly existingRootIds = new Set<string>()
  private scanWarnings: Array<{ code: string; rootId?: string }> = []

  constructor(options: Options) {
    this.homeDir = resolve(options.homeDir ?? homedir())
    this.tempDir = resolve(options.tempDir)
    this.xdgConfigHome = resolve(options.xdgConfigHome ?? join(this.homeDir, '.config'))
    this.platform = options.platform ?? process.platform
  }

  async listRoots(): Promise<SkillImportRoot[]> {
    const canonicalHome = await realpath(this.homeDir).catch(() => this.homeDir)
    const canonicalConfig = await realpath(this.xdgConfigHome).catch(() => this.xdgConfigHome)
    const roots: Array<{ path: string; sources: string[]; label: string; optional?: boolean }> = [
      { path: join(this.homeDir, '.agents', 'skills'), sources: ['agents'], label: '共享 Skills' },
      { path: join(this.homeDir, '.claude', 'skills'), sources: ['claude-code'], label: 'Claude Code · skills' },
      { path: join(this.homeDir, '.codex', 'skills'), sources: ['codex'], label: 'Codex · skills' },
      { path: join(this.homeDir, '.gemini', 'skills'), sources: ['gemini-cli'], label: 'Gemini CLI · skills' },
      { path: join(this.xdgConfigHome, 'opencode', 'skills'), sources: ['opencode'], label: 'OpenCode · XDG skills' },
      { path: join(this.xdgConfigHome, 'opencode', 'skill'), sources: ['opencode'], label: 'OpenCode · XDG skill (legacy)' },
      ...[
        { directory: '.workbuddy', source: 'workbuddy', label: 'WorkBuddy' },
        { directory: '.codebuddy', source: 'codebuddy', label: 'CodeBuddy' },
        { directory: '.qoder', source: 'qoder', label: 'Qoder' },
        { directory: '.qwen', source: 'qwen-code', label: 'Qwen Code' },
        { directory: '.kimi', source: 'kimi-code', label: 'Kimi Code' },
      ].map(agent => ({ path: join(this.homeDir, agent.directory, 'skills'), sources: [agent.source], label: `${agent.label} · skills`, optional: true })),
      { path: join(this.xdgConfigHome, 'agents', 'skills'), sources: ['agents'], label: '共享 Skills · XDG', optional: true },
      { path: join(this.homeDir, '.workbuddy', 'plugins', 'cache'), sources: ['workbuddy'], label: 'WorkBuddy · 本地插件', optional: true },
      { path: join(this.homeDir, '.workbuddy', 'plugins', 'marketplaces', 'workbuddy-builtin', 'skills'), sources: ['workbuddy'], label: 'WorkBuddy · 内置 Skills', optional: true },
    ]
    if (this.platform === 'darwin') {
      roots.push({ path: join(this.homeDir, 'Library', 'Application Support', 'opencode', 'skills'), sources: ['opencode'], label: 'OpenCode · macOS skills' })
      roots.push({ path: join(this.homeDir, 'DoubaoWork', 'skills'), sources: ['doubao-work'], label: '豆包办公 · 用户 Skills', optional: true })
      roots.push({ path: join(this.homeDir, 'Library', 'Application Support', 'DoubaoWork', 'Default', '.doubaowork', 'agent_mode', 'workspace', '.skills'), sources: ['doubao-work'], label: '豆包办公 · 内置 Skills', optional: true })
    }
    if (this.platform === 'win32') roots.push({ path: join(this.homeDir, 'AppData', 'Roaming', 'opencode', 'skills'), sources: ['opencode'], label: 'OpenCode · Windows skills' })
    const found: SkillImportRoot[] = []
    for (const item of roots) {
      const path = resolve(item.path)
      let real = path
      let exists = false
      try {
        if (!(await stat(path)).isDirectory()) continue
        real = await realpath(path)
        exists = true
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          if (item.optional) continue
          real = await canonicalRootPath(path)
        }
        else continue
      }
      if (!within(canonicalHome, real) && !within(canonicalConfig, real)) continue
      const id = createHash('sha256').update(`${this.platform}\0${real}`).digest('hex').slice(0, 24)
      if (this.removedRootIds.has(id)) continue
      if (exists) this.existingRootIds.add(id)
      const existing = found.find(root => root.id === id)
      if (existing) {
        existing.sources = [...new Set([...existing.sources, ...item.sources])]
        continue
      }
      const root = { id, path: real, label: item.label, scope: 'user' as const, sources: item.sources }
      this.roots.set(id, root)
      found.push(root)
    }
    for (const [id, root] of this.roots) if (root.scope === 'project' && !found.some(item => item.id === id)) found.push(root)
    return found
  }

  async initialize(): Promise<void> {
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 })
    const now = Date.now()
    for (const name of await readdir(this.tempDir).catch(() => [])) {
      if (!name.startsWith('skill-import-') || !name.endsWith('.zip')) continue
      const path = join(this.tempDir, name)
      const info = await stat(path).catch(() => null)
      if (info && now - info.mtimeMs > 60 * 60_000) await rm(path, { force: true }).catch(() => undefined)
    }
  }

  async addProjectRoot(path: string): Promise<SkillImportRoot> {
    const real = await realpath(resolve(path))
    if (!(await stat(real)).isDirectory()) throw new Error('ROOT_NOT_DIRECTORY')
    const id = createHash('sha256').update(`project\0${real}`).digest('hex').slice(0, 24)
    const root: SkillImportRoot = { id, path: real, label: basename(real) || 'project', scope: 'project', sources: ['project'] }
    this.removedRootIds.delete(id)
    this.roots.set(id, root)
    this.existingRootIds.add(id)
    return root
  }

  async restoreRoot(id: string, path: string): Promise<SkillImportRoot> {
    const root = await this.addProjectRoot(path)
    if (root.id !== id) throw new Error('ROOT_ID_MISMATCH')
    return root
  }

  getScanWarnings(): ReadonlyArray<{ code: string; rootId?: string }> { return [...this.scanWarnings] }

  async removeRoot(id: string): Promise<void> {
    this.removedRootIds.add(id)
    this.roots.delete(id)
    for (const [candidateId, candidate] of this.candidates) if (candidate.rootIds.includes(id)) this.candidates.delete(candidateId)
    for (const [snapshotId, snapshot] of this.snapshots) if (!this.candidates.has(snapshot.candidateId)) this.snapshots.delete(snapshotId)
  }

  async scan(rootIds: string[], options: ScanOptions = {}): Promise<SkillImportCandidate[]> {
    const selected = [...new Set(rootIds)].map(id => {
      const root = this.roots.get(id)
      if (!root) throw new Error('UNKNOWN_ROOT_ID')
      return root
    })
    this.candidates.clear()
    this.snapshots.clear()
    this.scanWarnings = []
    const results: CandidateInternal[] = []
    for (const root of selected) {
      abort(options.signal)
      let rootPath: string
      try { rootPath = await realpath(root.path) } catch (error) {
        if (this.existingRootIds.has(root.id) || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') this.scanWarnings.push({ code: 'ROOT_UNAVAILABLE', rootId: root.id })
        continue
      }
      if (rootPath !== root.path) { this.scanWarnings.push({ code: 'ROOT_CHANGED', rootId: root.id }); continue }
      this.existingRootIds.add(root.id)
      const dirs: string[] = []
      const starts = [rootPath]
      if (root.scope === 'project') {
        for (const relativePath of [...Object.keys(projectAgentSources).map(agent => `${agent}/skills`), '.opencode/skill', 'skills']) {
          const path = join(rootPath, ...relativePath.split('/'))
          try { const real = await realpath(path); if (within(rootPath, real) && (await stat(real)).isDirectory()) starts.push(real) } catch { /* optional project agent root */ }
        }
      }
      for (const start of [...new Set(starts)]) {
        if (await this.hasEntry(start)) dirs.push(start)
      }
      const queue = [...new Set(starts)]
      const visited = new Set<string>()
      for (let index = 0; index < queue.length; index++) {
        abort(options.signal)
        const current = queue[index]!
        if (visited.has(current)) continue
        visited.add(current)
        let directory
        try { directory = await opendir(current) } catch { continue }
        for await (const entry of directory) {
          abort(options.signal)
          if (ignoredDirs.has(entry.name.toLowerCase()) || !entry.isDirectory() || entry.isSymbolicLink()) continue
          const path = join(current, entry.name)
          try { const real = await realpath(path); if (!within(rootPath, real)) continue; if (await this.hasEntry(real)) dirs.push(real); else queue.push(real) } catch { this.scanWarnings.push({ code: 'DIRECTORY_UNAVAILABLE', rootId: root.id }) }
        }
      }
      for (const directory of [...new Set(dirs)]) {
        abort(options.signal)
        try {
          const candidate = await this.inspect(root, rootPath, directory, options.signal)
          const duplicate = results.find(item => item.treeHash === candidate.treeHash && item.directory === directory)
          if (duplicate) { duplicate.sources = [...new Set([...duplicate.sources, ...candidate.sources])]; duplicate.rootIds.push(root.id); duplicate.locations.push(...candidate.locations); continue }
          results.push(candidate)
        } catch (error) {
          if (error instanceof Error && error.message === 'IMPORT_CANCELLED') throw error
          this.scanWarnings.push({ code: error instanceof Error ? error.message : 'CANDIDATE_UNAVAILABLE', rootId: root.id })
        }
      }
    }
    for (const candidate of results) this.candidates.set(candidate.candidateId, candidate)
    return results.map(({ directory: _directory, rootPath: _rootPath, files: _files, rootIds: _rootIds, ...candidate }) => candidate)
  }

  async preview(request: PreviewRequest, signal?: AbortSignal): Promise<SkillImportPreview> {
    abort(signal)
    const candidate = this.candidates.get(request.candidateId)
    if (!candidate || candidate.revision !== request.revision) throw new SkillImportFileError('CANDIDATE_CHANGED')
    const entry = candidate.files.find(file => file.relativePath.toLowerCase() === 'skill.md')
    if (!entry) throw new SkillImportFileError('ENTRY_MISSING')
    const { files, directories, warnings } = await this.enumerate(candidate.directory, candidate.rootPath, signal)
    const hash = createHash('sha256')
    for (const path of directories) hash.update(`directory\0${path}\0`)
    const fileHashes = new Map<string, string>()
    for (const file of files) {
      abort(signal)
      if (isSecret(file.relativePath)) throw new SkillImportFileError('SECRET_FILE_BLOCKED')
      const fileHash = createHash('sha256')
      for await (const chunk of this.readChunks(file, candidate.rootPath, signal)) fileHash.update(chunk)
      const digest = fileHash.digest('hex')
      fileHashes.set(file.relativePath, digest)
      hash.update(`file\0${file.relativePath}\0${digest}\0`)
    }
    const treeHash = hash.digest('hex')
    const content = await this.readChecked(entry, candidate.rootPath, signal)
    const contentHash = createHash('sha256').update(content).digest('hex')
    if (contentHash !== fileHashes.get(entry.relativePath)) throw new SkillImportFileError('CANDIDATE_CHANGED')
    const snapshotId = randomUUID().replaceAll('-', '')
    const expiresAt = new Date(Math.min(request.expiresAt ? Date.parse(request.expiresAt) : Infinity, Date.now() + 5 * 60_000)).toISOString()
    let localBytes = 0
    let centralBytes = 0
    for (const item of [...directories.map(path => ({ name: path + '/', size: 0 })), ...files.map(file => ({ name: file.relativePath, size: file.bytes }))]) {
      const headers = skillZipHeaders({ name: Buffer.from(item.name), size: item.size, crc: 0, offset: localBytes })
      localBytes += headers.local.length + item.size
      centralBytes += headers.central.length
    }
    const estimatedPackageBytes = localBytes + centralBytes + skillZipEnd(files.length + directories.length, centralBytes, localBytes).length
    this.snapshots.set(snapshotId, { id: snapshotId, candidateId: candidate.candidateId, treeHash, expiresAt, files, directories, fileHashes, content: content.toString('utf8'), fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) })
    return { requestId: request.requestId, candidateId: candidate.candidateId, snapshotId, expiresAt, content: content.toString('utf8'), treeHash, fileCount: files.length, totalUncompressedBytes: files.reduce((sum, file) => sum + file.bytes, 0), estimatedPackageBytes, files: files.map(file => ({ relativePath: file.relativePath, bytes: file.bytes })), nextFilesCursor: null, warnings: [...candidate.warnings, ...warnings].slice(0, 32) }
  }

  async packageSelected(request: PackageRequest, signal?: AbortSignal): Promise<{ sha256: string; bytes: number; filename: string; open: () => AsyncIterable<Uint8Array> }> {
    abort(signal)
    const snapshot = this.snapshots.get(request.snapshotId)
    const candidate = this.candidates.get(request.candidateId)
    if (!snapshot || !candidate || snapshot.candidateId !== candidate.candidateId || Date.parse(snapshot.expiresAt) <= Date.now()) throw new SkillImportFileError('SNAPSHOT_EXPIRED')
    const { files: current, directories } = await this.enumerate(candidate.directory, candidate.rootPath, signal)
    if (current.map(file => file.relativePath).join('\0') !== snapshot.files.map(file => file.relativePath).join('\0')) throw new SkillImportFileError('CANDIDATE_CHANGED')
    if (directories.join('\0') !== snapshot.directories.join('\0')) throw new SkillImportFileError('CANDIDATE_CHANGED')
    for (const file of current) {
      const digest = createHash('sha256')
      for await (const chunk of this.readChunks(file, candidate.rootPath, signal)) digest.update(chunk)
      if (digest.digest('hex') !== snapshot.fileHashes.get(file.relativePath)) throw new SkillImportFileError('CANDIDATE_CHANGED')
    }
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 })
    const packagePath = join(this.tempDir, `skill-import-${randomUUID()}.zip`)
    const output = createWriteStream(packagePath, { flags: 'wx', mode: 0o600, signal })
    // Observe failures immediately, including while source files are being read.
    const completion = finished(output, { cleanup: true }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    )
    const metadata: Array<{ name: Buffer; crc: number; size: number; offset: number; directory?: boolean }> = []
    let offset = 0
    const sha = createHash('sha256')
    const emit = async (buffer: Buffer) => {
      abort(signal)
      if (output.errored) throw output.errored
      offset += buffer.length
      if (!output.write(buffer)) await Promise.race([
        once(output, 'drain', { signal }),
        completion.then(({ error }) => { throw error ?? new Error('PACKAGE_WRITER_CLOSED') }),
      ])
      sha.update(buffer)
    }
    try {
      for (const path of snapshot.directories) {
        const name = Buffer.from(path + '/', 'utf8')
        const { local } = skillZipHeaders({ name, crc: 0, size: 0, offset, directory: true })
        metadata.push({ name, crc: 0, size: 0, offset, directory: true })
        await emit(local)
      }
      for (const file of snapshot.files) {
        abort(signal)
        let fileCrc = 0xffffffff
        const firstHash = createHash('sha256')
        for await (const chunk of this.readChunks(file, candidate.rootPath, signal)) { fileCrc = crcUpdate(fileCrc, chunk); firstHash.update(chunk) }
        if (firstHash.digest('hex') !== snapshot.fileHashes.get(file.relativePath)) throw new SkillImportFileError('CANDIDATE_CHANGED')
        const checksum = (fileCrc ^ 0xffffffff) >>> 0
        const name = Buffer.from(file.relativePath, 'utf8')
        const { local } = skillZipHeaders({ name, crc: checksum, size: file.bytes, offset })
        metadata.push({ name, crc: checksum, size: file.bytes, offset }); await emit(local)
        const contentHash = createHash('sha256')
        for await (const chunk of this.readChunks(file, candidate.rootPath, signal)) { contentHash.update(chunk); await emit(chunk) }
        if (contentHash.digest('hex') !== snapshot.fileHashes.get(file.relativePath)) throw new SkillImportFileError('CANDIDATE_CHANGED')
      }
      const centralOffset = offset
      for (const item of metadata) {
        await emit(skillZipHeaders(item).central)
      }
      const centralSize = offset - centralOffset
      await emit(skillZipEnd(metadata.length, centralSize, centralOffset))
      output.end()
      const written = await completion
      if (written.error) throw written.error
      abort(signal)
      await chmod(packagePath, 0o600)
      const bytes = offset
      const result = { sha256: sha.digest('hex'), bytes, filename: `${safeFilename(candidate.name)}.zip`, open: async function* () { for await (const chunk of createReadStream(packagePath, { highWaterMark: 64 * 1024 })) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk) } }
      this.packages.add(packagePath)
      return result
    } catch (error) {
      output.destroy()
      await completion
      await rm(packagePath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async reset(): Promise<void> { this.candidates.clear(); this.snapshots.clear(); this.scanWarnings = []; for (const file of this.packages) await rm(file, { force: true }).catch(() => undefined); this.packages.clear() }
  async dispose(): Promise<void> { await this.reset(); this.roots.clear(); this.removedRootIds.clear(); this.existingRootIds.clear() }

  private async hasEntry(directory: string): Promise<boolean> {
    try {
      const handle = await opendir(directory)
      for await (const entry of handle) if (entry.name.toLowerCase() === 'skill.md' && entry.isFile()) return true
      return false
    } catch { return false }
  }

  private async inspect(root: SkillImportRoot, rootPath: string, directory: string, signal?: AbortSignal): Promise<CandidateInternal> {
    abort(signal)
    let entryName: string | undefined
    const entries = await opendir(directory)
    for await (const entry of entries) if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') { entryName = entry.name; break }
    if (!entryName) throw new Error('ENTRY_MISSING')
    const entry = { relativePath: entryName, absolutePath: join(directory, entryName), ...await this.fileIdentity(join(directory, entryName)) }
    const entryBytes = await this.readChecked(entry, rootPath, signal)
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(entryBytes) }
    catch { throw new SkillImportFileError('ENTRY_INVALID') }
    let details: { name: string; description: string | null }
    const warnings: FileWarning[] = []
    try { details = parseSkill(content) }
    catch {
      details = { name: basename(directory).trim() || 'skill', description: null }
      warnings.push({ code: 'METADATA_NORMALIZED', message: '元数据缺失或格式不规范，请在网页确认技能信息。', severity: 'warning' })
    }
    const files = [entry]
    const id = randomUUID().replaceAll('-', '')
    return { candidateId: id, revision: 1, name: details.name, description: details.description, sources: candidateSources(root, directory), scope: root.scope, locations: [{ rootId: root.id, rootLabel: root.label, relativePath: publicPath(rootPath, directory) }], treeHash: null, availability: 'previewable', warnings, directory, rootPath, files, rootIds: [root.id] }
  }

  private async enumerate(directory: string, root: string, signal?: AbortSignal): Promise<{ files: FileEntry[]; directories: string[]; warnings: FileWarning[] }> {
    const files: FileEntry[] = []
    const directories: string[] = []
    const warnings: FileWarning[] = []
    await this.walk(directory, '', root, files, directories, warnings, signal, new Set())
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    directories.sort()
    return { files, directories, warnings }
  }

  private async fileIdentity(path: string): Promise<Omit<FileEntry, 'relativePath' | 'absolutePath'>> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new SkillImportFileError('UNSUPPORTED_FILE_TYPE')
    return { bytes: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, mode: info.mode }
  }

  private async walk(current: string, prefix: string, root: string, output: FileEntry[], directories: string[], warnings: FileWarning[], signal?: AbortSignal, visited = new Set<string>()): Promise<void> {
    abort(signal)
    const currentReal = await realpath(current)
    if (!within(root, currentReal)) throw new SkillImportFileError('PATH_OUTSIDE_ROOT')
    if (visited.has(currentReal)) throw new SkillImportFileError('SYMLINK_CYCLE')
    visited.add(currentReal)
    const directory = await opendir(current)
    for await (const entry of directory) {
      abort(signal)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isSecret(relativePath)) throw new SkillImportFileError('SECRET_FILE_BLOCKED')
      if (ignoredDirs.has(entry.name.toLowerCase())) {
        if (warnings.length < 32) warnings.push({ code: 'RESOURCE_DIRECTORY_EXCLUDED', message: `未打包目录：${relativePath}。请核对技能是否依赖其中的资源。`.slice(0, 512), severity: 'warning' })
        continue
      }
      const path = join(current, entry.name)
      const info = await lstat(path)
      let real: string
      try { real = info.isSymbolicLink() ? await realpath(path) : path } catch { throw new SkillImportFileError('SYMLINK_UNRESOLVED') }
      if (!within(root, real) || !safePath(relativePath)) throw new SkillImportFileError('PATH_OUTSIDE_ROOT')
      if (isSecret(relative(root, real).split(sep).join('/'))) throw new SkillImportFileError('SECRET_FILE_BLOCKED')
      const targetInfo = info.isSymbolicLink() ? await stat(real) : info
      if (targetInfo.isDirectory()) {
        directories.push(relativePath)
        await this.walk(real, relativePath, root, output, directories, warnings, signal, visited)
        continue
      }
      if (!targetInfo.isFile()) throw new SkillImportFileError('UNSUPPORTED_FILE_TYPE')
      output.push({ relativePath, absolutePath: real, bytes: targetInfo.size, dev: targetInfo.dev, ino: targetInfo.ino, mtimeMs: targetInfo.mtimeMs, mode: targetInfo.mode })
    }
    visited.delete(currentReal)
  }

  private async readChecked(file: FileEntry, root: string, signal?: AbortSignal): Promise<Buffer> {
    abort(signal)
    const real = await realpath(file.absolutePath)
    if (!within(root, real)) throw new SkillImportFileError('PATH_OUTSIDE_ROOT')
    const before = await lstat(file.absolutePath)
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== file.dev || before.ino !== file.ino || before.size !== file.bytes || before.mtimeMs !== file.mtimeMs) throw new SkillImportFileError('CANDIDATE_CHANGED')
    const handle = await open(file.absolutePath, 'r')
    try {
      const opened = await handle.stat()
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new SkillImportFileError('CANDIDATE_CHANGED')
      const data = await handle.readFile({ signal })
      const after = await handle.stat()
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new SkillImportFileError('CANDIDATE_CHANGED')
      return data
    } finally { await handle.close() }
  }

  private async *readChunks(file: FileEntry, root: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    abort(signal)
    const real = await realpath(file.absolutePath)
    if (!within(root, real)) throw new SkillImportFileError('PATH_OUTSIDE_ROOT')
    const before = await lstat(file.absolutePath)
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== file.dev || before.ino !== file.ino || before.size !== file.bytes || before.mtimeMs !== file.mtimeMs) throw new SkillImportFileError('CANDIDATE_CHANGED')
    const handle = await open(file.absolutePath, 'r')
    try {
      const opened = await handle.stat()
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new SkillImportFileError('CANDIDATE_CHANGED')
      // Keep cancellation and handle cleanup in this generator, without a second stream lifecycle.
      for (;;) {
        abort(signal)
        const chunk = Buffer.allocUnsafe(64 * 1024)
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        abort(signal)
        if (bytesRead === 0) break
        yield chunk.subarray(0, bytesRead)
      }
      const finalPath = await realpath(file.absolutePath)
      const after = await handle.stat()
      if (!within(root, finalPath) || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new SkillImportFileError('CANDIDATE_CHANGED')
    } finally { await handle.close() }
  }
}

function isSecret(path: string): boolean {
  const normalized = path.toLowerCase().split('/')
  const name = normalized.at(-1) ?? ''
  if (name === '.env' || name.startsWith('.env.') && name !== '.env.example' || name === 'id_rsa' || name === 'id_ed25519' || name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12') || name.endsWith('.pfx')) return true
  return normalized.some(part => part === '.ssh' || part === '.aws' || part === '.azure')
}
