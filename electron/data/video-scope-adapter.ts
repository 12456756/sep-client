import { createHash } from 'node:crypto'
import type { MediaAssetView } from '../../src/shared/media'
import type { LocalMediaAsset } from '../domain/media'
import type { VideoScope } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import type { MediaStore } from './media-store'
import type { VideoStore } from './video-store'
import { exportVideoBytes } from './native-video-export'

/** MediaStore owns references by member, never by video subscription. */
const owner = (scope: VideoScope) => ({ enterpriseId: scope.enterpriseId, memberId: scope.memberId })
const view = (asset: LocalMediaAsset): MediaAssetView => ({
  localAssetId: asset.localAssetId, taskId: asset.taskId, jobId: null, outputId: null, source: 'reference',
  mime: asset.mime, size: asset.size, width: asset.width, height: asset.height, status: asset.status,
})

export function createVideoScopeAdapter(root: string, media: MediaStore, store: VideoStore, openLocalVideo?: (path: string) => Promise<void>) {
  return {
    openOutput: async (scope: VideoScope, taskId: string, jobId: string, outputId: string, signal: AbortSignal, validate: () => void) => {
      if (!openLocalVideo) throw new AppError('SERVICE_UNAVAILABLE')
      signal.throwIfAborted(); validate()
      const path = await store.verifiedAssetPath(scope, taskId, jobId, outputId)
      signal.throwIfAborted(); validate()
      await openLocalVideo(path)
      signal.throwIfAborted(); validate()
    },
    readReference: async (scope: VideoScope, taskId: string, id: string) => {
      const asset = await media.getAsset(owner(scope), taskId, id)
      if (!asset || asset.source !== 'reference' || asset.status !== 'SAVED') throw new AppError('NOT_FOUND')
      const bytes = await media.readAsset(owner(scope), taskId, id)
      if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new AppError('INVALID_STATE')
      return { bytes, sha256: asset.sha256 }
    },
    references: {
      list: async (scope: VideoScope, taskId: string) => (await media.listAssets(owner(scope), taskId)).filter(asset => asset.source === 'reference').map(view),
      import: async (scope: VideoScope, taskId: string, paths: readonly string[], signal: AbortSignal, validate: () => void) => {
        const assets: MediaAssetView[] = []
        for (const path of paths) {
          signal.throwIfAborted(); validate()
          assets.push(view(await media.importReference(owner(scope), taskId, path, signal, validate)))
        }
        validate()
        return assets
      },
    },
    exportOutput: async (scope: VideoScope, taskId: string, jobId: string, outputId: string, path: string, signal: AbortSignal, validate: () => void) => {
      const bytes = await store.readAsset(scope, taskId, jobId, outputId)
      await exportVideoBytes(root, path, bytes, signal, validate)
    },
  }
}
