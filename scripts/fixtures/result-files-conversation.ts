import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { MediaStore } from '../../electron/data/media-store'
import { VideoStore } from '../../electron/data/video-store'
import { ScopePath } from '../../electron/data/scope-path'
import { inspectMediaImage } from '../../electron/data/media-image'
import type { LocalMediaJob } from '../../electron/domain/media'
import { localVideoJobSchema } from '../../electron/domain/video-media'
import type { TaskOwnerScope } from '../../electron/data/scope-path'
import type { MediaTaskView } from '../../src/shared/media'
import type { VideoTaskView } from '../../src/shared/video-host'
import { videoOutputSchema, videoReceiptSchema, videoRuntimeSchema } from '../../src/shared/video-media'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'

export async function seedConversationResults(root: string, owner: TaskOwnerScope, image: Uint8Array, video: Uint8Array): Promise<{
  images: MediaTaskView
  videos: VideoTaskView
  imagePath: string
  videoPath: string
}> {
  const taskId = 'conversation-test'
  const images = new MediaStore(root)
  const videos = new VideoStore(root)
  const dimensions = inspectMediaImage(image)
  const imageOutput = { outputId: 'image-output', mime: dimensions.mime, size: image.length,
    width: dimensions.width, height: dimensions.height, sha256: createHash('sha256').update(image).digest('hex'), expiresAt: null }
  const parameters = { aspectRatio: '1:1', count: 1 }
  const requestHash = 'a'.repeat(64)
  const imageJob: LocalMediaJob = {
    version: 1, owner, taskId, jobId: 'image-job', runId: 'old-run', subscriptionId: 'sub', clientRequestId: 'image-request', requestHash,
    input: { profileId: 'image-profile', operation: 'generate', localAssetIds: [], creativeBrief: 'Product', parameters },
    profile: { profileId: 'image-profile', kind: 'image', displayName: 'Product', configVersion: 'v1', operations: ['generate'],
      executionMode: 'async-query', capabilities: { referenceImage: true, cancel: false, recoverByRequestId: false }, allowedAspectRatios: ['1:1'], maxCount: 1 },
    request: { clientRequestId: 'image-request', requestHash, quoteId: 'image-quote', profileId: 'image-profile', configVersion: 'v1',
      operation: 'generate', referenceIds: [], referenceHashes: [], creativeBrief: 'Product', parameters },
    quote: { quoteId: 'image-quote', requestHash, expiresAt: 100, status: 'quoted', amount: '0', currency: 'CNY', authorized: true, budgetAuthorized: true, allowUnknownCost: false },
    approval: 'manual', receiptId: 'image-receipt', submission: 'RECEIPTED', generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED',
    saveStatus: 'PENDING', outputs: [imageOutput], billingStatus: 'SETTLED', nextPollAt: 0, attempts: 1, error: null, createdAt: 1, updatedAt: 2,
  }
  await images.saveJob(owner, imageJob)
  async function* stream(bytes: Uint8Array) { yield bytes }
  const imageAsset = await images.saveOutput(owner, taskId, imageJob.jobId, imageOutput, stream(image), new AbortController().signal)
  const videoScope = { ...owner, subscriptionId: 'sub' }
  const videoJob = localVideoJobSchema.parse({
    version: 1, scope: videoScope, taskId, jobId: 'video-job', request: fixture.request,
    quote: { quoteId: 'video-quote-1', requestHash, expiresAt: 100, status: 'quoted', amount: '0', currency: 'MOCK' },
    submission: 'NOT_SENT', receipt: null, trackingStatus: 'ACTIVE', saveStatus: 'PENDING', error: null, createdAt: 1, updatedAt: 1,
  })
  await videos.createJob(videoScope, videoJob)
  const videoOutput = videoOutputSchema.parse(fixture.output)
  await videos.updateJob(videoScope, taskId, videoJob.jobId, value => ({ ...value, submission: 'RECEIPTED', receipt: videoReceiptSchema.parse({
    ...fixture.receipts.succeeded, outputs: [videoOutput],
  }) }))
  await videos.saveOutput(videoScope, taskId, videoJob.jobId, videoOutput, stream(video), new AbortController().signal)
  await videos.updateJob(videoScope, taskId, videoJob.jobId, value => ({ ...value, saveStatus: 'SAVED', trackingStatus: 'STOPPED' }))
  // Reopen the stores to exercise persisted historical outputs rather than live generation state.
  const reopenedImage = await new MediaStore(root).getAsset(owner, taskId, imageAsset.localAssetId)
  if (!reopenedImage) throw new Error('Historical image fixture missing')
  return {
    images: { capabilities: null, unavailableReason: null, assets: [reopenedImage], selectedReferenceIds: [], jobs: [], archived: false },
    videos: { mock: true, runtime: videoRuntimeSchema.parse(fixture.runtime), jobs: [{
      jobId: videoJob.jobId, taskId, profileId: videoJob.request.profileId, operation: videoJob.request.operation,
      parameters: videoJob.request.parameters, generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVED',
      billingStatus: 'MOCK_NOT_CHARGED', outputs: [videoOutput], savedOutputIds: [videoOutput.outputId], error: null, createdAt: 1, updatedAt: 2,
    }] },
    imagePath: join(new ScopePath(root).mediaRoot(owner, taskId), imageAsset.relativePath),
    videoPath: await new VideoStore(root).verifiedAssetPath(videoScope, taskId, videoJob.jobId, videoOutput.outputId),
  }
}
