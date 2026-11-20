import type { ArrangementDiagnosticStore } from '../data/arrangement-diagnostic-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { MAX_DIAGNOSTIC_JOBS, type DiagnosticMediaEvidence, type DiagnosticMediaJob, type WorkDiagnosticCapture, type WorkDiagnosticRequest } from '../domain/arrangement-diagnostic'
import { missingImageTargetFailure, type LocalMediaJob } from '../domain/media'
import { videoSubmissionRejected, type LocalVideoJob } from '../domain/video-media'
import type { MediaFailure } from '../../src/shared/media-failure'
import { captureDiagnosticException, pickDiagnosticEvidence, workApiDiagnostic, workDiagnosticText } from '../errors/arrangement-diagnostic'
import { AppError } from '../errors/app-error'
import { withTimeout } from '../common/with-timeout'
import { requireScope, type ScopeSource } from './scope-guard'

interface MediaDiagnosticContext {
  subscriptionId: string
  recoveredJobIds?: readonly string[]
  videoJobIds?: readonly string[]
}

export interface WorkFailureCapture {
  record(owner: TaskOwnerScope, input: WorkDiagnosticCapture, media?: MediaDiagnosticContext): Promise<void>
}

function failureDetail(failure?: MediaFailure): MediaFailure | undefined {
  if (!failure) return undefined
  return { ...failure, message: workDiagnosticText(failure.message, 1000), diagnostic: workApiDiagnostic(failure.diagnostic) }
}

function mediaJobEvidence(job: LocalMediaJob | LocalVideoJob, runId: string): Omit<DiagnosticMediaJob, 'submission'> {
  const failure = job.failure ?? job.submissionFailure
  const image = 'generationStatus' in job ? job : undefined
  const video = 'receipt' in job ? job : undefined
  const receipt = video?.receipt
  const upstream = image?.upstreamError ?? receipt?.upstreamError
  const outputErrors = image?.outputErrors ?? receipt?.outputErrors
  return {
    jobId: job.jobId, runId: job.runId, association: job.runId === runId ? 'run' : 'recovery', localSubmission: job.submission,
    clientRequestId: workDiagnosticText(image?.clientRequestId ?? video?.request?.clientRequestId),
    receiptId: workDiagnosticText(image?.receiptId ?? receipt?.receiptId) ?? null,
    status: image?.generationStatus ?? receipt?.status, saveStatus: job.saveStatus, trackingStatus: job.trackingStatus,
    billingStatus: workDiagnosticText(image?.billingStatus || receipt?.billingStatus), executionMode: video?.executionMode,
    errorCode: workDiagnosticText(image?.errorCode ?? receipt?.errorCode), error: workDiagnosticText(job.error), failureStage: failure?.stage,
    failure: pickDiagnosticEvidence({ code: failure?.gatewayCode ?? failure?.businessCode ?? failure?.code,
      requestId: failure?.requestId ?? failure?.diagnostic?.sepRequestId, httpStatus: failure?.httpStatus }),
    failureDetail: failureDetail(job.failure), submissionFailure: failureDetail(job.submissionFailure),
    diagnosticErrors: job.diagnosticErrors,
    upstreamError: upstream && workApiDiagnostic({ httpStatus: upstream.status, body: upstream.body, headers: upstream.headers }),
    specFailure: video?.specFailure,
    outputErrors: outputErrors?.slice(0, 64).map(({ index, code }) => ({ index, code: workDiagnosticText(code)! })),
    outputErrorCount: outputErrors?.length, outputCount: image?.outputs?.length ?? receipt?.outputs?.length,
    createdAt: job.createdAt, updatedAt: job.updatedAt, lastQueriedAt: job.lastQueriedAt,
    providerWaitMs: job.providerWaitMs, downloadMs: job.downloadMs, nextPollAt: image?.nextPollAt, attempts: image?.attempts,
  }
}

function summarizeImageJob(job: LocalMediaJob, runId: string): DiagnosticMediaJob {
  return { ...mediaJobEvidence(job, runId), submission: job.submission === 'NOT_SENT' ? 'NOT_SUBMITTED'
    : missingImageTargetFailure(job) ? 'REJECTED'
      : job.submission === 'MAYBE_SENT' || job.generationStatus === 'SUBMISSION_UNKNOWN' ? 'SUBMISSION_UNKNOWN' : 'SUBMITTED' }
}

function summarizeVideoJob(job: LocalVideoJob, runId: string): DiagnosticMediaJob {
  return { ...mediaJobEvidence(job, runId), submission: job.submission === 'NOT_SENT' ? 'NOT_SUBMITTED' : videoSubmissionRejected(job) ? 'REJECTED'
    : job.submission === 'MAYBE_SENT' || job.receipt?.status === 'SUBMISSION_UNKNOWN' ? 'SUBMISSION_UNKNOWN' : 'SUBMITTED' }
}

async function observeMedia<T extends LocalMediaJob | LocalVideoJob>(
  source: NonNullable<DiagnosticMediaEvidence['source']>, runId: string, recovered: readonly string[],
  lookup: (() => Promise<T[]>) | undefined, summarize: (job: T, runId: string) => DiagnosticMediaJob,
): Promise<DiagnosticMediaEvidence> {
  if (!lookup) return { evidence: 'not-applicable', jobs: [] }
  try {
    const jobs = await withTimeout(Promise.resolve().then(lookup), 1_000, 'local media diagnostic lookup')
    const ids = new Set(recovered)
    const relevant = jobs.filter(job => job.runId === runId || ids.has(job.jobId)).sort((a, b) => b.updatedAt - a.updatedAt)
    return { source, observedAt: Date.now(), evidence: relevant.length ? 'local-jobs' : 'no-local-job', jobCount: relevant.length,
      jobs: relevant.slice(0, MAX_DIAGNOSTIC_JOBS).map(job => summarize(job, runId)) }
  } catch (error) {
    return { source, observedAt: Date.now(), evidence: 'unavailable', jobs: [], lookupError: captureDiagnosticException(error) }
  }
}

export class ArrangementDiagnosticService implements WorkFailureCapture {
  constructor(private readonly options: {
    scope: ScopeSource; authorizationRevision(): number; clientVersion: string
    store: Pick<ArrangementDiagnosticStore, 'get' | 'save' | 'exportFile'>
    listImageJobs?: (owner: TaskOwnerScope, taskId: string) => Promise<LocalMediaJob[]>
    listVideoJobs?: (owner: TaskOwnerScope, taskId: string, subscriptionId: string) => Promise<LocalVideoJob[]>
  }) {}

  async record(owner: TaskOwnerScope, input: WorkDiagnosticCapture, media?: MediaDiagnosticContext): Promise<void> {
    const runId = 'runId' in input ? input.runId : input.nodeRunId
    const { listImageJobs, listVideoJobs } = this.options
    const [image, video] = await Promise.all([
      observeMedia('failure-time', runId, media?.recoveredJobIds ?? [], listImageJobs && (async () => {
        const jobs = await listImageJobs(owner, input.taskId)
        return media ? jobs.filter(job => job.subscriptionId === media.subscriptionId) : jobs
      }), summarizeImageJob),
      observeMedia('failure-time', runId, [...(media?.recoveredJobIds ?? []), ...(media?.videoJobIds ?? [])],
        listVideoJobs && media && (() => listVideoJobs(owner, input.taskId, media.subscriptionId)), summarizeVideoJob),
    ])
    await this.options.store.save(owner, { ...input, version: 1, clientVersion: this.options.clientVersion, image, video })
  }

  async export(input: WorkDiagnosticRequest, chooseFile: (name: string) => Promise<string | null>): Promise<boolean> {
    const owner = requireScope(this.options.scope)
    const revision = this.options.authorizationRevision()
    const assertOwner = () => {
      const current = requireScope(this.options.scope)
      if (revision !== this.options.authorizationRevision() || owner.memberId !== current.memberId || owner.enterpriseId !== current.enterpriseId) {
        throw new AppError('AUTH_REQUIRED')
      }
    }
    const diagnostic = await this.options.store.get(owner, input)
    assertOwner()
    if (!diagnostic) throw new AppError('NOT_FOUND', { message: '没有找到本次失败的诊断记录。' })
    const runId = 'runId' in input ? input.runId : input.nodeRunId
    const target = await chooseFile(`work-diagnostic-${runId}.json`)
    if (!target) return false
    assertOwner()
    // Older builds did not record images. Never replace a failure-time snapshot with later state.
    let output = diagnostic
    const listImageJobs = this.options.listImageJobs
    if (!diagnostic.image && listImageJobs) {
      const image = await observeMedia('export-time', runId, [], () => listImageJobs(owner, input.taskId), summarizeImageJob)
      output = { ...diagnostic, image }
      assertOwner()
    }
    await this.options.store.exportFile(target, output)
    return true
  }
}
