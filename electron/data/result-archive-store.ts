import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { access, link, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, win32 } from 'node:path'
import { z } from 'zod'
import { diagnoseJsonWithBackup, readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { WriteChain } from './write-chain'
import { resolveUnlinkedChild, resolveUnlinkedDirectory } from './workspace-result-path'
import { ResultFilePathError } from '../errors/result-file-path-error'
import { resultFileRequestSchema, type ResultFileRequest } from '../../src/shared/result-files'

export type GeneratedMediaRequest = Extract<ResultFileRequest, { assetId: string } | { jobId: string }>
export interface GeneratedMediaOutput {
  prepare(scope: TaskOwnerScope, file: GeneratedMediaRequest, name: string, when: number, startedAt: number,
    runId?: string, subscriptionId?: string): Promise<((write: (part: string) => Promise<void>, signal: AbortSignal) => Promise<void>) | undefined>
  path(scope: TaskOwnerScope, file: GeneratedMediaRequest, subscriptionId?: string): Promise<string>
}

const mediaKey = (file: GeneratedMediaRequest) => 'assetId' in file ? `image:${file.assetId}` : JSON.stringify(['video', file.jobId, file.outputId])

const absolute = z.string().refine(isAbsolute)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const illegal = /[<>:"/\\|?*\p{Cc}]/u
const segment = z.string().min(1).refine(value => !illegal.test(value) && !/[. ]$/.test(value))
const settingsSchema = z.array(z.object({ root: absolute, system: z.boolean(), since: z.number().nonnegative() }).strict())
const failureSchema = z.enum(['space', 'unwritable', 'location', 'unsupported', 'source', 'reconnect'])
export type ResultArchiveFailureReason = z.infer<typeof failureSchema>
const entrySchema = z.object({ root: absolute, day, folder: segment, target: segment.nullable(), version: z.string(), name: segment,
  folderLabel: segment.optional(), folderIdentity: z.string().optional(),
  request: resultFileRequestSchema.optional(), subscriptionId: z.string().min(1).optional(),
  when: z.number().nonnegative().optional(),
  state: z.enum(['pending', 'failed', 'saved']).optional(),
  failure: failureSchema.optional(),
  targetIdentity: z.string().optional(),
  direct: z.literal(true).optional(),
  stage: z.object({ part: z.string().regex(/^\.csep-save-[a-f0-9-]{36}\.part$/), candidate: segment.nullable(),
    identity: z.string().optional() }).strict().optional(),
}).strict()
const ledgerSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), entrySchema)
export type ResultArchiveEntry = z.infer<typeof entrySchema>

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const deviceName = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\.|$)/i
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException | null)?.code === code

export class ResultArchiveFailure extends Error {
  constructor(readonly reason: ResultArchiveFailureReason, cause?: unknown) {
    super(reason, { cause })
  }
}

export class ResultArchiveConfirmationChanged extends Error {}

export function alternateArchiveConfirmation(entry: ResultArchiveEntry, root: string): string | undefined {
  const stage = entry.stage
  if (!stage?.candidate || !stage.identity || !relative(entry.root, root)) return undefined
  return digest(JSON.stringify([entry.version, entry.root, stage.part, stage.candidate, stage.identity, root]))
}

// Only classify destination I/O here, never reads from the original or writes to the ledger.
async function destinationIO<T>(operation: Promise<T>, checkingDirectory = false): Promise<T> {
  try { return await operation }
  catch (error) {
    if (errno(error, 'ENOSPC') || errno(error, 'EDQUOT')) throw new ResultArchiveFailure('space', error)
    if (['EACCES', 'EPERM', 'EROFS'].some(code => errno(error, code))) throw new ResultArchiveFailure('unwritable', error)
    if (checkingDirectory && (errno(error, 'ENOENT') || errno(error, 'ENOTDIR') || error instanceof ResultFilePathError)) {
      throw new ResultArchiveFailure('location', error)
    }
    throw error
  }
}

function safeName(value: string, fallback: string, limit: number): string {
  const cleaned = value.normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').trim().replace(/[. ]+$/, '')
  let name = deviceName.test(cleaned) ? '_' : '', length = name.length
  for (const letter of cleaned) {
    length += Buffer.byteLength(letter)
    if (length > limit) break
    name += letter
  }
  return name.replace(/[. ]+$/, '') || fallback
}

export function archiveFileName(raw: string): string {
  const extension = extname(raw)
  const suffix = /^\.[a-z0-9]{1,16}$/i.test(extension) ? extension : ''
  return safeName(suffix ? raw.slice(0, -suffix.length) : raw, '成果', 110) + suffix
}

function archiveFolderLabel(title: string, filename: string): string {
  const topic = title.trim().replace(/(?:…+|\.{2,})$/, '').trimEnd()
  if (topic && Array.from(topic).length <= 24 && !/[\\/\p{Cc}]|(?:^|[\s"'“‘])[a-z]:/iu.test(topic) &&
    /[\p{L}\p{N}]/u.test(topic) && !/^(?:(?:请|帮我)\s*)?(?:参考|查看|读取|打开|使用|根据)\s*(?:(?:一下|这个|该|此)\s*)?(?:文件夹|目录|附件|文件)(?:$|[\s，,。；;：:]|里的|中的|里面)/u.test(topic)) {
    return safeName(topic, '任务', 60)
  }
  const basename = win32.basename(filename)
  const stem = basename.slice(0, basename.length - extname(basename).length)
    .replace(/[_\s\-—]+(?:剪辑方案|报告|方案|脚本|大纲|清单|初稿|终稿)$/u, '').trim()
  const generic = /^(?:(?:成果|生成文件|报告|方案|图片|视频|文件|文档|image|video|output|result|file|document)[_\s-]*\d*|[\d_. -]+|[a-f\d]{16,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu
  return /\p{L}/u.test(stem) && !generic.test(stem) ? safeName(stem, '任务', 60) : '任务'
}

export function localArchiveDay(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function archiveSourceStamp(info: Stats): string {
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
}

async function copyExclusive(source: string, stamp: string | undefined, target: string, assert: () => void): Promise<void> {
  const from = await open(source, 'r')
  let to: FileHandle | undefined, created: Stats | undefined
  try {
    const before = await from.stat(), verified = archiveSourceStamp(before)
    if (!before.isFile() || (stamp && verified !== stamp)) throw new ResultArchiveFailure('source')
    assert()
    to = await destinationIO(open(target, 'wx', 0o600), true)
    created = await to.stat()
    const buffer = Buffer.allocUnsafe(512 * 1024)
    for (let offset = 0; offset < before.size;) {
      assert()
      const { bytesRead } = await from.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
      if (!bytesRead) throw new ResultArchiveFailure('source')
      for (let position = 0; position < bytesRead;) {
        const { bytesWritten } = await destinationIO(to.write(buffer, position, bytesRead - position, offset + position))
        if (!bytesWritten) throw new Error('Incomplete archive write')
        position += bytesWritten
      }
      offset += bytesRead
    }
    if (archiveSourceStamp(await from.stat()) !== verified) throw new ResultArchiveFailure('source')
    assert()
    await destinationIO(to.sync())
    await destinationIO(to.close())
  } catch (error) {
    await to?.close().catch(() => undefined)
    if (created) {
      const current = await lstat(target).catch(() => null)
      if (current?.dev === created.dev && current.ino === created.ino) await unlink(target).catch(() => undefined)
    }
    throw error
  } finally { await from.close() }
}

async function fileIdentity(path: string): Promise<string | null> {
  try {
    const info = await lstat(path, { bigint: true })
    return info.isFile() && !info.isSymbolicLink() && info.ino !== 0n
      ? JSON.stringify([info.dev.toString(), info.ino.toString(), info.size.toString(), info.mtimeNs.toString()]) : null
  } catch (error) { if (errno(error, 'ENOENT')) return null; throw error }
}

async function folderIdentity(path: string): Promise<string | null> {
  try {
    const info = await lstat(path, { bigint: true })
    return info.isDirectory() && !info.isSymbolicLink() && info.ino !== 0n
      ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : null
  } catch (error) { if (errno(error, 'ENOENT')) return null; throw error }
}

function savedTargetIdentity(entry: ResultArchiveEntry): string | undefined {
  return entry.targetIdentity ?? (entry.stage?.candidate === entry.target ? entry.stage?.identity : undefined)
}

export class ResultArchiveStore {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()
  private readonly copies = new WriteChain()
  constructor(profile: string) { this.paths = new ScopePath(profile) }

  private settingsPath(scope: TaskOwnerScope) { return join(this.paths.ownerRoot(scope), 'result-archive.json') }
  private ledgerPath(scope: TaskOwnerScope, taskId: string) { return join(this.paths.taskDir(scope, taskId), 'result-archive.json') }

  async settings(scope: TaskOwnerScope) {
    return await readJsonWithBackup(this.settingsPath(scope), value => parse(settingsSchema, value)) ?? []
  }

  async settingAt(scope: TaskOwnerScope, startedAt: number) {
    const result = await diagnoseJsonWithBackup(this.settingsPath(scope), value => parse(settingsSchema, value))
    if (result.state === 'unavailable') throw new Error('Result save settings unavailable')
    if (result.state !== 'found') return undefined
    for (let i = result.value.length - 1; i >= 0; i--) {
      const setting = result.value[i]!
      if (setting.since <= startedAt) return setting
    }
    return undefined
  }

  async configure(scope: TaskOwnerScope, path: string, system: boolean, assert: () => void): Promise<void> {
    if (!isAbsolute(path)) throw new Error('Invalid archive root')
    assert()
    if (system) await mkdir(path, { recursive: true })
    const root = await realpath(path)
    await this.checkDirectory(root)
    const file = this.settingsPath(scope)
    await this.writes.run(file, async () => {
      const history = await this.settings(scope)
      assert()
      await writeJsonAtomic(file, [...history, { root, system, since: Date.now() }])
    })
  }

  async available(path: string): Promise<boolean> {
    try { await this.checkDirectory(path, false); return true } catch { return false }
  }

  async prepareDefaultWorkspace(scope: TaskOwnerScope, taskId: string | undefined, assert: () => void): Promise<string | undefined> {
    const setting = await this.settingAt(scope, Date.now())
    assert()
    if (!setting) return
    const root = await this.checkDirectory(setting.root)
    const workspaces = await this.ensureDirectory(root, '任务工作区', assert)
    return taskId ? this.ensureDirectory(workspaces, taskId, assert) : workspaces
  }

  private async checkDirectory(path: string, writable = true): Promise<string> {
    const directory = await resolveUnlinkedDirectory(path)
    if (writable) await access(directory, constants.W_OK)
    return directory
  }

  private async ensureDirectory(parent: string, name: string, assert: () => void): Promise<string> {
    assert()
    await destinationIO(mkdir(join(parent, name)).catch(error => { if (!errno(error, 'EEXIST')) throw error }), true)
    return (await destinationIO(resolveUnlinkedChild(parent, name, 'directory'), true)).path
  }

  private async selectFolder(parent: string, label: string, peers: ResultArchiveEntry[], assert: () => void): Promise<{
    folder: string; folderLabel?: string; folderIdentity?: string; directory: string
  }> {
    const legacy = peers.find(peer => peer.folderLabel === undefined)
    if (legacy) return { folder: legacy.folder, folderLabel: undefined, folderIdentity: undefined,
      directory: await this.ensureDirectory(parent, legacy.folder, assert) }

    const checked = new Set<string>()
    for (const peer of peers) {
      if (!peer.folderIdentity || checked.has(peer.folderIdentity)) continue
      checked.add(peer.folderIdentity)
      const directory = join(parent, peer.folder)
      if (await destinationIO(folderIdentity(directory), true) === peer.folderIdentity) {
        return { folder: peer.folder, folderLabel: peer.folderLabel, folderIdentity: peer.folderIdentity,
          directory: (await destinationIO(resolveUnlinkedChild(parent, peer.folder, 'directory'), true)).path }
      }
    }

    // An unclaimed name must be created exclusively, even when two tasks use the same save root.
    for (let i = 1; i <= 1000; i++) {
      const folder = i === 1 ? label : `${label}（${i}）`
      assert()
      const created = await destinationIO(mkdir(join(parent, folder)).then(() => true, error => {
        if (errno(error, 'EEXIST')) return false
        throw error
      }), true)
      if (!created) continue
      const { path } = await destinationIO(resolveUnlinkedChild(parent, folder, 'directory'), true)
      const identity = await destinationIO(folderIdentity(path), true)
      if (!identity) throw new ResultArchiveFailure('unsupported')
      return { folder, folderLabel: label, folderIdentity: identity, directory: path }
    }
    throw new Error('Archive folder collision limit')
  }

  private async readLedger(file: string) { return await readJsonWithBackup(file, value => parse(ledgerSchema, value)) ?? {} }

  async entry(scope: TaskOwnerScope, taskId: string, identity: string): Promise<ResultArchiveEntry | undefined> {
    return (await this.readLedger(this.ledgerPath(scope, taskId)))[digest(identity)]
  }

  async recoverable(scope: TaskOwnerScope, taskId: string): Promise<ResultArchiveEntry[]> {
    return Object.values(await this.readLedger(this.ledgerPath(scope, taskId))).filter(entry => !entry.direct && entry.request && (!entry.target || entry.stage))
  }

  async prepareGeneratedMedia(scope: TaskOwnerScope, file: GeneratedMediaRequest, input: {
    title: string; name: string; when: number; startedAt: number; subscriptionId?: string
  }, assert: () => void): ReturnType<GeneratedMediaOutput['prepare']> {
    const key = mediaKey(file)
    let entry = await this.entry(scope, file.taskId, key)
    if (!entry) {
      const setting = await this.settingAt(scope, input.startedAt)
      assert()
      if (!setting) return
      await this.enqueue(scope, file.taskId, key, { ...input, root: setting.root, request: file, version: key, direct: true }, assert)
      entry = await this.entry(scope, file.taskId, key)
      if (!entry) throw new ResultArchiveFailure('location')
    }
    assert()
    if (!entry.direct) return
    if (entry.subscriptionId !== input.subscriptionId) throw new ResultArchiveFailure('source')
    const recorded = entry
    return async (write, signal) => {
      const check = () => { assert(); signal.throwIfAborted() }
      // A changed preference can redirect an incomplete download, but never a
      // publication whose final file cannot yet be confirmed on a disconnected disk.
      const current = recorded.state === 'failed' && !recorded.target && !recorded.stage?.candidate
        ? await this.settingAt(scope, Date.now()) : undefined
      try { await this.copy(scope, file.taskId, key, { entry: recorded, write, retryRoot: current?.root }, check) }
      catch (error) {
        await this.fail(scope, file.taskId, key, recorded.version, check, error instanceof ResultArchiveFailure ? error.reason : undefined).catch(() => undefined)
        throw error
      }
    }
  }

  async generatedMediaPath(scope: TaskOwnerScope, file: GeneratedMediaRequest, subscriptionId: string | undefined, assert: () => void): Promise<string> {
    const key = mediaKey(file)
    let entry = await this.entry(scope, file.taskId, key)
    if (entry?.direct && entry.subscriptionId === subscriptionId) {
      if (entry.stage?.candidate && (await this.destination(entry) || await this.interruptedTarget(entry).catch(() => null))) {
        await this.copy(scope, file.taskId, key, { entry }, assert)
        entry = await this.entry(scope, file.taskId, key)
      }
      const path = entry && await this.destination(entry)
      assert()
      if (path) return path
    }
    assert()
    throw Object.assign(new Error('Generated media file unavailable.'), { code: 'ENOENT' })
  }

  async enqueue(scope: TaskOwnerScope, taskId: string, identity: string, input: {
    root: string; when: number; title: string; request: ResultFileRequest; subscriptionId?: string; name: string; version: string; direct?: true
  }, assert: () => void, recovery?: { previousVersion: string | undefined }): Promise<void> {
    const file = this.ledgerPath(scope, taskId), key = digest(identity)
    await this.copies.run(`${file}:${key}`, () => this.writes.run(file, async () => {
      const entries = await this.readLedger(file), previous = entries[key]
      if (previous?.direct || (previous?.version === input.version && (previous.request || previous.target))) return
      if (recovery && (previous?.version !== recovery.previousVersion || previous?.stage)) return
      const date = localArchiveDay(input.when)
      const existing = Object.values(entries).find(item => item.day === date && !relative(item.root, input.root) &&
        (item.folderLabel === undefined || item.folderIdentity))
      const folderLabel = existing ? existing.folderLabel : archiveFolderLabel(input.title, input.name)
      const folder = existing?.folder ?? folderLabel ?? '任务'
      assert()
      await writeJsonAtomic(file, { ...entries, [key]: { root: input.root, day: date, folder, name: archiveFileName(input.name),
        folderLabel, folderIdentity: existing?.folderIdentity, direct: input.direct,
        target: null, version: input.version, when: input.when, request: input.request, subscriptionId: input.subscriptionId, state: 'pending' } }, { durable: true })
    }))
  }

  async fail(scope: TaskOwnerScope, taskId: string, identity: string, version: string, assert: () => void,
    failure?: ResultArchiveFailureReason): Promise<void> {
    const file = this.ledgerPath(scope, taskId), key = digest(identity)
    await this.writes.run(file, async () => {
      const entries = await this.readLedger(file), entry = entries[key]
      if (!entry || entry.target || entry.version !== version || (entry.state === 'failed' && entry.failure === failure)) return
      assert()
      await writeJsonAtomic(file, { ...entries, [key]: { ...entry, state: 'failed', failure } }, { durable: true })
    })
  }

  /** A missing candidate is conclusive only while the original root is still accessible. */
  async interruptedTarget(entry: ResultArchiveEntry): Promise<string | null> {
    const stage = entry.stage
    if (!stage?.candidate || !stage.identity) return null
    try {
      const root = await this.checkDirectory(entry.root, false)
      const directory = await this.checkDirectory(join(root, entry.day, entry.folder), false).catch(error => {
        if (errno(error, 'ENOENT')) return null
        throw error
      })
      const found = directory && await fileIdentity(join(directory, stage.candidate))
      if (entry.direct && directory && await folderIdentity(directory) !== entry.folderIdentity) return null
      if (!found) await this.checkDirectory(root, false)
      return found === stage.identity ? stage.candidate : null
    } catch (cause) {
      throw new ResultArchiveFailure('reconnect', cause)
    }
  }

  async copy(scope: TaskOwnerScope, taskId: string, identity: string, input: {
    entry: ResultArchiveEntry; source?: { path: string; sourceStamp?: string }; retryRoot?: string; confirmation?: string
    write?: (part: string) => Promise<void>
  }, assert: () => void): Promise<void> {
    const file = this.ledgerPath(scope, taskId), key = digest(identity)
    await this.copies.run(`${file}:${key}`, async () => {
      assert()
      const recorded = (await this.readLedger(file))[key]
      if (input.confirmation && (!recorded || !input.retryRoot || alternateArchiveConfirmation(recorded, input.retryRoot) !== input.confirmation)) {
        throw new ResultArchiveConfirmationChanged()
      }
      if (!recorded || recorded.version !== input.entry.version) return
      let entry = recorded
      const save = async (next: ResultArchiveEntry) => {
        await this.writes.run(file, async () => {
          const entries = await this.readLedger(file)
          assert()
          await writeJsonAtomic(file, { ...entries, [key]: next }, { durable: true })
        })
        entry = next
      }
      const oldDir = join(entry.root, entry.day, entry.folder)
      const stage = entry.stage
      const existingPart = stage && join(oldDir, stage.part)
      const cleanup = async () => {
        if (!existingPart) return
        const directory = await this.checkDirectory(oldDir, false)
        if (entry.folderIdentity && await folderIdentity(directory) !== entry.folderIdentity) return
        if (stage?.identity && await fileIdentity(existingPart) !== stage.identity) return
        await unlink(existingPart).catch(error => { if (!errno(error, 'ENOENT')) throw error })
      }
      if (entry.target && await this.destination(entry)) {
        if (stage) {
          await cleanup()
          await save({ ...entry, targetIdentity: savedTargetIdentity(entry), stage: undefined })
        }
        return
      }
      let leaveOldStage = false
      const interruptedTarget = await this.interruptedTarget(entry).catch(error => {
        if (!input.confirmation || !(error instanceof ResultArchiveFailure) || error.reason !== 'reconnect') throw error
        leaveOldStage = true
        return null
      })
      if (interruptedTarget) {
        await save({ ...entry, state: 'saved', target: interruptedTarget, targetIdentity: stage?.identity, failure: undefined })
        await cleanup()
        await save({ ...entry, stage: undefined })
        return
      }
      if (!input.source && !input.write) throw new ResultArchiveFailure('source')
      if (entry.target && !input.retryRoot && !input.write) return
      if (entry.direct !== true && input.write) throw new ResultArchiveFailure('source')
      const root = input.retryRoot ?? entry.root
      // Keep the original evidence until a confirmed replacement directory is usable.
      const alternateRoot = leaveOldStage ? await destinationIO(this.checkDirectory(root), true) : undefined
      if (stage && !leaveOldStage) await cleanup().catch(error => { if (stage.candidate && !errno(error, 'ENOENT')) throw error })
      const part = `.csep-save-${randomUUID()}.part`
      const directory = await this.writes.run(file, async () => {
        const entries = await this.readLedger(file)
        const peers = Object.values(entries).filter(peer => peer.day === entry.day && !relative(peer.root, root) && (!entry.direct || peer.folderIdentity))
        const parent = await this.ensureDirectory(alternateRoot ?? await destinationIO(this.checkDirectory(root), true), entry.day, assert)
        const { directory, ...folder } = await this.selectFolder(parent, entry.folderLabel ?? archiveFolderLabel('', entry.name), peers, assert)
        await destinationIO(access(directory, constants.W_OK), true)
        const next: ResultArchiveEntry = { ...entry, ...folder, root, state: 'pending', target: null, targetIdentity: undefined,
          failure: undefined, stage: { part, candidate: null } }
        assert()
        await writeJsonAtomic(file, { ...entries, [key]: next }, { durable: true })
        entry = next
        return directory
      })
      const checkFolder = async () => {
        await destinationIO(this.checkDirectory(directory), true)
        if (entry.folderIdentity && await destinationIO(folderIdentity(directory), true) !== entry.folderIdentity) throw new ResultArchiveFailure('location')
      }
      await checkFolder()
      const partPath = join(directory, part)
      if (input.write) {
        try { await destinationIO(input.write(partPath)) }
        catch (error) {
          await checkFolder().then(() => unlink(partPath)).catch(() => undefined)
          throw error
        }
      }
      else await copyExclusive(input.source!.path, input.source!.sourceStamp, partPath, assert)
      const stagedIdentity = await fileIdentity(partPath)
      if (!stagedIdentity) throw new ResultArchiveFailure('unsupported')
      const name = entry.name, ext = extname(name), stem = ext ? name.slice(0, -ext.length) : name
      for (let i = 1; i <= 1000; i++) {
        const target = i === 1 ? name : `${stem} (${i})${ext}`
        const targetPath = join(directory, target)
        if (await lstat(targetPath).then(() => true, error => { if (errno(error, 'ENOENT')) return false; throw error })) continue
        await checkFolder()
        await save({ ...entry, stage: { part, candidate: target, identity: stagedIdentity } })
        assert()
        try { await destinationIO(link(partPath, targetPath)) }
        catch (error) {
          if (errno(error, 'EEXIST')) continue
          if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].some(code => errno(error, code))) {
            await save({ ...entry, stage: { part, candidate: null, identity: stagedIdentity } })
            throw new ResultArchiveFailure('unsupported', error)
          }
          throw error
        }
        await save({ ...entry, target, targetIdentity: stagedIdentity, state: 'saved' })
        await checkFolder()
        if (await fileIdentity(partPath) === stagedIdentity) await unlink(partPath)
        await save({ ...entry, stage: undefined })
        return
      }
      throw new Error('Archive filename collision limit')
    })
  }

  async destination(entry: ResultArchiveEntry): Promise<string | null> {
    if (!entry.target) return null
    try {
      const directory = await this.checkDirectory(join(entry.root, entry.day, entry.folder), false)
      if (entry.direct && (!entry.folderIdentity || await folderIdentity(directory) !== entry.folderIdentity)) return null
      const { path } = await resolveUnlinkedChild(directory, entry.target, 'file')
      const identity = savedTargetIdentity(entry)
      return identity !== undefined && await fileIdentity(path) !== identity ? null : path
    } catch { return null }
  }
}
