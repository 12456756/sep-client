import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, extname } from 'node:path'
import type { AttachmentImportSession, AttachmentImportTarget, AttachmentView } from '../../src/shared/attachment-contracts'
import { attachmentImportSessionSchema, attachmentImportLimits, attachmentRefSchema, attachmentViewSchema } from '../../src/shared/attachment-contracts'
import type { TaskOwnerScope } from './scope-path'
import { ScopePath } from './scope-path'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'
import type { InputSnapshotRef } from '../../src/shared/attachment-contracts'
import type { AttachmentExtractor, AttachmentExtraction } from '../domain/attachment-extraction'
import { inspectMediaImage } from './media-image'

const MIME: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export interface AttachmentStorePort {
  begin(scope: TaskOwnerScope, target: AttachmentImportTarget, now?: number): Promise<AttachmentImportSession>
  get(scope: TaskOwnerScope, sessionId: string): Promise<AttachmentImportSession | null>
  list(scope: TaskOwnerScope): Promise<AttachmentImportSession[]>
  importPath(scope: TaskOwnerScope, sessionId: string, path: string, source: AttachmentView['importSource']): Promise<AttachmentView>
  importBytes(scope: TaskOwnerScope, sessionId: string, bytes: Uint8Array, displayName: string, mediaType: string, source?: AttachmentView['importSource']): Promise<AttachmentView>
  remove(scope: TaskOwnerScope, sessionId: string, attachmentId: string, expectedRevision?: number): Promise<AttachmentImportSession>
  cancel(scope: TaskOwnerScope, sessionId: string): Promise<boolean>
  read(scope: TaskOwnerScope, sessionId: string, attachmentId: string): Promise<Buffer>
  freeze(scope: TaskOwnerScope, taskId: string, sessionId: string, refs: readonly { attachmentId: string; sha256: string }[]): Promise<InputSnapshotRef>
  readTask(scope: TaskOwnerScope, taskId: string, attachmentId: string): Promise<Buffer>
  taskReadPath?(scope: TaskOwnerScope, taskId: string, attachmentId: string): string
  readTaskMetadata(scope: TaskOwnerScope, taskId: string): Promise<{ items: AttachmentView[]; extractionTextById: Record<string, string> }>
  claimDraft(scope: TaskOwnerScope, draftId: string, sessionId: string, refs: readonly { attachmentId: string; sha256: string }[], revision: number, journalKey: string): Promise<void>
  releaseDraft(scope: TaskOwnerScope, draftId: string): Promise<void>
  readTaskSnapshot(scope: TaskOwnerScope, taskId: string): Promise<InputSnapshotRef | null>
  readDraftClaim(scope: TaskOwnerScope, draftId: string): Promise<{ revision: number; sessionId: string; attachments: Array<{ attachmentId: string; sha256: string }> } | null>
  findDraftClaim(scope: TaskOwnerScope, refs: readonly { attachmentId: string; sha256: string }[]): Promise<{ draftId: string; revision: number; sessionId: string; attachments: Array<{ attachmentId: string; sha256: string }> } | null>
}

function mimeFor(name: string): string { return MIME[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream' }
function clone<T>(value: T): T { return structuredClone(value) }
function verifiedMediaType(bytes: Uint8Array, declared: string): string {
  const type = declared.toLowerCase().split(';')[0].trim()
  const b = bytes
  let actual: string | undefined
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) actual = 'image/png'
  else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) actual = 'image/jpeg'
  else if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') actual = 'image/webp'
  if (type.startsWith('image/')) { try { const image = inspectMediaImage(bytes); if (image.mime !== type) throw new Error('ATTACHMENT_IMAGE_SIGNATURE_INVALID'); return image.mime } catch (error) { if ((error as Error).message === 'ATTACHMENT_IMAGE_SIGNATURE_INVALID') throw error; throw new Error('ATTACHMENT_IMAGE_SIGNATURE_INVALID') } }
  if (actual) throw new Error('ATTACHMENT_MEDIA_TYPE_MISMATCH')
  return declared
}

export class AttachmentStore implements AttachmentStorePort {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()
  constructor(userDataDir: string, private readonly ttlMs = 24 * 60 * 60 * 1000, private readonly extractor?: AttachmentExtractor) { this.paths = new ScopePath(userDataDir) }

  async begin(scope: TaskOwnerScope, target: AttachmentImportTarget, now = Date.now()): Promise<AttachmentImportSession> {
    const session: AttachmentImportSession = { schemaVersion: 1, sessionId: `attach-${randomUUID()}`, owner: { ...scope }, target: clone(target), status: 'open', createdAt: now, expiresAt: now + this.ttlMs, attachments: [], revision: 0 }
    await this.save(scope, session)
    return clone(session)
  }

  async get(scope: TaskOwnerScope, sessionId: string): Promise<AttachmentImportSession | null> {
    return readJsonWithBackup(this.paths.attachmentImportManifest(scope, sessionId), value => {
      const parsed = attachmentImportSessionSchema.safeParse(value)
      if (!parsed.success || parsed.data.owner.memberId !== scope.memberId || parsed.data.owner.enterpriseId !== scope.enterpriseId || parsed.data.sessionId !== sessionId) return null
      return parsed.data
    })
  }

  async list(scope: TaskOwnerScope): Promise<AttachmentImportSession[]> {
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(this.paths.attachmentImportsRoot(scope), { withFileTypes: true }) } catch { return [] }
    const sessions = await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => this.get(scope, entry.name)))
    return sessions.filter((item): item is AttachmentImportSession => item !== null)
  }

  async importPath(scope: TaskOwnerScope, sessionId: string, path: string, source: AttachmentView['importSource']): Promise<AttachmentView> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('ATTACHMENT_NOT_REGULAR_FILE')
      if (info.size <= 0) throw new Error('ATTACHMENT_EMPTY')
      if (info.size > attachmentImportLimits.maxFileBytes) throw new Error('ATTACHMENT_TOO_LARGE')
      const chunks: Buffer[] = []
      let total = 0
      const limit = attachmentImportLimits.maxFileBytes + 1
      while (total < limit) {
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, limit - total))
        const result = await handle.read(buffer, 0, buffer.length, total)
        if (result.bytesRead <= 0) break
        chunks.push(buffer.subarray(0, result.bytesRead))
        total += result.bytesRead
        if (result.bytesRead < buffer.length) break
      }
      const after = await handle.stat()
      const sameIdentity = info.dev === after.dev && info.ino === after.ino && info.size === after.size && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs
      if (!sameIdentity || total > attachmentImportLimits.maxFileBytes) throw new Error('ATTACHMENT_SOURCE_CHANGED')
      if (total <= 0) throw new Error('ATTACHMENT_EMPTY')
      return this.importBuffer(scope, sessionId, Buffer.concat(chunks, total), basename(path), mimeFor(path), source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('ATTACHMENT_NOT_REGULAR_FILE')
      throw error
    } finally { await handle?.close().catch(() => undefined) }
  }

  async importBytes(scope: TaskOwnerScope, sessionId: string, bytes: Uint8Array, displayName: string, mediaType: string, source: AttachmentView['importSource'] = 'paste-image'): Promise<AttachmentView> {
    if (bytes.byteLength <= 0) throw new Error('ATTACHMENT_EMPTY')
    if (bytes.byteLength > attachmentImportLimits.maxFileBytes) throw new Error('ATTACHMENT_TOO_LARGE')
    return this.importBuffer(scope, sessionId, Buffer.from(bytes), displayName, mediaType, source)
  }

  private async importBuffer(scope: TaskOwnerScope, sessionId: string, bytes: Buffer, displayName: string, mediaType: string, source: AttachmentView['importSource']): Promise<AttachmentView> {
    mediaType = verifiedMediaType(bytes, mediaType)
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const session = await this.get(scope, sessionId)
      if (!session || session.status !== 'open' || session.expiresAt <= Date.now()) throw new Error('ATTACHMENT_SESSION_EXPIRED')
      if (session.attachments.length >= attachmentImportLimits.maxFiles || session.attachments.reduce((n, item) => n + item.byteLength, 0) + bytes.length > attachmentImportLimits.maxTotalBytes) throw new Error('ATTACHMENT_TOTAL_TOO_LARGE')
      const attachmentId = `att-${randomUUID()}`
      const hash = createHash('sha256').update(bytes).digest('hex')
      let extraction: AttachmentExtraction | undefined
      if (this.extractor) {
        try { extraction = await this.extractor(mediaType, bytes) } catch { extraction = { status: 'failed', text: '', warnings: ['提取失败'] } }
      }
      const image = mediaType.startsWith('image/') ? inspectMediaImage(bytes) : undefined
      const item: AttachmentView = { attachmentId, displayName: displayName.slice(0, 255) || 'attachment', mediaType: mediaType.slice(0, 128) || 'application/octet-stream', byteLength: bytes.length, sha256: hash, importSource: source, extractionStatus: extraction?.status ?? 'pending', warnings: extraction?.warnings ?? [], width: image?.width, height: image?.height }
      const target = this.paths.attachmentBlobFile(scope, sessionId, attachmentId)
      await mkdir(target.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      if (extraction) {
        const bounded = { ...extraction, text: extraction.text.slice(0, 100000), warnings: extraction.warnings.slice(0, 32) }
        await writeJsonAtomic(this.paths.attachmentExtractionFile(scope, sessionId, attachmentId), bounded)
        item.extractionSummary = bounded.text.slice(0, 2000)
      }
      session.attachments.push(item)
      session.revision += 1
      await this.saveUnlocked(scope, session)
      return clone(item)
    })
  }

  async remove(scope: TaskOwnerScope, sessionId: string, attachmentId: string, expectedRevision?: number): Promise<AttachmentImportSession> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const session = await this.get(scope, sessionId)
      if (!session) throw new Error('ATTACHMENT_SESSION_NOT_FOUND')
      if (session.status === 'claimed') throw new Error('ATTACHMENT_SESSION_CLAIMED')
      if (expectedRevision !== undefined && expectedRevision !== session.revision) throw new Error('ATTACHMENT_REVISION_CONFLICT')
      if (!session.attachments.some(item => item.attachmentId === attachmentId)) return clone(session)
      session.attachments = session.attachments.filter(item => item.attachmentId !== attachmentId)
      session.revision += 1
      await rm(this.paths.attachmentBlobFile(scope, sessionId, attachmentId), { force: true })
      await this.saveUnlocked(scope, session)
      return clone(session)
    })
  }

  async cancel(scope: TaskOwnerScope, sessionId: string): Promise<boolean> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const session = await this.get(scope, sessionId)
      if (!session) return false
      if (session.status === 'claimed') return true
      session.status = 'cancelled'
      await this.saveUnlocked(scope, session)
      return true
    })
  }

  async read(scope: TaskOwnerScope, sessionId: string, attachmentId: string): Promise<Buffer> {
    const session = await this.get(scope, sessionId)
    const item = session?.attachments.find(candidate => candidate.attachmentId === attachmentId)
    if (!item) throw new Error('ATTACHMENT_NOT_FOUND')
    const bytes = await readFile(this.paths.attachmentBlobFile(scope, sessionId, attachmentId))
    if (bytes.length !== item.byteLength || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('ATTACHMENT_INTEGRITY_MISMATCH')
    return bytes
  }

  async freeze(scope: TaskOwnerScope, taskId: string, sessionId: string, refs: readonly { attachmentId: string; sha256: string }[]): Promise<InputSnapshotRef> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const session = await this.get(scope, sessionId)
      if (!session || session.status === 'cancelled' || session.expiresAt <= Date.now()) throw new Error('ATTACHMENT_SESSION_EXPIRED')
      if (session.target.kind === 'conversation' && session.target.taskId !== taskId) throw new Error('ATTACHMENT_TARGET_MISMATCH')
      const selected = refs.map(ref => session.attachments.find(item => item.attachmentId === ref.attachmentId && item.sha256 === ref.sha256))
      if (selected.some(item => !item)) throw new Error('ATTACHMENT_REFERENCE_INVALID')
      const normalized = refs.map(ref => ({ attachmentId: ref.attachmentId, sha256: ref.sha256 }))
      const existing = await this.readTaskSnapshot(scope, taskId)
      if (existing && JSON.stringify(existing.attachments) === JSON.stringify(normalized)) return existing
      const snapshotId = `snapshot-${randomUUID()}`
      const journal = this.paths.attachmentJournalFile(scope, `${taskId}-${snapshotId}`)
      const journalEntry = { schemaVersion: 1, status: 'prepared', kind: 'task', taskId, sessionId, snapshotId, attachments: normalized }
      await writeJsonAtomic(journal, journalEntry)
      const metadata: AttachmentView[] = []
      const extractionTextById: Record<string, string> = {}
      for (const item of selected as AttachmentView[]) {
        const bytes = await this.read(scope, sessionId, item.attachmentId)
        const target = this.paths.attachmentTaskBlob(scope, taskId, item.attachmentId)
        await mkdir(target.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
        try { await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const existingBytes = await readFile(target)
          if (createHash('sha256').update(existingBytes).digest('hex') !== item.sha256) throw new Error('ATTACHMENT_INTEGRITY_MISMATCH')
        }
        metadata.push(clone(item))
        try {
          const extraction = JSON.parse(await readFile(this.paths.attachmentExtractionFile(scope, sessionId, item.attachmentId), 'utf8')) as AttachmentExtraction
          if (typeof extraction.text === 'string') extractionTextById[item.attachmentId] = extraction.text.slice(0, 100000)
          const extractionPath = this.paths.attachmentTaskExtractionFile(scope, taskId, item.attachmentId)
          await mkdir(extractionPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
          await writeJsonAtomic(extractionPath, extraction)
        } catch { /* extraction is optional */ }
      }
      const inputDigest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
      const snapshot: InputSnapshotRef = { snapshotId, attachments: normalized, inputDigest }
      await mkdir(this.paths.attachmentTaskDir(scope, taskId), { recursive: true })
      let prior: { snapshots?: InputSnapshotRef[]; snapshot?: InputSnapshotRef; items?: AttachmentView[]; extractionTextById?: Record<string, string> } = {}
      try { prior = JSON.parse(await readFile(this.paths.attachmentTaskManifest(scope, taskId), 'utf8')) } catch { /* first snapshot */ }
      const snapshots = [...(prior.snapshots ?? (prior.snapshot ? [prior.snapshot] : [])), snapshot]
      const mergedItems = [...(prior.items ?? []), ...metadata].filter((item, index, all) => all.findIndex(candidate => candidate.attachmentId === item.attachmentId && candidate.sha256 === item.sha256) === index)
      const mergedText = { ...(prior.extractionTextById ?? {}), ...extractionTextById }
      await writeJsonAtomic(this.paths.attachmentTaskManifest(scope, taskId), { snapshot, snapshots, items: mergedItems, extractionTextById: mergedText })
      await writeJsonAtomic(journal, { ...journalEntry, status: 'committed', snapshot })
      return snapshot
    })
  }

  async readTask(scope: TaskOwnerScope, taskId: string, attachmentId: string): Promise<Buffer> {
    const bytes = await readFile(this.paths.attachmentTaskBlob(scope, taskId, attachmentId))
    const parsed: unknown = JSON.parse(await readFile(this.paths.attachmentTaskManifest(scope, taskId), 'utf8'))
    if (!parsed || typeof parsed !== 'object') throw new Error('ATTACHMENT_MANIFEST_INVALID')
    const raw = parsed as { snapshot?: unknown; snapshots?: unknown }
    const candidates = Array.isArray(raw.snapshots) ? raw.snapshots : raw.snapshot ? [raw.snapshot] : []
    const snapshots = candidates.filter((snapshot): snapshot is InputSnapshotRef => {
      if (!snapshot || typeof snapshot !== 'object') return false
      const attachments = (snapshot as { attachments?: unknown }).attachments
      return Array.isArray(attachments) && attachments.every(item => attachmentRefSchema.safeParse(item).success)
    })
    if (snapshots.length !== candidates.length) throw new Error('ATTACHMENT_MANIFEST_INVALID')
    const ref = snapshots.flatMap(snapshot => snapshot.attachments).find(item => item.attachmentId === attachmentId)
    if (!ref || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('ATTACHMENT_INTEGRITY_MISMATCH')
    return bytes
  }

  taskReadPath(scope: TaskOwnerScope, taskId: string, attachmentId: string): string { return this.paths.attachmentTaskBlob(scope, taskId, attachmentId) }

  async readTaskSnapshot(scope: TaskOwnerScope, taskId: string): Promise<InputSnapshotRef | null> {
    try {
      const raw = JSON.parse(await readFile(this.paths.attachmentTaskManifest(scope, taskId), 'utf8')) as { snapshot?: unknown }
      const snapshot = raw.snapshot
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray((snapshot as { attachments?: unknown }).attachments)
        || !(snapshot as { attachments: unknown[] }).attachments.every(item => attachmentRefSchema.safeParse(item).success)) return null
      return snapshot as InputSnapshotRef
    } catch { return null }
  }

  async readTaskMetadata(scope: TaskOwnerScope, taskId: string): Promise<{ items: AttachmentView[]; extractionTextById: Record<string, string> }> {
    try {
      const raw = JSON.parse(await readFile(this.paths.attachmentTaskManifest(scope, taskId), 'utf8')) as { items?: unknown; extractionTextById?: unknown }
      const items = Array.isArray(raw.items) ? raw.items.filter(item => attachmentViewSchema.safeParse(item).success) as AttachmentView[] : []
      const extractionTextById = raw.extractionTextById && typeof raw.extractionTextById === 'object'
        ? Object.fromEntries(Object.entries(raw.extractionTextById).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {}
      return { items, extractionTextById }
    } catch { return { items: [], extractionTextById: {} } }
  }

  async claimDraft(scope: TaskOwnerScope, draftId: string, sessionId: string, refs: readonly { attachmentId: string; sha256: string }[], revision: number, journalKey: string): Promise<void> {
    await this.writes.run(this.paths.scopeKey(scope), async () => {
      const existing = await this.readDraftClaim(scope, draftId)
      const normalized = refs.map(ref => ({ attachmentId: ref.attachmentId, sha256: ref.sha256 }))
      if (existing && existing.revision === revision && JSON.stringify(existing.attachments) === JSON.stringify(normalized)) return
      const session = await this.get(scope, sessionId)
      if (!session || session.status === 'cancelled' || session.expiresAt <= Date.now()) throw new Error('ATTACHMENT_SESSION_EXPIRED')
      if (normalized.some(ref => !session.attachments.some(item => item.attachmentId === ref.attachmentId && item.sha256 === ref.sha256))) throw new Error('ATTACHMENT_REFERENCE_INVALID')
      const journal = this.paths.attachmentJournalFile(scope, journalKey)
      await writeJsonAtomic(journal, { schemaVersion: 1, status: 'prepared', kind: 'draft', draftId, sessionId, revision, attachments: normalized })
      await mkdir(this.paths.attachmentDraftManifest(scope, draftId).replace(/[/\\][^/\\]+$/, ''), { recursive: true })
      await writeJsonAtomic(this.paths.attachmentDraftManifest(scope, draftId), { schemaVersion: 1, revision, sessionId, attachments: normalized })
      await writeJsonAtomic(journal, { schemaVersion: 1, status: 'committed', kind: 'draft', draftId, sessionId, revision, attachments: normalized })
      session.status = 'claimed'
      await this.saveUnlocked(scope, session)
    })
  }

  async releaseDraft(scope: TaskOwnerScope, draftId: string): Promise<void> {
    await rm(this.paths.attachmentDraftManifest(scope, draftId), { force: true })
  }

  async readDraftClaim(scope: TaskOwnerScope, draftId: string) {
    try { return JSON.parse(await readFile(this.paths.attachmentDraftManifest(scope, draftId), 'utf8')) as { revision: number; sessionId: string; attachments: Array<{ attachmentId: string; sha256: string }> } } catch { return null }
  }

  async findDraftClaim(scope: TaskOwnerScope, refs: readonly { attachmentId: string; sha256: string }[]) {
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(this.paths.attachmentDraftsRoot(scope), { withFileTypes: true }) } catch { return null }
    const normalized = JSON.stringify(refs)
    for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json'))) {
      const draftId = entry.name.slice(0, -5)
      const claim = await this.readDraftClaim(scope, draftId)
      if (claim && JSON.stringify(claim.attachments) === normalized) return { draftId, ...claim }
    }
    return null
  }

  private async save(scope: TaskOwnerScope, session: AttachmentImportSession): Promise<void> { await this.writes.run(this.paths.scopeKey(scope), () => this.saveUnlocked(scope, session)) }
  private async saveUnlocked(scope: TaskOwnerScope, session: AttachmentImportSession): Promise<void> { await mkdir(this.paths.attachmentImportDir(scope, session.sessionId), { recursive: true }); await writeJsonAtomic(this.paths.attachmentImportManifest(scope, session.sessionId), session) }
}
