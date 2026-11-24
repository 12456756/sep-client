import type { AttachmentFolderPreview, AttachmentImportSession, AttachmentImportTarget, AttachmentPreview, AttachmentRef, AttachmentView } from '../../src/shared/attachment-contracts'
import type { InputSnapshotRef as SharedInputSnapshotRef } from '../../src/shared/attachment-contracts'
import type { TaskOwnerScope } from '../data/scope-path'
import { AttachmentStore } from '../data/attachment-store'
import type { AttachmentStorePort } from '../data/attachment-store'
import { createHash, randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import type { AttachmentExtractor } from '../domain/attachment-extraction'
import type { BoundOriginalFile, ResolvedAttachmentInput } from '../domain/attachment-input'
import type { RunXlsxQuery, XlsxQuery } from '../domain/xlsx-analysis'
import { selectedAttachmentOriginal } from '../data/attachment-original'
import { AppError } from '../errors/app-error'
import { attachmentImportLimits, referenceAttachmentSelectionSchema, referenceTextLimit, XLSX_MEDIA_TYPE, type ReferenceAttachmentSelection, type ReferenceMaterials } from '../../src/shared/attachment-contracts'
import { assertAttachmentFolderEntry, scanAttachmentFolder, type AttachmentFolderEntry } from '../data/attachment-folder'


export interface AttachmentImportResult {
  item: AttachmentView
  session: AttachmentImportSession
}

export interface PlannerAttachmentMaterial {
  attachmentId: string
  sha256: string
  displayName: string
  mediaType: string
  byteLength: number
  summary: string
  warnings: string[]
}

export type InputSnapshotRef = SharedInputSnapshotRef

/** Scope-aware attachment use cases. The service delegates all filesystem paths to data. */
export class AttachmentService {
  private readonly selectedOriginals = new Map<string, BoundOriginalFile>()
  private readonly folderPreviews = new Map<string, { id: string; scope: TaskOwnerScope; expiresAt: number; entries: AttachmentFolderEntry[] }>()

  readonly queryTaskXlsx?: (scope: TaskOwnerScope, taskId: string, ref: AttachmentRef, query: XlsxQuery, signal?: AbortSignal) => ReturnType<RunXlsxQuery>
  private epoch = 0

  constructor(private readonly store: AttachmentStorePort, private readonly scopeProvider?: () => TaskOwnerScope | null,
    runXlsx?: (...args: [...Parameters<RunXlsxQuery>, validate: () => void]) => ReturnType<RunXlsxQuery>) {
    if (runXlsx) this.queryTaskXlsx = async (scope, taskId, ref, query, signal) => {
      const epoch = this.epoch
      const validate = () => {
        signal?.throwIfAborted()
        if (epoch !== this.epoch || !this.sameOwner(scope, this.currentScope())) throw new AppError('AUTH_REQUIRED')
      }
      validate()
      const { bytes } = await this.readTaskAttachment(taskId, ref.attachmentId, ref.sha256, XLSX_MEDIA_TYPE)
      validate()
      const result = await runXlsx(bytes, query, signal, validate)
      validate()
      return result
    }
  }

  static fromUserData(userDataDir: string, scopeProvider?: () => TaskOwnerScope | null, extractor?: AttachmentExtractor): AttachmentService { return new AttachmentService(new AttachmentStore(userDataDir, undefined, extractor), scopeProvider) }

  private currentScope(): TaskOwnerScope {
    const scope = this.scopeProvider?.()
    if (!scope) throw new AppError('AUTH_REQUIRED')
    return scope
  }

  beginSession(target: AttachmentImportTarget): Promise<AttachmentImportSession> { return this.begin(this.currentScope(), target) }
  listSession(sessionId: string): Promise<AttachmentImportSession | null> { return this.get(this.currentScope(), sessionId) }
  importFiles(sessionId: string, operationId: string, paths: readonly string[], source: AttachmentView['importSource'] = 'picker'): Promise<AttachmentImportResult[]> {
    const scope = this.currentScope()
    return Promise.all(paths.map(path => this.importFile(scope, sessionId, operationId, path, source)))
  }
  importSelectedFiles(sessionId: string, operationId: string, paths: readonly string[]): Promise<void> {
    return this.importOriginalFiles(sessionId, operationId, paths)
  }
  importDroppedFiles(sessionId: string, operationId: string, composerId: string, paths: readonly string[]): Promise<void> {
    return this.importOriginalFiles(sessionId, operationId, paths, composerId)
  }
  private async importOriginalFiles(sessionId: string, operationId: string, paths: readonly string[], dropComposerId?: string): Promise<void> {
    const scope = this.currentScope()
    const epoch = this.epoch
    const assertOwner = () => {
      if (epoch !== this.epoch || !this.sameOwner(scope, this.currentScope())) throw new AppError('AUTH_REQUIRED')
    }
    if (dropComposerId !== undefined) {
      const session = await this.require(scope, sessionId)
      assertOwner()
      if (session.target.kind !== 'compose' || session.target.composerId !== dropComposerId || session.status !== 'open' || session.expiresAt <= Date.now()) {
        throw new AppError('INVALID_STATE')
      }
    }
    for (const path of paths) {
      const original = await selectedAttachmentOriginal(path)
      assertOwner()
      const { item } = await this.importFile(scope, sessionId, operationId, path, dropComposerId === undefined ? 'picker' : 'paste-file')
      const after = original && await selectedAttachmentOriginal(path)
      assertOwner()
      if (original && after?.path === original.path && after.identity === original.identity) {
        this.selectedOriginals.set(this.selectedOriginalKey(scope, item), original)
        if (this.selectedOriginals.size > 512) this.selectedOriginals.delete(this.selectedOriginals.keys().next().value!)
      }
    }
  }
  private selectedOriginalKey(scope: TaskOwnerScope, ref: AttachmentRef) {
    return JSON.stringify([scope.memberId, scope.enterpriseId, ref.attachmentId, ref.sha256])
  }
  importImageForSession(sessionId: string, operationId: string, bytes: Uint8Array, displayName: string, mediaType: string): Promise<AttachmentImportResult> { return this.importImage(this.currentScope(), sessionId, operationId, bytes, displayName, mediaType) }
  removeFromSession(sessionId: string, attachmentId: string, expectedRevision?: number): Promise<AttachmentImportSession> { return this.remove(this.currentScope(), sessionId, attachmentId, expectedRevision) }
  cancelSession(sessionId: string): Promise<boolean> {
    const scope = this.currentScope()
    const preview = this.folderPreviews.get(sessionId)
    if (preview && this.sameOwner(preview.scope, scope)) this.folderPreviews.delete(sessionId)
    return this.cancel(scope, sessionId)
  }

  private sameOwner(a: TaskOwnerScope, b: TaskOwnerScope): boolean {
    return a.memberId === b.memberId && a.enterpriseId === b.enterpriseId
  }

  private async openFolderSession(scope: TaskOwnerScope, sessionId: string): Promise<AttachmentImportSession> {
    const session = await this.get(scope, sessionId)
    if (!this.sameOwner(scope, this.currentScope())) throw new AppError('AUTH_REQUIRED')
    if (!session || session.target.kind !== 'compose' || session.status !== 'open' || session.expiresAt <= Date.now()) throw new Error('ATTACHMENT_SESSION_EXPIRED')
    return session
  }

  async previewFolder(sessionId: string, path: string): Promise<AttachmentFolderPreview> {
    const scope = this.currentScope()
    await this.openFolderSession(scope, sessionId)
    const { folderName, entries, truncated } = await scanAttachmentFolder(path)
    await this.openFolderSession(scope, sessionId)
    const previewId = randomUUID()
    const now = Date.now()
    for (const [key, value] of this.folderPreviews) if (value.expiresAt <= now) this.folderPreviews.delete(key)
    this.folderPreviews.delete(sessionId)
    if (this.folderPreviews.size >= 32) {
      const oldest = this.folderPreviews.keys().next().value
      if (oldest) this.folderPreviews.delete(oldest)
    }
    this.folderPreviews.set(sessionId, { id: previewId, scope, expiresAt: now + 5 * 60_000, entries })
    return { previewId, folderName, candidates: entries.map(entry => entry.candidate), truncated }
  }

  async importFolderSelection(sessionId: string, previewId: string, candidateIds: readonly string[]): Promise<AttachmentImportSession> {
    const scope = this.currentScope()
    const session = await this.openFolderSession(scope, sessionId)
    const preview = this.folderPreviews.get(sessionId)
    if (!preview || preview.id !== previewId || preview.expiresAt <= Date.now() || !this.sameOwner(scope, preview.scope)) throw new Error('ATTACHMENT_FOLDER_PREVIEW_EXPIRED')
    const selected = new Set(candidateIds)
    const entries = preview.entries.filter(entry => selected.has(entry.candidate.id))
    if (entries.length !== selected.size || !entries.length || entries.length > attachmentImportLimits.maxImportFiles) throw new Error('ATTACHMENT_FOLDER_PREVIEW_EXPIRED')
    for (const { candidate } of entries) {
      if (candidate.unavailable === 'empty') throw new Error('ATTACHMENT_EMPTY')
      if (candidate.unavailable === 'too-large') throw new Error('ATTACHMENT_TOO_LARGE')
    }
    const bytes = entries.reduce((total, entry) => total + entry.candidate.byteLength, 0)
    if (session.attachments.length + entries.length > attachmentImportLimits.maxFiles ||
      session.attachments.reduce((total, item) => total + item.byteLength, bytes) > attachmentImportLimits.maxTotalBytes) throw new Error('ATTACHMENT_TOTAL_TOO_LARGE')
    this.folderPreviews.delete(sessionId)
    await this.store.checkImportSpace?.(scope, sessionId, bytes)
    for (const entry of entries) await assertAttachmentFolderEntry(entry)
    for (const entry of entries) {
      await this.openFolderSession(scope, sessionId)
      await this.store.importPath(scope, sessionId, entry.path, 'paste-file', entry.candidate.name, entry)
    }
    return this.openFolderSession(scope, sessionId)
  }

  async referenceMaterials(scope: TaskOwnerScope, raw: ReferenceAttachmentSelection): Promise<ReferenceMaterials> {
    const selection = referenceAttachmentSelectionSchema.parse(raw)
    const assertOwner = () => {
      const current = this.currentScope()
      if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    }
    assertOwner()
    const session = await this.get(scope, selection.sessionId)
    if (!session || session.target.kind !== 'compose' || session.status !== 'open' || session.expiresAt <= Date.now()) {
      throw new AppError('INVALID_ARGUMENT', { message: '文件引用已失效，请重新选择。' })
    }
    const materials: ReferenceMaterials = []
    const seen = new Set<string>()
    for (const ref of selection.attachments) {
      const item = session.attachments.find(candidate => candidate.attachmentId === ref.attachmentId && candidate.sha256 === ref.sha256)
      if (!item) throw new AppError('INVALID_ARGUMENT', { message: '文件引用已变化，请重新选择。' })
      if (seen.has(item.attachmentId)) continue
      seen.add(item.attachmentId)
      await this.store.read(scope, selection.sessionId, item.attachmentId)
      const extraction = await this.store.readExtraction?.(scope, selection.sessionId, item.attachmentId)
      if (!extraction?.text.trim() || !['ready', 'partial'].includes(extraction.status)) throw new AppError('INVALID_ARGUMENT', { message: `无法读取「${item.displayName}」的文本，请选择可提取文本的文件。` })
      materials.push({ name: item.displayName, text: extraction.text.slice(0, referenceTextLimit), truncated: extraction.status === 'partial' || extraction.text.length > referenceTextLimit })
      assertOwner()
    }
    return materials
  }

  async previewTaskAttachment(taskId: string, attachmentId: string, sha256: string): Promise<AttachmentPreview> {
    const { item, bytes } = await this.readTaskAttachment(taskId, attachmentId, sha256)
    return this.imagePreview(item, bytes)
  }

  async previewDraftAttachment(sessionId: string, attachmentId: string, sha256: string): Promise<AttachmentPreview> {
    const scope = this.currentScope()
    const findImage = async () => {
      const session = await this.get(scope, sessionId)
      const current = this.currentScope()
      if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
      if (session?.target.kind !== 'compose' || session.status !== 'open' || session.expiresAt <= Date.now()) throw new AppError('NOT_FOUND')
      const item = session.attachments.find(candidate => candidate.attachmentId === attachmentId && candidate.sha256 === sha256)
      if (!item || item.byteLength > attachmentImportLimits.maxFileBytes) throw new AppError('NOT_FOUND')
      return item
    }
    const item = await findImage()
    if (!/^image\/(?:png|jpeg|webp)$/.test(item.mediaType)) throw new Error('ATTACHMENT_PREVIEW_UNSUPPORTED')
    const bytes = await this.store.read(scope, sessionId, attachmentId)
    await findImage()
    return this.imagePreview(item, bytes)
  }

  private imagePreview(item: AttachmentView, bytes: Buffer): AttachmentPreview {
    const { attachmentId, sha256, mediaType } = item
    if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp') throw new Error('ATTACHMENT_PREVIEW_UNSUPPORTED')
    return { attachmentId, sha256, mediaType, bytes: new Uint8Array(bytes),
      ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) }
  }

  async readTaskDocument(taskId: string, attachmentId: string, sha256: string) {
    const { item, bytes } = await this.readTaskAttachment(taskId, attachmentId, sha256)
    const format = extname(item.displayName).slice(1).toLowerCase()
    if (format !== 'doc' && format !== 'docx') throw new AppError('INVALID_ARGUMENT')
    return { name: item.displayName, version: item.sha256, format, bytes }
  }

  async resolveTaskFile(scope: TaskOwnerScope, taskId: string, attachmentId: string, sha256: string) {
    const current = this.currentScope()
    if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    const { item } = await this.readTaskAttachment(taskId, attachmentId, sha256)
    const path = this.store.taskReadPath?.(scope, taskId, attachmentId)
    if (!path) throw new AppError('NOT_FOUND')
    return { path, name: item.displayName, size: item.byteLength }
  }

  async attachResultFile(scope: TaskOwnerScope, sessionId: string, path: string, name: string): Promise<AttachmentImportSession> {
    const session = await this.require(scope, sessionId)
    const current = this.currentScope()
    if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    if (session.status !== 'open' || session.target.kind !== 'compose') throw new AppError('INVALID_STATE')
    await this.store.importPath(scope, sessionId, path, 'picker', name)
    return this.require(scope, sessionId)
  }

  private async readTaskAttachment(taskId: string, attachmentId: string, sha256: string, expectedMediaType?: string) {
    const scope = this.currentScope()
    const metadata = await this.store.readTaskMetadata(scope, taskId)
    const item = metadata.items.find(candidate => candidate.attachmentId === attachmentId && candidate.sha256 === sha256)
    if (!item) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    if (expectedMediaType && item.mediaType !== expectedMediaType) throw new Error('XLSX_INVALID_REQUEST')
    if (item.byteLength > attachmentImportLimits.maxFileBytes) throw new Error('ATTACHMENT_TOO_LARGE')
    const bytes = await this.store.readTask(scope, taskId, attachmentId)
    if (bytes.byteLength !== item.byteLength || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new Error('ATTACHMENT_INTEGRITY_MISMATCH')
    }
    const current = this.scopeProvider?.()
    if (!current || current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    return { item, bytes }
  }

  // Draft/task claims are intentionally explicit. The arrangement service should call these
  // only after its own revision and task ownership checks; this layer validates source refs.
  async claimDraft(sessionId: string, draftId: string, revision: number, refs: readonly AttachmentRef[]): Promise<void> {
    const scope = this.currentScope()
    await this.validateRefs(scope, sessionId, refs)
    await this.store.claimDraft(scope, draftId, sessionId, refs, revision, `draft-${draftId}-${revision}`)
  }

  async validateDraft(draftId: string, refs: readonly AttachmentRef[]): Promise<void> {
    const snapshot = await this.store.readDraftClaim(this.currentScope(), draftId)
    if (!snapshot || JSON.stringify(snapshot.attachments) !== JSON.stringify(refs)) throw new Error('ATTACHMENT_REFERENCE_INVALID')
  }

  async plannerMaterials(sessionId: string, refs: readonly (AttachmentRef | { attachment: AttachmentRef })[]): Promise<PlannerAttachmentMaterial[]> {
    const normalized = refs.map(ref => 'attachment' in ref ? ref.attachment : ref)
    const scope = this.currentScope()
    const claim = await this.store.readDraftClaim(scope, sessionId)
    const session = claim ? await this.get(scope, claim.sessionId) : null
    if (!session) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    if (claim && JSON.stringify(claim.attachments) !== JSON.stringify(normalized)) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    const items = normalized.map(ref => session.attachments.find(item => item.attachmentId === ref.attachmentId && item.sha256 === ref.sha256))
    if (items.some(item => !item)) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    return items.filter((item): item is AttachmentView => item !== undefined).map(item => ({ attachmentId: item.attachmentId, sha256: item.sha256, displayName: item.displayName, mediaType: item.mediaType, byteLength: item.byteLength, summary: item.extractionSummary || `附件 ${item.displayName}（${item.byteLength} bytes，${item.mediaType}）`, warnings: [...item.warnings] }))
  }

  async claimTask(sessionId: string, _taskId: string, refs: readonly AttachmentRef[]): Promise<InputSnapshotRef> {
    const scope = this.currentScope()
    const items = await this.validateRefs(scope, sessionId, refs)
    return this.store.freeze(scope, _taskId, sessionId, items.map(item => ({ attachmentId: item.attachmentId, sha256: item.sha256 })))
  }

  async freezeDraft(draftId: string, taskId: string, refs: readonly AttachmentRef[]): Promise<InputSnapshotRef> {
    const scope = this.currentScope()
    const claim = await this.store.readDraftClaim(scope, draftId)
    if (!claim || JSON.stringify(claim.attachments) !== JSON.stringify(refs)) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    return this.store.freeze(scope, taskId, claim.sessionId, refs)
  }

  copyTaskInputs(scope: TaskOwnerScope, sourceTaskId: string, taskId: string, snapshot: InputSnapshotRef): Promise<InputSnapshotRef> {
    if (!this.store.copyTaskInputs) throw new Error('ATTACHMENT_COPY_UNAVAILABLE')
    return this.store.copyTaskInputs(scope, sourceTaskId, taskId, snapshot)
  }

  async latestTaskSnapshot(scope: TaskOwnerScope, taskId: string): Promise<InputSnapshotRef | null> {
    return this.store.readTaskSnapshot(scope, taskId)
  }

  async describeTaskInputs(scope: TaskOwnerScope, taskId: string, refs: readonly AttachmentRef[]): Promise<ResolvedAttachmentInput[]> {
    return this.describeInputs(scope, taskId, refs, (await this.store.readTaskMetadata(scope, taskId)).items)
  }

  private describeInputs(scope: TaskOwnerScope, taskId: string, refs: readonly AttachmentRef[], views: readonly AttachmentView[]): ResolvedAttachmentInput[] {
    const items = new Map(views.map(item => [item.attachmentId, item]))
    return refs.flatMap(ref => {
      const item = items.get(ref.attachmentId)
      if (!item || item.sha256 !== ref.sha256) return []
      return [{ attachmentId: item.attachmentId, sha256: item.sha256, displayName: item.displayName, mediaType: item.mediaType, byteLength: item.byteLength, width: item.width, height: item.height, extractionStatus: item.extractionStatus, readPath: this.store.taskReadPath?.(scope, taskId, item.attachmentId), originalFile: this.selectedOriginals.get(this.selectedOriginalKey(scope, item)) }]
    })
  }

  async resolveTaskInputs(scope: TaskOwnerScope, taskId: string, inputRefs: readonly (AttachmentRef | { kind: string; attachment?: AttachmentRef })[]): Promise<{ attachments: ResolvedAttachmentInput[]; images: Array<ResolvedAttachmentInput & { bytes: Uint8Array }>; digest: string }> {
    const refs = inputRefs.flatMap(ref => 'attachmentId' in ref ? [ref] : ref.kind === 'attachment' && ref.attachment ? [ref.attachment] : [])
    const metadata = await this.store.readTaskMetadata(scope, taskId)
    const attachments = this.describeInputs(scope, taskId, refs, metadata.items)
      .map(item => ({ ...item, extractedText: metadata.extractionTextById[item.attachmentId] }))
    if (attachments.length !== refs.length) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    const images: Array<ResolvedAttachmentInput & { bytes: Uint8Array }> = []
    for (const ref of refs) {
      const bytes = await this.store.readTask(scope, taskId, ref.attachmentId)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== ref.sha256) throw new Error('ATTACHMENT_INTEGRITY_MISMATCH')
      const item = attachments.find(candidate => candidate.attachmentId === ref.attachmentId)
      if (item?.mediaType.startsWith('image/')) images.push({ ...item, bytes })
    }
    return { attachments, images, digest: createHash('sha256').update(JSON.stringify(refs)).digest('hex') }
  }

  async plannerMaterialsForDraft(draftId: string, candidates: readonly { attachment: AttachmentRef }[]): Promise<PlannerAttachmentMaterial[]> {
    return this.plannerMaterials(draftId, candidates)
  }

  async resolvePlannerMaterials(scope: TaskOwnerScope, refs: readonly AttachmentRef[]): Promise<PlannerAttachmentMaterial[]> {
    const claim = await this.store.findDraftClaim(scope, refs)
    if (!claim) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    const session = await this.get(scope, claim.sessionId)
    if (!session) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    const items = refs.map(ref => session.attachments.find(item => item.attachmentId === ref.attachmentId && item.sha256 === ref.sha256)!)
    return items.map(item => ({ attachmentId: item.attachmentId, sha256: item.sha256, displayName: item.displayName, mediaType: item.mediaType, byteLength: item.byteLength, summary: item.extractionSummary || `附件 ${item.displayName}（${item.byteLength} bytes，${item.mediaType}）`, warnings: [...item.warnings] }))
  }

  async releaseDraft(draftId: string): Promise<void> { await this.store.releaseDraft(this.currentScope(), draftId) }
  async stop(): Promise<void> { this.epoch++; this.selectedOriginals.clear() }

  begin(scope: TaskOwnerScope, target: AttachmentImportTarget): Promise<AttachmentImportSession> { return this.store.begin(scope, target) }
  get(scope: TaskOwnerScope, sessionId: string): Promise<AttachmentImportSession | null> { return this.store.get(scope, sessionId) }
  list(scope: TaskOwnerScope): Promise<AttachmentImportSession[]> { return this.store.list(scope) }

  async importFile(scope: TaskOwnerScope, sessionId: string, operationId: string, path: string, source: AttachmentView['importSource'] = 'picker'): Promise<AttachmentImportResult> {
    if (!operationId) throw new Error('ATTACHMENT_OPERATION_REQUIRED')
    const item = await this.store.importPath(scope, sessionId, path, source)
    const session = await this.require(scope, sessionId)
    return { item, session }
  }

  async importImage(scope: TaskOwnerScope, sessionId: string, operationId: string, bytes: Uint8Array, displayName: string, mediaType: string): Promise<AttachmentImportResult> {
    if (!operationId) throw new Error('ATTACHMENT_OPERATION_REQUIRED')
    const item = await this.store.importBytes(scope, sessionId, bytes, displayName, mediaType, 'paste-image')
    const session = await this.require(scope, sessionId)
    return { item, session }
  }

  async remove(scope: TaskOwnerScope, sessionId: string, attachmentId: string, expectedRevision?: number): Promise<AttachmentImportSession> {
    return this.store.remove(scope, sessionId, attachmentId, expectedRevision)
  }

  cancel(scope: TaskOwnerScope, sessionId: string): Promise<boolean> { return this.store.cancel(scope, sessionId) }

  async validateRefs(scope: TaskOwnerScope, sessionId: string, refs: readonly AttachmentRef[]): Promise<AttachmentView[]> {
    const session = await this.require(scope, sessionId)
    const items = refs.map(ref => session.attachments.find(item => item.attachmentId === ref.attachmentId && item.sha256 === ref.sha256))
    if (items.some(item => !item)) throw new Error('ATTACHMENT_REFERENCE_INVALID')
    return items as AttachmentView[]
  }

  private async require(scope: TaskOwnerScope, sessionId: string): Promise<AttachmentImportSession> {
    const session = await this.store.get(scope, sessionId)
    if (!session) throw new Error('ATTACHMENT_SESSION_NOT_FOUND')
    return session
  }
}
