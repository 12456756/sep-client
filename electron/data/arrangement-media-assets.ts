import { createReadStream } from 'node:fs'
import type { ArrangementMediaAssetsPort, ArrangementMediaAsset } from '../domain/arrangement-media-runtime'
import type { ArrangementMediaLink } from '../domain/arrangement-media'
import type { TaskOwnerScope } from './scope-path'
import { ScopePath } from './scope-path'
import type { MediaStore } from './media-store'
import type { VideoStore } from './video-store'
import { materializeArrangementMedia, type ArrangementMediaSource } from './arrangement-media-files'
import type { AttachmentInputPort } from '../domain/attachment-input'
import type { AttachmentRef } from '../../src/shared/attachment-contracts'

/** Only this adapter translates scoped media identities into file streams. */
export class ArrangementMediaAssets implements ArrangementMediaAssetsPort {
  private readonly paths: ScopePath
  constructor(root: string, private readonly images: MediaStore, private readonly videos?: VideoStore, private readonly attachments?: AttachmentInputPort) { this.paths = new ScopePath(root) }

  async attachmentReference(scope: TaskOwnerScope, taskId: string, ref: AttachmentRef, signal: AbortSignal, validate: () => void) {
    signal.throwIfAborted(); validate()
    const resolved = await this.attachments?.resolveTaskInputs(scope, taskId, [ref])
    const original = resolved?.attachments.find(item => item.attachmentId === ref.attachmentId && item.sha256 === ref.sha256)
    if (!original?.readPath || !['image/png', 'image/jpeg', 'image/webp'].includes(original.mediaType)) throw new Error('媒体输入必须是已归属本任务的图片附件。')
    signal.throwIfAborted(); validate()
    const reference = await this.images.importReference(scope, taskId, original.readPath, signal, validate)
    if (reference.sha256 !== ref.sha256) throw new Error('附件内容与媒体参考图不一致。')
    signal.throwIfAborted(); validate()
    return { artifactId: reference.localAssetId, sha256: reference.sha256 }
  }

  async outputs(scope: TaskOwnerScope, taskId: string, link: ArrangementMediaLink): Promise<ArrangementMediaAsset[]> {
    if (link.kind === 'image') return (await this.images.listAssets(scope, taskId))
      .filter(asset => asset.source === 'output' && asset.jobId === link.jobId)
      .map(asset => ({ artifactId: asset.localAssetId, kind: 'image', sha256: asset.sha256, size: asset.size, mime: asset.mime,
        status: asset.status === 'SAVED' ? 'saved' : 'missing' }))
    return (await this.videos?.listAssets({ ...scope, subscriptionId: link.subscriptionId }, taskId) ?? [])
      .filter(asset => asset.jobId === link.jobId)
      .map(asset => ({ artifactId: asset.localAssetId, kind: 'video', sha256: asset.output.sha256.toLowerCase(), size: asset.output.byteLength,
        mime: asset.output.mimeType, status: asset.status === 'SAVED' ? 'saved' : 'missing' }))
  }

  async reference(scope: TaskOwnerScope, taskId: string, artifactId: string, signal: AbortSignal, validate: () => void) {
    const original = await this.images.getAsset(scope, taskId, artifactId)
    signal.throwIfAborted(); validate()
    if (!original || original.status !== 'SAVED') throw new Error('媒体输入不存在或尚未保存。')
    const reference = original.source === 'output'
      ? await this.images.deriveReferenceFromOutput(scope, taskId, artifactId, signal, validate) : original
    return { artifactId: reference.localAssetId, sha256: reference.sha256 }
  }

  async materialize(...args: Parameters<ArrangementMediaAssetsPort['materialize']>) {
    const [scope, taskId, workspace, deliverable, link, artifactId, nodeRunId, signal, validate] = args
    const asset = (await this.outputs(scope, taskId, link)).find(item => item.artifactId === artifactId && item.status === 'saved')
    if (!asset) throw new Error('媒体输出不存在或尚未保存，请恢复原媒体任务。')
    let stream: ArrangementMediaSource['stream']
    if (asset.kind === 'image') {
      const bytes = await this.images.readAsset(scope, taskId, artifactId)
      stream = async function* () { yield bytes }
    } else {
      const videoScope = { ...scope, subscriptionId: link.subscriptionId }
      const output = (await this.videos!.listAssets(videoScope, taskId)).find(item => item.localAssetId === artifactId)
      if (!output || output.jobId !== link.jobId) throw new Error('视频来源与编排节点不一致。')
      const path = await this.videos!.verifiedAssetPath(videoScope, taskId, link.jobId, output.output.outputId)
      stream = () => createReadStream(path, { signal })
    }
    signal.throwIfAborted(); validate()
    return materializeArrangementMedia(workspace, deliverable, { ...asset, stream }, nodeRunId,
      this.paths.taskDir(scope, taskId), signal, validate)
  }
}
