import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { videoToolGenerationInputSchema, videoToolJobInputSchema } from '../../src/shared/video-host'
import { mediaToolGenerationInputSchema, mediaUnconfirmedJobsSchema, type MediaReferenceSource } from '../../src/shared/media-host'
import type { ConversationMediaPort } from '../domain/conversation-media'
import type { ArrangementMediaAssetsPort } from '../domain/arrangement-media-runtime'
import type { MediaStorePort } from '../domain/media'
import type { MediaRunPort } from '../domain/media-tools'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

export interface ConversationMediaServiceOptions {
  scope: ScopeSource
  images: Pick<MediaStorePort, 'listAssets' | 'getAsset'>
  assets: Pick<ArrangementMediaAssetsPort, 'attachmentReference' | 'reference'>
  media: Pick<MediaRunPort, 'waitForRun'>
  getTask(taskId: string): Promise<{ subscriptionId?: string | null } | null>
}

/** Reference conversion is local; authorization, uploads and billing stay host-owned. */
export class ConversationMediaService implements ConversationMediaPort {
  constructor(private readonly options: ConversationMediaServiceOptions) {}

  async prepareRun(input: Parameters<ConversationMediaPort['prepareRun']>[0]): ReturnType<ConversationMediaPort['prepareRun']> {
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
    const sources = new Map<string, MediaReferenceSource>()
    const addAttachment = async (attachment: (typeof input.attachments)[number], signal: AbortSignal) => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mediaType)) return
      await check()
      if (!this.options.assets.attachmentReference) throw new AppError('SERVICE_UNAVAILABLE')
      const reference = await this.options.assets.attachmentReference(scope, input.taskId, attachment, signal, validate)
      signal.throwIfAborted()
      await check()
      sources.set(attachment.attachmentId, { localAssetId: reference.artifactId, source: 'attachment', attachmentId: attachment.attachmentId,
        displayName: attachment.displayName })
    }
    for (const attachment of input.attachments) await addAttachment(attachment, input.signal)
    const discovered = new Set(input.attachments.map(attachment => attachment.attachmentId))
    const discoverAttachments = async (signal: AbortSignal) => {
      for (const attachment of input.historicalAttachments ?? []) {
        if (discovered.has(attachment.attachmentId)) continue
        try { await addAttachment(attachment, signal) }
        catch (error) {
          signal.throwIfAborted()
          await check()
          if (error instanceof AppError) throw error
          // An old missing or damaged snapshot must not hide other usable references.
          continue
        }
        discovered.add(attachment.attachmentId)
      }
    }
    const generated = new Map<string, MediaReferenceSource>()
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
    const discoverGenerated = async (signal: AbortSignal) => {
      await discoverAttachments(signal)
      // Capability discovery can still use saved outputs when another image failed or remains unconfirmed.
      await this.options.media.waitForRun(input.taskId, input.runId, { allowIncomplete: true, signal })
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
    }
    const media = input.media
    const video = input.video
    return {
      media: media ? { names: media.names, execute: async (name, raw, parent) => {
        const signal = parent ? AbortSignal.any([input.signal, parent]) : input.signal
        signal.throwIfAborted()
        await check()
        if (!media.names.includes(name)) throw new AppError('PERMISSION_DENIED')
        if (name === 'media_generate_image') {
          const parsed = mediaToolGenerationInputSchema.parse(raw)
          const selected = parsed.localAssetIds ?? []
          const operation = parsed.operation ?? (selected.length ? 'edit' : 'generate')
          if (operation === 'edit' && selected.length === 0) throw new AppError('INVALID_ARGUMENT', {
            message: '图生图请通过 localAssetIds 明确选择参考图片并保留顺序；候选来源不明确时先询问用户。',
          })
          if (operation === 'generate' && selected.length) throw new AppError('INVALID_ARGUMENT', {
            message: '使用参考图修改图片请指定 operation=edit；文生图不应传入参考图。',
          })
          const ids: string[] = []
          for (const id of selected) ids.push(await reference(id, signal))
          await check()
          const result = await media.execute(name, { ...parsed, operation, localAssetIds: ids }, signal)
          signal.throwIfAborted()
          await check()
          return result
        }
        if (name === 'media_get_capabilities') await discoverGenerated(signal)
        const result = await media.execute(name, raw, signal)
        signal.throwIfAborted()
        await check()
        if (name !== 'media_get_capabilities') return result
        const view = z.object({ capabilities: z.unknown(), referenceAssets: z.array(z.object({ localAssetId: z.string() }).passthrough()),
          unconfirmedJobs: mediaUnconfirmedJobsSchema.optional() }).parse(result)
        const mappedSources = [...sources.values(), ...generated.values()]
        const ids = new Set([...view.referenceAssets.map(asset => asset.localAssetId), ...mappedSources.map(source => source.localAssetId)])
        const referenceAssets = []
        for (const id of ids) {
          const asset = await this.options.images.getAsset(scope, input.taskId, id)
          signal.throwIfAborted()
          await check()
          if (asset?.source !== 'reference' || asset.status !== 'SAVED') continue
          referenceAssets.push({ localAssetId: asset.localAssetId, taskId: asset.taskId, jobId: asset.jobId, outputId: asset.outputId,
            source: asset.source, mime: asset.mime, size: asset.size, width: asset.width, height: asset.height, status: asset.status })
        }
        const available = new Set(referenceAssets.map(asset => asset.localAssetId))
        return { ...view, referenceAssets, referenceSources: mappedSources.filter(source => available.has(source.localAssetId)) }
      } } : undefined,
      video: video ? { names: video.names, execute: async (name, raw, parent) => {
        const signal = parent ? AbortSignal.any([input.signal, parent]) : input.signal
        signal.throwIfAborted()
        await check()
        if (!video.names.includes(name)) throw new AppError('PERMISSION_DENIED')
        let args = raw
        const query = name === 'video_get_job' ? videoToolJobInputSchema.parse(raw) : undefined
        if (query && !query.jobId) {
          await discoverGenerated(signal)
        } else if (name === 'video_from_image') {
          const parsed = videoToolGenerationInputSchema.parse(raw)
          const ids: string[] = []
          for (const id of parsed.localAssetIds) ids.push(await reference(id, signal))
          args = { ...parsed, localAssetIds: ids }
        }
        signal.throwIfAborted()
        await check()
        const result = await video.execute(name, args, signal)
        signal.throwIfAborted()
        await check()
        if (!query || query.jobId) return result
        const view = z.object({ referenceAssets: z.array(z.object({ localAssetId: z.string(), status: z.string() }).passthrough()).optional() }).passthrough().parse(result)
        const available = new Set(view.referenceAssets?.filter(asset => asset.status === 'SAVED').map(asset => asset.localAssetId))
        return { ...view, referenceSources: [...sources.values(), ...generated.values()].filter(source => available.has(source.localAssetId)) }
      } } : undefined,
    }
  }
}
