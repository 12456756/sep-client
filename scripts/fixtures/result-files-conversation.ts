import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { MediaStore } from '../../electron/data/media-store'
import { VideoStore } from '../../electron/data/video-store'
import type { GeneratedMediaOutput } from '../../electron/data/result-archive-store'
import { ScopePath } from '../../electron/data/scope-path'
import { inspectMediaImage } from '../../electron/data/media-image'
import type { LocalMediaJob } from '../../electron/domain/media'
import { localVideoJobSchema } from '../../electron/domain/video-media'
import type { TaskOwnerScope } from '../../electron/data/scope-path'
import { MediaService } from '../../electron/service/media-service'
import { MockVideoHostService } from '../../electron/service/mock-video-host-service'
import { videoOutputSchema, videoReceiptSchema } from '../../src/shared/video-media'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'

export async function seedConversationResults(root: string, owner: TaskOwnerScope, image: Uint8Array, video: Uint8Array, generated?: GeneratedMediaOutput) {
  const taskId = 'conversation-test'
  const images = new MediaStore(root)
  const videos = new VideoStore(root, undefined, generated)
  const dimensions = inspectMediaImage(image)
  const imageOutput = { outputId: 'image-output', mime: dimensions.mime, size: image.length,
    width: dimensions.width, height: dimensions.height, sha256: createHash('sha256').update(image).digest('hex'), expiresAt: null }
  const parameters = { aspectRatio: '1:1', count: 2 }
  const requestHash = 'a'.repeat(64)
  const imageJob: LocalMediaJob = {
    version: 1, owner, taskId, jobId: 'image-job', runId: 'old-run', subscriptionId: 'sub', clientRequestId: 'image-request', requestHash,
    input: { profileId: 'image-profile', operation: 'generate', localAssetIds: [], creativeBrief: 'Product', parameters },
    profile: { profileId: 'image-profile', kind: 'image', displayName: 'Product', configVersion: 'v1', operations: ['generate'],
      executionMode: 'async-query', capabilities: { referenceImage: true, cancel: false, recoverByRequestId: false }, allowedAspectRatios: ['1:1'], maxCount: 2 },
    request: { clientRequestId: 'image-request', requestHash, quoteId: 'image-quote', profileId: 'image-profile', configVersion: 'v1',
      operation: 'generate', referenceIds: [], referenceHashes: [], creativeBrief: 'Product', parameters },
    quote: { quoteId: 'image-quote', requestHash, expiresAt: 100, status: 'quoted', amount: '0', currency: 'CNY', authorized: true, budgetAuthorized: true, allowUnknownCost: false },
    approval: 'manual', receiptId: 'image-receipt', submission: 'RECEIPTED', generationStatus: 'PARTIAL_SUCCEEDED', trackingStatus: 'STOPPED',
    saveStatus: 'SAVED', outputs: [imageOutput], outputErrors: [{ index: 1, code: 'CONTENT_REJECTED' }],
    billingStatus: 'SETTLED', nextPollAt: 0, attempts: 1, error: null, createdAt: 1, updatedAt: 2,
  }
  await images.saveJob(owner, imageJob)
  await images.saveJob(owner, { ...imageJob, jobId: 'failed-image-job', clientRequestId: 'failed-image-request', receiptId: 'failed-image-receipt',
    request: { ...imageJob.request, clientRequestId: 'failed-image-request' }, generationStatus: 'FAILED',
    saveStatus: 'PENDING', outputs: [], outputErrors: [{ index: 0, code: 'PROVIDER_BUSY' }] })
  const imageReplayTask = 'conversation-replay-image'
  const videoReplayTask = 'conversation-replay-video'
  await images.saveJob(owner, { ...imageJob, taskId: imageReplayTask, jobId: 'unknown-image-job', clientRequestId: 'unknown-image-request',
    request: { ...imageJob.request, clientRequestId: 'unknown-image-request' }, receiptId: null, submission: 'MAYBE_SENT',
    generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED', saveStatus: 'PENDING', outputs: [], outputErrors: [], error: 'QUERY_UNAVAILABLE' })
  async function* stream(bytes: Uint8Array) { yield bytes }
  const imageAsset = await images.saveOutput(owner, taskId, imageJob.jobId, imageOutput, stream(image), new AbortController().signal)
  const videoScope = { ...owner, subscriptionId: 'sub' }
  const videoJob = localVideoJobSchema.parse({
    version: 1, scope: videoScope, taskId, jobId: 'video-job', request: fixture.request,
    quote: { quoteId: 'video-quote-1', requestHash, expiresAt: 100, status: 'quoted', amount: '0', currency: 'MOCK' },
    submission: 'NOT_SENT', receipt: null, trackingStatus: 'ACTIVE', saveStatus: 'PENDING', error: null, createdAt: 1, updatedAt: 1,
  })
  await videos.createJob(videoScope, videoJob)
  const unknownVideo = localVideoJobSchema.parse({ ...videoJob, taskId: videoReplayTask, jobId: 'unknown-video-job',
    request: { ...videoJob.request, clientRequestId: 'unknown-video-request' } })
  await videos.createJob(videoScope, unknownVideo)
  await videos.updateJob(videoScope, videoReplayTask, unknownVideo.jobId, job => ({ ...job,
    submission: 'MAYBE_SENT', trackingStatus: 'INTERRUPTED', error: 'SUBMISSION_UNKNOWN' }))
  const videoOutput = videoOutputSchema.parse(fixture.output)
  await videos.updateJob(videoScope, taskId, videoJob.jobId, value => ({ ...value, submission: 'RECEIPTED', receipt: videoReceiptSchema.parse({
    ...fixture.receipts.partial, outputs: [videoOutput],
    outputErrors: [{ index: 1, code: 'UPSTREAM_TIMEOUT', message: 'fixture-private-provider-detail' }],
  }) }))
  await videos.saveOutput(videoScope, taskId, videoJob.jobId, videoOutput, stream(video), new AbortController().signal)
  await videos.updateJob(videoScope, taskId, videoJob.jobId, value => ({ ...value, saveStatus: 'SAVED', trackingStatus: 'STOPPED' }))
  const failedVideo = localVideoJobSchema.parse({ ...videoJob, jobId: 'failed-video-job',
    request: { ...videoJob.request, clientRequestId: 'failed-video-request' } })
  await videos.createJob(videoScope, failedVideo)
  await videos.updateJob(videoScope, taskId, failedVideo.jobId, value => ({ ...value, submission: 'RECEIPTED', trackingStatus: 'STOPPED',
    receipt: videoReceiptSchema.parse({ ...fixture.receipts.failed, receiptId: 'failed-video-receipt', clientRequestId: failedVideo.request.clientRequestId,
      errorCode: 'UPSTREAM_FAILED', outputErrors: [],
      upstreamError: { status: 200, body: { error: { code: 'ContentModerationFailed', message: 'fixture-private-provider-detail' } } } }),
  }))
  // Project persisted jobs through production read paths, never authorizing or submitting anything.
  const scope = { currentScope: () => owner }
  const getTask = async (id: string) => [taskId, imageReplayTask, videoReplayTask].includes(id) ? { subscriptionId: 'sub' } : null
  const rejectOnline = () => { throw new Error('Result fixture must not execute media operations') }
  const media = new MediaService({ scope, getTask, store: new MediaStore(root), authorize: rejectOnline, requestApproval: rejectOnline })
  const videoHost = new MockVideoHostService({ mock: true, scope, getTask, store: videos,
    localRuntime: () => fixture.runtime, authorize: rejectOnline, authorizationRevision: () => 0,
    readReference: rejectOnline, gateway: () => ({ quote: rejectOnline, submit: rejectOnline, getReceipt: rejectOnline,
      findReceipt: rejectOnline, content: rejectOnline, uploadReference: rejectOnline }),
  })
  return {
    images: await media.getTaskMedia(taskId),
    videos: await videoHost.getTaskVideo(taskId),
    replayImages: await media.getTaskMedia(imageReplayTask),
    replayVideos: await videoHost.getTaskVideo(videoReplayTask),
    imagePath: join(new ScopePath(root).mediaRoot(owner, taskId), imageAsset.relativePath),
    videoPath: await videos.verifiedAssetPath(videoScope, taskId, videoJob.jobId, videoOutput.outputId),
  }
}
