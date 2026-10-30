import { validateDeliveryFiles, type DeliveryFileOptions } from '../data/arrangement-delivery-files'
import { buildDeliveryCorrection, DeliveryExecutionError, parseDeliverySubmission,
  type DeliveryIssue, type DeliverySubmission, type DeliverySubmissionResult, type NodeDeliveryProgress } from '../domain/arrangement-delivery'
import { ArrangementMediaRecoveryError, ArrangementMediaSubmissionError, type ArrangementMediaSession } from '../domain/arrangement-media-runtime'
import type { ArrangementNode } from '../domain/arrangement-plan'
import { runtimeFeedback } from '../errors/runtime-feedback'
import { RUNTIME_FAILURE_MESSAGES } from '../../src/shared/runtime-feedback'
import { retryFileOperation } from '../common/retry-file-operation'

type MediaAssets = Awaited<ReturnType<ArrangementMediaSession['artifactSummary']>>
type ValidationStage = 'media-wait' | 'submission' | 'materialization' | 'files' | 'decision'
type Accepted = { status: 'accepted'; submission: DeliverySubmission }
type Failed = { status: 'failed'; stage: ValidationStage; error: unknown }
export type ArrangementDeliveryDecision = Accepted | Failed | { status: 'correction'; continueWith: string }
export type ArrangementDeliveryRecovery = ArrangementDeliveryDecision | { status: 'pending' }

export interface ArrangementDeliveryCheck {
  validationKind: 'submission' | 'files'
  validationAttempts: number
  accepted: boolean
  issues: DeliveryIssue[]
  elapsedMs: number
}

export interface ArrangementDeliveryValidationOptions {
  node: ArrangementNode
  workspaceDir: string
  nodeRunId: string
  signal: AbortSignal
  fileOptions: DeliveryFileOptions
  mediaSession?: ArrangementMediaSession
  getProgress(): NodeDeliveryProgress
  saveProgress(progress: NodeDeliveryProgress): Promise<void>
  checkControl(): void
  waitForMedia(): Promise<void>
  onChecked(check: ArrangementDeliveryCheck): Promise<void>
}

export function buildArrangementDeliveryCorrection(issues: readonly DeliveryIssue[], node: ArrangementNode, mediaAssets?: MediaAssets): string {
  const artifacts = mediaAssets === undefined ? ''
    : `\n【主进程已核验的媒体资产】\n${JSON.stringify(mediaAssets)}\n仅从这些原任务资产选择交付，不等待、不重新生成。`
  return buildDeliveryCorrection(issues, node) + artifacts
}

export function resolveArrangementNodeFailure(error: unknown, interrupted: boolean, terminalMediaFailure: boolean): { message: string; terminal: boolean } {
  const feedback = runtimeFeedback(error)
  return {
    message: interrupted ? '工作已停止' : error instanceof DeliveryExecutionError && feedback.code === 'INTERNAL_ERROR'
      ? RUNTIME_FAILURE_MESSAGES.DELIVERY_FAILED : feedback.message,
    terminal: (error instanceof DeliveryExecutionError || terminalMediaFailure) && !interrupted,
  }
}

/** One coordinator for delivery checks, correction decisions and recovery. Checks remain in their owning layers. */
export class ArrangementDeliveryValidation {
  private stage: ValidationStage = 'media-wait'

  constructor(private readonly options: ArrangementDeliveryValidationOptions) {}

  async settle(response: { text: string; stopReason?: string }): Promise<ArrangementDeliveryDecision> {
    try {
      await this.waitForMedia()
      await this.save({ ...this.progress, validationAttempts: this.progress.validationAttempts + 1, finalFiles: [], summary: undefined })
      this.stage = 'submission'
      let parsed = parseDeliverySubmission(this.options.node, response.text, response.stopReason)
      if (!parsed.ok && this.options.mediaSession && (!response.stopReason || response.stopReason === 'stop')) {
        const automatic = await this.options.mediaSession.automaticSubmission()
        if (automatic) parsed = parseDeliverySubmission(this.options.node, JSON.stringify(automatic))
      }
      await this.savePendingSubmission(parsed)
      const checked = await this.inspect(parsed)
      this.checkControl()
      let accepted: DeliverySubmission | undefined
      if (checked.result.ok && parsed.ok) {
        accepted = parsed.submission
        await this.accept(parsed.submission, checked)
      } else {
        await this.save({ ...this.progress, issues: checked.result.ok ? [] : checked.result.issues, pendingSubmission: undefined })
      }
      await this.options.onChecked({ validationKind: parsed.ok ? 'files' : 'submission', validationAttempts: this.progress.validationAttempts,
        accepted: accepted !== undefined, issues: this.progress.issues, elapsedMs: Date.now() - checked.validationStartedAt })
      if (accepted) return { status: 'accepted', submission: accepted }
      return await this.correct()
    } catch (error) {
      return { status: 'failed', stage: this.stage, error }
    }
  }

  async resume(): Promise<ArrangementDeliveryRecovery> {
    try {
      await this.waitForMedia()
      this.stage = 'submission'
      const submission = this.progress.pendingSubmission ?? await this.options.mediaSession?.automaticSubmission()
      if (!submission) return { status: 'pending' }
      const parsed = parseDeliverySubmission(this.options.node, JSON.stringify(submission))
      await this.savePendingSubmission(parsed)
      const checked = await this.inspect(parsed)
      if (!checked.result.ok || !parsed.ok) {
        await this.save({ ...this.progress, issues: checked.result.ok ? [] : checked.result.issues, pendingSubmission: undefined })
        return await this.correct()
      }
      this.checkControl()
      await this.accept(parsed.submission, checked)
      return { status: 'accepted', submission: parsed.submission }
    } catch (error) {
      return { status: 'failed', stage: this.stage, error }
    }
  }

  private get progress(): NodeDeliveryProgress { return this.options.getProgress() }
  private save(progress: NodeDeliveryProgress): Promise<void> { return this.options.saveProgress(progress) }

  private checkControl(): void {
    this.options.checkControl()
    this.options.signal.throwIfAborted()
  }

  private async waitForMedia(): Promise<void> {
    this.stage = 'media-wait'
    this.checkControl()
    if (this.options.mediaSession) await this.save({ ...this.progress, mediaPhase: 'waiting-media', mediaWaitStartedAt: this.progress.mediaWaitStartedAt ?? Date.now() })
    await this.options.waitForMedia()
    this.checkControl()
  }

  private async savePendingSubmission(parsed: DeliverySubmissionResult): Promise<void> {
    if (parsed.ok && this.options.mediaSession) await this.save({ ...this.progress, pendingSubmission: parsed.submission, mediaPhase: 'materializing' })
  }

  private async inspect(parsed: DeliverySubmissionResult) {
    const materializeStartedAt = Date.now()
    let validationStartedAt = materializeStartedAt
    const result = await (async () => {
      try {
        this.stage = 'materialization'
        const mediaFiles = parsed.ok && this.options.mediaSession
          ? await retryFileOperation(() => this.options.mediaSession!.materialize(parsed.submission), this.options.signal) : undefined
        this.stage = 'files'
        validationStartedAt = Date.now()
        return parsed.ok
          ? await validateDeliveryFiles(this.options.workspaceDir, this.options.node, parsed.submission, this.options.nodeRunId,
            this.options.signal, { ...this.options.fileOptions, mediaFiles })
          : parsed
      } catch (error) {
        if (!(error instanceof ArrangementMediaSubmissionError)) {
          this.checkControl()
          if (this.options.mediaSession && this.stage === 'materialization' && runtimeFeedback(error).code === 'INTERNAL_ERROR') throw new ArrangementMediaRecoveryError('copy', error)
          throw error
        }
        return { ok: false as const, issues: [{ code: 'MEDIA_DELIVERY_MANIFEST_MISMATCH', message: error.message }] }
      }
    })()
    return { result, materializeStartedAt, validationStartedAt }
  }

  private async accept(submission: DeliverySubmission, checked: Awaited<ReturnType<ArrangementDeliveryValidation['inspect']>>): Promise<void> {
    if (!checked.result.ok) return
    await this.save({ ...this.progress, issues: [], finalFiles: checked.result.files, summary: submission.summary, pendingSubmission: undefined,
      ...(this.options.mediaSession ? { mediaPhase: 'delivered' as const,
        materializeMs: checked.validationStartedAt - checked.materializeStartedAt, deliveryMs: Date.now() - checked.validationStartedAt } : {}) })
  }

  private async correct(): Promise<ArrangementDeliveryDecision> {
    this.stage = 'decision'
    if (this.progress.issues.some(issue => ['ENOSPC', 'EACCES', 'EPERM', 'EIO'].includes(issue.code))) {
      return { status: 'failed', stage: 'files', error: new Error(RUNTIME_FAILURE_MESSAGES.STORAGE_FAILED) }
    }
    const mediaAssets = await this.options.mediaSession?.artifactSummary()
    return { status: 'correction', continueWith: buildArrangementDeliveryCorrection(this.progress.issues, this.options.node, mediaAssets) }
  }
}
