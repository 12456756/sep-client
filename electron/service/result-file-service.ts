import { randomBytes } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import { canOpenResultFile, resultFileRequestSchema, resultFileReleaseSchema, type ResultFileRequest, type ResultFilePreview, type ResultArchiveStatus, type ResultSaveIntent } from '../../src/shared/result-files'
import { createResultOpenCopy, saveResultCopy, type CommittedResultSave, type OpenResultFile, type ResultActionFile, type ResultFileStorePort } from '../data/result-file-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { requireScope, type ScopeSource } from './scope-guard'
import { AppError } from '../errors/app-error'
import { alternateArchiveConfirmation, archiveFileName, ResultArchiveConfirmationChanged, ResultArchiveFailure, type ResultArchiveEntry, type ResultArchiveFailureReason } from '../data/result-archive-store'
import type { ResultArchiveService } from './result-archive-service'
import { logger } from '../common/logger'

interface Options { scope: ScopeSource; store: ResultFileStorePort; reveal(path: string): void | Promise<void>; archive?: ResultArchiveService }
interface Lease { scope: TaskOwnerScope; input: ResultFileRequest; file: OpenResultFile; abort: AbortController }
const archiveFailure = '原文件已生成，副本未保存。请重试。'
const archiveFailureDetails: Record<ResultArchiveFailureReason, string> = {
  space: '保存位置空间不足，请释放空间或换个文件夹后重试。',
  unwritable: '无法写入保存位置，请检查文件夹权限或换个文件夹后重试。',
  location: '找不到保存文件夹或该位置已不可用，请恢复连接或换个文件夹后重试。',
  unsupported: '此保存位置不支持安全写入，请换个文件夹后重试。',
  source: '无法核对原文件，请确认原文件仍在且未被修改后重试。',
  reconnect: '无法确认原保存位置是否已有副本。请重新连接原保存位置后重试。',
}
const archiveFailureMessage = (reason?: ResultArchiveFailureReason) => reason ? `原文件已生成。${archiveFailureDetails[reason]}` : archiveFailure
const confirmationChanged = '保存位置或文件状态已变化，请重新确认后再试。'

function archiveIdentity(file: ResultFileRequest): string {
  if ('assetId' in file) return `image:${file.assetId}`
  if ('jobId' in file) return JSON.stringify(['video', file.jobId, file.outputId])
  if ('fileId' in file) return `file:${file.fileId}`
  if ('nodeId' in file) return JSON.stringify(['delivery', file.nodeId, file.deliverableId])
  return ''
}

export class ResultFileService {
  private readonly leases = new Map<string, Lease>()
  private readonly openCopies = new Set<() => Promise<void>>()
  private epoch = 0
  private readonly saving = new Map<string, Promise<void>>()
  // When the ledger itself cannot be written, keep the failure visible for this session.
  private readonly unrecordedFailures = new Map<string, { version: string; reason?: ResultArchiveFailureReason }>()
  constructor(private readonly options: Options) {}

  clear(): void {
    this.epoch++
    this.unrecordedFailures.clear()
    for (const [url] of this.leases) this.dispose(url)
    for (const dispose of this.openCopies) void dispose()
    this.openCopies.clear()
  }

  private dispose(url: string): void {
    const lease = this.leases.get(url)
    if (!lease) return
    this.leases.delete(url); lease.abort.abort()
    void lease.file.close().catch(() => undefined)
  }

  private assert(scope: TaskOwnerScope, epoch = this.epoch): void {
    const current = requireScope(this.options.scope)
    if (epoch !== this.epoch || current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
  }

  async preview(raw: ResultFileRequest): Promise<ResultFilePreview> {
    const input = resultFileRequestSchema.parse(raw), scope = requireScope(this.options.scope), epoch = this.epoch
    const file = await this.options.store.open(scope, input)
    try {
      this.assert(scope, epoch)
      if (this.leases.size >= 64) this.dispose(this.leases.keys().next().value!)
      const url = `sep-result://preview/${randomBytes(32).toString('hex')}`
      this.leases.set(url, { scope, input, file, abort: new AbortController() })
      return { url, mime: file.mime, kind: file.kind }
    } catch (error) { await file.close(); throw error }
  }

  async release(raw: { url: string }): Promise<void> {
    const { url } = resultFileReleaseSchema.parse(raw)
    const lease = this.leases.get(url)
    if (lease) { this.assert(lease.scope); this.dispose(url) }
  }

  async reveal(raw: ResultFileRequest): Promise<boolean> {
    return this.withPreferredPath(raw, this.options.reveal)
  }

  async copyPath(raw: ResultFileRequest, write: (path: string) => void): Promise<void> {
    await this.withPreferredPath(raw, write)
  }

  private async withPreferredPath(raw: ResultFileRequest, use: Options['reveal']): Promise<boolean> {
    const input = resultFileRequestSchema.parse(raw), scope = requireScope(this.options.scope), epoch = this.epoch
    const archive = this.options.archive, identity = archiveIdentity(input)
    const assertOwner = archive && identity ? archive.assertOwner(scope) : undefined
    const entry = archive && identity ? await archive.store.entry(scope, input.taskId, identity) : undefined
    const saved = archive && entry ? await archive.store.destination(entry) : null
    assertOwner?.()
    this.assert(scope, epoch)
    const path = saved ?? (entry?.subscriptionId && 'jobId' in input
      ? (await this.options.store.actionFile(scope, input, entry.subscriptionId)).path
      : await this.options.store.revealPath(scope, input))
    assertOwner?.()
    this.assert(scope, epoch)
    await use(path)
    return !saved && !!entry && entry.state !== 'pending'
  }

  async queueArchive(scope: TaskOwnerScope, file: ResultFileRequest, title: string, when: number, startedAt: number,
    describe: () => Promise<{ name: string; version: string } | null>, videoSubscriptionId?: string): Promise<ResultSaveIntent | undefined> {
    const archive = this.options.archive, identity = archiveIdentity(file)
    if (!archive || !identity) return
    let intent: ResultSaveIntent | undefined
    try {
      const assert = archive.assertOwner(scope)
      const expected = await describe()
      if (!expected) return
      assert()
      intent = { ...expected, startedAt, when, title }
      const configured = await archive.store.settingAt(scope, startedAt)
      if (!configured) return
      await this.registerArchive(scope, { file, intent, subscriptionId: videoSubscriptionId }, configured.root, assert)
    } catch {
      logger.child('result-archive').warn('generated file archive unavailable', { taskId: file.taskId })
    }
    return intent
  }

  private async registerArchive(scope: TaskOwnerScope, candidate: CommittedResultSave, root: string, assert: () => void,
    recovery?: { previousVersion: string | undefined }) {
    const { file, intent, subscriptionId } = candidate
    await this.options.archive!.store.enqueue(scope, file.taskId, archiveIdentity(file), {
      ...intent, root, request: resultFileRequestSchema.parse(file), subscriptionId,
    }, assert, recovery)
  }

  private async unregisteredArchive(scope: TaskOwnerScope, file: ResultFileRequest, entry?: ResultArchiveEntry, committed?: CommittedResultSave) {
    if (entry?.request && ('assetId' in file || 'jobId' in file)) return undefined
    const candidate = committed ?? (await this.options.store.saveIntents?.(scope, file.taskId, file))?.[0]
    if (!candidate || (entry?.version === candidate.intent.version && (entry.request || entry.target)) ||
      (entry?.when !== undefined && entry.when > candidate.intent.when)) return undefined
    return candidate
  }

  private saveKey(scope: TaskOwnerScope, file: ResultFileRequest) {
    return JSON.stringify([this.epoch, scope.enterpriseId, scope.memberId, file.taskId, archiveIdentity(file)])
  }

  // The producer registers before publishing the original and calls this after its commit.
  saveQueuedArchive(scope: TaskOwnerScope, file: ResultFileRequest, signal?: AbortSignal, committed?: CommittedResultSave): Promise<void> {
    const epoch = this.epoch
    const key = this.saveKey(scope, file)
    const next = (this.saving.get(key) ?? Promise.resolve()).then(async () => {
      signal?.throwIfAborted()
      const archive = this.options.archive
      if (!archive) return
      const owner = archive.assertOwner(scope)
      const assert = () => { owner(); this.assert(scope, epoch); signal?.throwIfAborted() }
      assert()
      let entry = await archive.store.entry(scope, file.taskId, archiveIdentity(file))
      // Reconcile existing copies first; legacy records are still the authority for interrupted copies.
      if (!entry?.stage) {
        const candidate = await this.unregisteredArchive(scope, file, entry, committed)
        if (candidate) {
          const setting = await archive.store.settingAt(scope, candidate.intent.startedAt)
          if (!setting) return
          await this.registerArchive(scope, candidate, setting.root, assert, { previousVersion: entry?.version })
          entry = await archive.store.entry(scope, file.taskId, archiveIdentity(file))
        }
      }
      if (entry?.request && !entry.direct) await this.copyArchive(scope, file, entry, assert, undefined, signal)
    }).catch(() => { /* The original result or copy ledger still holds the intent. */ }).finally(() => {
      if (this.saving.get(key) === next) this.saving.delete(key)
    })
    this.saving.set(key, next)
    return next
  }

  async resumeArchives(scope: TaskOwnerScope, taskIds: readonly string[], signal: AbortSignal): Promise<void> {
    const archive = this.options.archive
    if (!archive) return
    const assert = archive.assertOwner(scope)
    const canRegister = await archive.store.settingAt(scope, Date.now()).then(Boolean, () => false)
    for (const taskId of taskIds) {
      signal.throwIfAborted()
      assert()
      const entries = await archive.store.recoverable(scope, taskId)
      for (const entry of entries) {
        signal.throwIfAborted()
        assert()
        if (entry.request?.taskId === taskId) await this.saveQueuedArchive(scope, entry.request, signal)
      }
      if (!canRegister) continue
      try {
        const committed = await this.options.store.saveIntents?.(scope, taskId)
        const attempted = new Map(entries.flatMap(entry => entry.request ? [[archiveIdentity(entry.request), entry.version] as const] : []))
        for (const candidate of committed ?? []) {
          signal.throwIfAborted()
          assert()
          if (attempted.get(archiveIdentity(candidate.file)) === candidate.intent.version) continue
          await this.saveQueuedArchive(scope, candidate.file, signal, candidate)
        }
      } catch {
        signal.throwIfAborted()
        assert()
        logger.child('result-archive').warn('could not inspect committed results for missing saves', { taskId })
      }
    }
  }

  async archiveStatus(raw: ResultFileRequest): Promise<ResultArchiveStatus> {
    const archive = this.options.archive, identity = archiveIdentity(raw)
    if (!archive || !identity) return { state: 'none' }
    const scope = requireScope(this.options.scope), assert = archive.assertOwner(scope)
    const entry = await archive.store.entry(scope, raw.taskId, identity)
    if (entry?.direct) {
      const saved = await archive.store.destination(entry)
      assert()
      // Missing media is retried through the job's original download, not by copying.
      return { state: saved ? 'saved' : 'none' }
    }
    const candidate = !entry?.stage && await this.unregisteredArchive(scope, raw, entry)
    if (candidate) {
      const configured = await archive.store.settingAt(scope, candidate.intent.startedAt).then(Boolean, () => true)
      assert()
      if (configured) return this.saving.has(this.saveKey(scope, raw)) ? { state: 'pending' } : { state: 'failed', message: archiveFailure }
    }
    const key = this.saveKey(scope, raw)
    const unrecorded = this.unrecordedFailures.get(key)
    if (entry?.stage?.candidate && entry.stage.identity && !this.saving.has(key)) {
      try { await archive.store.interruptedTarget(entry) }
      catch (error) {
        if (!(error instanceof ResultArchiveFailure) || error.reason !== 'reconnect') throw error
        const root = (await archive.store.settings(scope)).at(-1)?.root
        const confirmation = root && alternateArchiveConfirmation(entry, root)
        const available = !!confirmation && !!root && await archive.store.available(root)
        assert()
        return { state: 'failed', message: archiveFailureMessage('reconnect'), ...(available ? { alternateConfirmation: confirmation } : {}) }
      }
    }
    let status: ResultArchiveStatus
    if (!entry) status = { state: 'none' }
    else if (entry.target) status = { state: await archive.store.destination(entry) ? 'saved' : 'missing' }
    else if (unrecorded?.version === entry.version && !this.saving.has(key)) status = { state: 'failed', message: archiveFailureMessage(unrecorded.reason) }
    else if (entry.state === 'pending') status = { state: 'pending' }
    else status = { state: 'failed', message: archiveFailureMessage(entry.failure) }
    assert()
    return status
  }

  private async copyArchive(scope: TaskOwnerScope, file: ResultFileRequest, entry: ResultArchiveEntry, authorize: () => void,
    retryRoot?: string, signal?: AbortSignal, confirmation?: string): Promise<void> {
    const archive = this.options.archive!, identity = archiveIdentity(file), epoch = this.epoch
    const key = this.saveKey(scope, file)
    const assert = () => { this.assert(scope, epoch); authorize(); signal?.throwIfAborted() }
    try {
      assert()
      if (entry.target && !entry.stage && (!retryRoot || await archive.store.destination(entry))) return
      // Keep source-store locks outside the ledger write chain (original commits enqueue in the opposite order).
      const fileSource = await this.options.store.actionFile(scope, file, entry.subscriptionId).catch(() => undefined)
      const source = fileSource && (fileSource.archiveVersion ?? fileSource.version) === entry.version ? fileSource : undefined
      await archive.store.copy(scope, file.taskId, identity, { entry, retryRoot, source, confirmation }, assert)
      this.unrecordedFailures.delete(key)
    } catch (cause) {
      assert()
      if (cause instanceof ResultArchiveConfirmationChanged) throw new AppError('INVALID_STATE', { message: confirmationChanged })
      const reason = cause instanceof ResultArchiveFailure ? cause.reason : undefined
      try {
        await archive.store.fail(scope, file.taskId, identity, entry.version, assert, reason)
        this.unrecordedFailures.delete(key)
      } catch {
        assert()
        this.unrecordedFailures.set(key, { version: entry.version, reason })
        if (this.unrecordedFailures.size > 256) this.unrecordedFailures.delete(this.unrecordedFailures.keys().next().value!)
      }
      logger.child('result-archive').warn('generated file save unavailable', { taskId: file.taskId })
      throw new AppError('INVALID_STATE', { message: archiveFailureMessage(reason), cause })
    }
  }

  async retryArchive(raw: ResultFileRequest, confirmation?: string): Promise<void> {
    const archive = this.options.archive, identity = archiveIdentity(raw)
    if (!archive || !identity) throw new AppError('INVALID_ARGUMENT')
    const scope = requireScope(this.options.scope), assert = archive.assertOwner(scope)
    let entry = await archive.store.entry(scope, raw.taskId, identity)
    if (entry?.direct) throw new AppError('INVALID_STATE', { message: '请在生成记录中重试保存此文件。' })
    if (confirmation) {
      const root = (await archive.store.settings(scope)).at(-1)?.root
      assert()
      if (!entry || !root || alternateArchiveConfirmation(entry, root) !== confirmation) {
        throw new AppError('INVALID_STATE', { message: confirmationChanged })
      }
      await this.copyArchive(scope, raw, entry, assert, root, undefined, confirmation)
      return
    }
    const candidate = !entry?.stage && await this.unregisteredArchive(scope, raw, entry)
    let registered = false
    if (candidate) {
      try {
        const original = await archive.store.settingAt(scope, candidate.intent.startedAt)
        const current = (await archive.store.settings(scope)).at(-1)
        if (original) {
          await this.registerArchive(scope, candidate, current?.root ?? original.root, assert, { previousVersion: entry?.version })
          entry = await archive.store.entry(scope, raw.taskId, identity)
          registered = entry?.version === candidate.intent.version
        }
      } catch (cause) {
        assert()
        throw new AppError('INVALID_STATE', { message: archiveFailure, cause })
      }
    }
    const key = this.saveKey(scope, raw)
    const unrecorded = this.unrecordedFailures.get(key)
    if (!entry || (!registered && entry.state === 'pending' && (this.saving.has(key) ||
      (unrecorded?.version !== entry.version && !entry.stage?.candidate))) ||
      (entry.target && await archive.store.destination(entry))) {
      throw new AppError('INVALID_STATE', { message: '此文件没有需要重试的保存操作。' })
    }
    const setting = (await archive.store.settings(scope)).at(-1)
    assert()
    await this.copyArchive(scope, raw, entry, assert, setting?.root ?? entry.root)
  }

  async saveDialogPath(input: ResultFileRequest, name: string): Promise<string> {
    const archive = this.options.archive
    if (!archive) return name
    const scope = requireScope(this.options.scope), assert = archive.assertOwner(scope)
    const entry = await archive.store.entry(scope, input.taskId, archiveIdentity(input))
    const location = entry && await archive.store.destination(entry)
    const state = location ? null : await archive.settings()
    assert()
    const filename = archiveFileName(name)
    if (location) {
      const extension = extname(filename)
      const stem = extension ? filename.slice(0, -extension.length) : filename
      const candidate = join(dirname(location), filename)
      return candidate === location ? join(dirname(location), `${stem} - 副本${extension}`) : candidate
    }
    return state?.mode !== 'off' && state?.available ? join(state.path, filename) : name
  }

  async withFile<T>(raw: ResultFileRequest, use: (file: ResultActionFile, scope: TaskOwnerScope, assert: () => void) => Promise<T>): Promise<T> {
    const input = resultFileRequestSchema.parse(raw), scope = requireScope(this.options.scope), epoch = this.epoch
    const file = await this.options.store.actionFile(scope, input)
    const assert = () => this.assert(scope, epoch)
    assert()
    return use(file, scope, assert)
  }

  async openDefault(raw: ResultFileRequest, launch: (path: string) => Promise<string>): Promise<void> {
    await this.withFile(raw, async (file, _scope, assert) => {
      if (!canOpenResultFile(file.name) || (!file.temporaryOpen && !canOpenResultFile(file.path))) {
        throw new AppError('INVALID_ARGUMENT', { message: '此格式不能在默认应用中打开。' })
      }
      const copy = file.temporaryOpen ? await createResultOpenCopy(file) : null
      try {
        assert()
        if (await launch(copy?.path ?? file.path)) throw new AppError('INTERNAL_ERROR', { message: '无法在默认应用中打开，请检查系统文件关联。' })
        assert()
        if (copy) this.openCopies.add(copy.dispose)
      } catch (error) { await copy?.dispose(); throw error }
    })
  }

  async saveAs(raw: ResultFileRequest, select: (name: string) => Promise<string | null>): Promise<boolean> {
    return this.withFile(raw, async (file, scope, assert) => {
      const destination = await select(file.name)
      if (!destination) return false
      assert()
      const current = await this.options.store.actionFile(scope, raw)
      assert()
      if (current.path !== file.path || current.version !== file.version) throw new AppError('INVALID_STATE', { message: '源文件已改变，请重新选择文件。' })
      await saveResultCopy(current, destination)
      return true
    })
  }

  async handle(request: Request): Promise<Response> {
    const lease = this.leases.get(request.url)
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    if (!lease) return new Response(null, { status: 404, headers })
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } })
    const epoch = this.epoch
    const check = () => { this.assert(lease.scope, epoch); lease.abort.signal.throwIfAborted(); request.signal.throwIfAborted() }
    try {
      check(); await lease.file.validate(); await lease.file.authorize?.(); check()
      const size = lease.file.size
      let start = 0, end = size - 1
      const range = request.headers.get('range')
      if (range) {
        const parsed = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!parsed || (!parsed[1] && !parsed[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
        if (!parsed[1]) { const suffix = Number(parsed[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } }); start = Math.max(0, size - suffix) }
        else { start = Number(parsed[1]); if (parsed[2]) end = Math.min(end, Number(parsed[2])) }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
      }
      Object.assign(headers, { 'Content-Type': lease.file.mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) })
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      const body = request.method === 'HEAD' ? null : lease.file.stream(start, end, lease.abort.signal, check)
      return new Response(body, { status: range ? 206 : 200, headers })
    } catch { this.dispose(request.url); return new Response(null, { status: 403, headers }) }
  }
}
