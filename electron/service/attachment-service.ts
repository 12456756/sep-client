import type { AttachmentImportSession, AttachmentImportTarget, AttachmentRef, AttachmentView } from '../../src/shared/attachment-contracts'
import type { InputSnapshotRef as SharedInputSnapshotRef } from '../../src/shared/attachment-contracts'
import type { TaskOwnerScope } from '../data/scope-path'
import { AttachmentStore } from '../data/attachment-store'
import type { AttachmentStorePort } from '../data/attachment-store'
import { createHash } from 'node:crypto'
import type { AttachmentExtractor } from '../domain/attachment-extraction'
import type { ResolvedAttachmentInput } from '../domain/attachment-input'


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
  constructor(private readonly store: AttachmentStorePort, private readonly scopeProvider?: () => TaskOwnerScope | null) {}

  static fromUserData(userDataDir: string, scopeProvider?: () => TaskOwnerScope | null, extractor?: AttachmentExtractor): AttachmentService { return new AttachmentService(new AttachmentStore(userDataDir, undefined, extractor), scopeProvider) }

  private currentScope(): TaskOwnerScope {
    const scope = this.scopeProvider?.()
    if (!scope) throw new Error('AUTH_REQUIRED')
    return scope
  }

  beginSession(target: AttachmentImportTarget): Promise<AttachmentImportSession> { return this.begin(this.currentScope(), target) }
  listSession(sessionId: string): Promise<AttachmentImportSession | null> { return this.get(this.currentScope(), sessionId) }
  importFiles(sessionId: string, operationId: string, paths: readonly string[], source: AttachmentView['importSource'] = 'picker'): Promise<AttachmentImportResult[]> {
    const scope = this.currentScope()
    return Promise.all(paths.map(path => this.importFile(scope, sessionId, operationId, path, source)))
  }
  importImageForSession(sessionId: string, operationId: string, bytes: Uint8Array, displayName: string, mediaType: string): Promise<AttachmentImportResult> { return this.importImage(this.currentScope(), sessionId, operationId, bytes, displayName, mediaType) }
  removeFromSession(sessionId: string, attachmentId: string, expectedRevision?: number): Promise<AttachmentImportSession> { return this.remove(this.currentScope(), sessionId, attachmentId, expectedRevision) }
  cancelSession(sessionId: string): Promise<boolean> { return this.cancel(this.currentScope(), sessionId) }

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

  async latestTaskSnapshot(scope: TaskOwnerScope, taskId: string): Promise<InputSnapshotRef | null> {
    return this.store.readTaskSnapshot(scope, taskId)
  }

  async resolveTaskInputs(scope: TaskOwnerScope, taskId: string, inputRefs: readonly (AttachmentRef | { kind: string; attachment?: AttachmentRef })[]): Promise<{ attachments: ResolvedAttachmentInput[]; images: Array<ResolvedAttachmentInput & { bytes: Uint8Array }>; digest: string }> {
    const refs = inputRefs.flatMap(ref => 'attachmentId' in ref ? [ref] : ref.kind === 'attachment' && ref.attachment ? [ref.attachment] : [])
    const metadata = await this.store.readTaskMetadata(scope, taskId)
    const attachments = refs.map(ref => {
      const item = metadata.items.find(candidate => candidate.attachmentId === ref.attachmentId && candidate.sha256 === ref.sha256)
      if (!item) throw new Error('ATTACHMENT_REFERENCE_INVALID')
      return { attachmentId: item.attachmentId, sha256: item.sha256, displayName: item.displayName, mediaType: item.mediaType, byteLength: item.byteLength, width: item.width, height: item.height, extractionStatus: item.extractionStatus, extractedText: metadata.extractionTextById[item.attachmentId], readPath: this.store.taskReadPath?.(scope, taskId, item.attachmentId) } satisfies ResolvedAttachmentInput
    })
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
  async stop(): Promise<void> {}

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
