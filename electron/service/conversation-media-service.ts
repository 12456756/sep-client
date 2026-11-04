import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { videoToolGenerationInputSchema, videoToolJobInputSchema, type VideoReferenceSource } from '../../src/shared/video-host'
import type { ConversationMediaPort } from '../domain/conversation-media'
import type { ArrangementMediaAssetsPort } from '../domain/arrangement-media-runtime'
import type { MediaStorePort } from '../domain/media'
import type { MediaRunPort } from '../domain/media-tools'
import type { VideoHostTools } from '../domain/video-tools'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

export interface ConversationMediaServiceOptions {
  scope: ScopeSource
  images: Pick<MediaStorePort, 'listAssets' | 'getAsset'>
  assets: Pick<ArrangementMediaAssetsPort, 'attachmentReference' | 'reference'>
  media: Pick<MediaRunPort, 'waitForRun'>
  getTask(taskId: string): Promise<{ subscriptionId?: string | null } | null>
}

/** Reference conversion is local; authorization, uploads and billing stay video-host-owned. */
export class ConversationMediaService implements ConversationMediaPort {
  constructor(private readonly options: ConversationMediaServiceOptions) {}

  async prepareRun(input: Parameters<ConversationMediaPort['prepareRun']>[0]): Promise<VideoHostTools> {
    const scope = structuredClone(requireScope(this.options.scope))
    const validate = () => {
      input.signal.throwIfAborted()
      if (!isDeepStrictEqual(scope, requireScope(this.options.scope))) throw new AppError('AUTH_REQUIRED')
    }
    validate()
    const task = await this.options.getTask(input.taskId)
    validate()
    if (!task) throw new AppError('NOT_FOUND')
    const check = async () => {
      validate()
      const current = await this.options.getTask(input.taskId)
      validate()
      if (!current || current.subscriptionId !== task.subscriptionId) throw new AppError('AUTH_REQUIRED')
    }
    const sources: VideoReferenceSource[] = []
    for (const attachment of input.attachments) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mediaType)) continue
      await check()
      if (!this.options.assets.attachmentReference) throw new AppError('SERVICE_UNAVAILABLE')
      const reference = await this.options.assets.attachmentReference(scope, input.taskId, attachment, input.signal, validate)
      await check()
      sources.push({ localAssetId: reference.artifactId, source: 'attachment', attachmentId: attachment.attachmentId,
        displayName: attachment.displayName })
    }
    const generated = new Map<string, VideoReferenceSource>()
    const reference = async (id: string, signal: AbortSignal): Promise<string> => {
      signal.throwIfAborted()
      await check()
      const asset = await this.options.images.getAsset(scope, input.taskId, id)
      signal.throwIfAborted()
      await check()
      if (!asset || asset.status !== 'SAVED') throw new AppError('NOT_FOUND')
      if (asset.source === 'reference') return asset.localAssetId
      const converted = await this.options.assets.reference(scope, input.taskId, id, signal, validate)
      signal.throwIfAborted()
      await check()
      generated.set(id, { localAssetId: converted.artifactId, source: 'generated', sourceArtifactId: id,
        ...(asset.jobId ? { jobId: asset.jobId } : {}), ...(asset.outputId ? { outputId: asset.outputId } : {}) })
      return converted.artifactId
    }
    return { names: input.video.names, execute: async (name, raw, parent) => {
      const signal = parent ? AbortSignal.any([input.signal, parent]) : input.signal
      signal.throwIfAborted()
      await check()
      if (!input.video.names.includes(name)) throw new AppError('PERMISSION_DENIED')
      let args = raw
      const query = name === 'video_get_job' ? videoToolJobInputSchema.parse(raw) : undefined
      if (query && !query.jobId) {
        // A generation tool may return before its asynchronous image download finishes.
        await this.options.media.waitForRun(input.taskId, input.runId, { signal })
        signal.throwIfAborted()
        await check()
        const assets = await this.options.images.listAssets(scope, input.taskId)
        signal.throwIfAborted()
        await check()
        for (const asset of assets) {
          if (asset.source === 'output' && asset.status === 'SAVED' && !generated.has(asset.localAssetId)) {
            await reference(asset.localAssetId, signal)
          }
        }
      } else if (name === 'video_from_image') {
        const parsed = videoToolGenerationInputSchema.parse(raw)
        const ids: string[] = []
        for (const id of parsed.localAssetIds) ids.push(await reference(id, signal))
        args = { ...parsed, localAssetIds: ids }
      }
      signal.throwIfAborted()
      await check()
      const result = await input.video.execute(name, args, signal)
      signal.throwIfAborted()
      await check()
      if (!query || query.jobId) return result
      const view = z.object({ referenceAssets: z.array(z.object({ localAssetId: z.string(), status: z.string() }).passthrough()).optional() }).passthrough().parse(result)
      const available = new Set(view.referenceAssets?.filter(asset => asset.status === 'SAVED').map(asset => asset.localAssetId))
      return { ...view, referenceSources: [...sources, ...generated.values()].filter(source => available.has(source.localAssetId)) }
    } }
  }
}
