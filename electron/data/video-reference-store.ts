import { constants, openAsBlob } from 'node:fs'
import { lstat, open, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import { z } from 'zod'
import { videoReferenceViewSchema, uploadedVideoReferenceSchema, videoReferenceProblem, type UploadedVideoReference, type VideoReferenceSupport } from '../../src/shared/video-references'
import type { LocalVideoReference, VideoReferencePort } from '../domain/video-references'
import { videoLocalIdSchema, videoScopeSchema, type VideoScope } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { VideoFiles } from './video-files'
import { ScopePath } from './scope-path'
import { WriteChain } from './write-chain'

const manifestSchema = videoReferenceViewSchema.omit({ uploadStatus: true, uploadProgress: true, uploadError: true, uploadProfileId: true, uploadConfigVersion: true, uploadExpiresAt: true }).extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), uploaded: uploadedVideoReferenceSchema.optional(),
  createdAt: z.number().int().nonnegative().optional(),
  uploadSubscriptionId: z.string().min(1).max(256).optional(),
}).strict()
const writes = new WriteChain()

/** Originals are task/member owned; SEP upload credentials remain subscription bound. */
export class VideoReferenceStore implements VideoReferencePort {
  private readonly files: VideoFiles
  private readonly paths: ScopePath
  constructor(root: string) { this.files = new VideoFiles(root); this.paths = new ScopePath(this.files.root) }
  private directory(scope: VideoScope, taskId: string): string {
    videoScopeSchema.parse(scope); videoLocalIdSchema.parse(taskId)
    return join(this.paths.ownerRoot(scope), 'video-references', 'v1', taskId)
  }
  private path(scope: VideoScope, taskId: string, id: string, extension: string): string {
    videoReferenceViewSchema.shape.localAssetId.parse(id)
    return join(this.directory(scope, taskId), `${id}.${extension}`)
  }
  private async get(scope: VideoScope, taskId: string, id: string): Promise<LocalVideoReference> {
    const asset = await this.files.json(this.path(scope, taskId, id, 'json'), manifestSchema)
    if (!asset || asset.localAssetId !== id || asset.taskId !== taskId) throw new AppError('NOT_FOUND')
    const { uploadSubscriptionId, ...local } = asset
    return { ...local, ...(uploadSubscriptionId !== scope.subscriptionId ? { uploaded: undefined } : {}) }
  }
  async list(scope: VideoScope, taskId: string): Promise<LocalVideoReference[]> {
    const assets: LocalVideoReference[] = []
    for (const name of await this.files.names(this.directory(scope, taskId))) {
      if (!/^vref_[a-f0-9]{32}\.json$/.test(name)) continue
      const asset = await this.get(scope, taskId, name.slice(0, -5))
      assets.push({ ...asset, status: await this.files.exists(this.path(scope, taskId, asset.localAssetId, 'video')) ? 'SAVED' : 'MISSING' })
    }
    return assets.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.localAssetId.localeCompare(b.localAssetId))
  }
  async import(scope: VideoScope, taskId: string, paths: readonly string[], support: VideoReferenceSupport, signal: AbortSignal, validate: () => void): Promise<LocalVideoReference[]> {
    if (!paths.length || paths.length > Math.min(10, support.maxCount)) throw new AppError('INVALID_ARGUMENT', { message: `每次最多导入 ${Math.min(10, support.maxCount)} 个参考视频。` })
    if ((await this.list(scope, taskId)).length + paths.length > 100) throw new AppError('INVALID_ARGUMENT', { message: '本对话参考视频已达上限，请移除不再需要的视频后导入。' })
    const assets: LocalVideoReference[] = []
    for (const source of paths) {
      signal.throwIfAborted(); validate()
      const path = resolve(source), stat = await lstat(path)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > support.maxInputBytes) throw new AppError('INVALID_ARGUMENT', { message: '参考视频类型或大小不符合当前模型限制。' })
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const id = `vref_${randomUUID().replace(/-/g, '')}`
      const part = this.path(scope, taskId, id, 'part'), target = this.path(scope, taskId, id, 'video')
      try {
        const actual = await handle.stat()
        if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size !== stat.size || !actual.isFile() || actual.nlink !== 1) throw new AppError('INVALID_ARGUMENT')
        const header = Buffer.alloc(32)
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        const extension = extname(path).toLowerCase()
        const quicktime = header.toString('ascii', 8, 12) === 'qt  '
        const mime = quicktime ? 'video/quicktime' : 'video/mp4'
        if (bytesRead < 16 || header.toString('ascii', 4, 8) !== 'ftyp' || !/^(qt {2}|isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(header.toString('ascii', 8, 12)) || !['.mp4', '.mov'].includes(extension)
          || (extension === '.mov') !== quicktime) throw new AppError('INVALID_ARGUMENT', { message: '请选择有效的 MP4 或 MOV 视频，文件扩展名必须与内容一致。' })
        const hash = createHash('sha256')
        async function* chunks() {
          const buffer = Buffer.alloc(64 * 1024)
          let offset = 0
          for (;;) {
            signal.throwIfAborted(); validate()
            const read = await handle.read(buffer, 0, buffer.length, offset)
            if (!read.bytesRead) return
            offset += read.bytesRead
            if (offset > stat.size) throw new AppError('INVALID_ARGUMENT')
            yield buffer.subarray(0, read.bytesRead)
          }
        }
        for await (const chunk of chunks()) hash.update(chunk)
        const sha256 = hash.digest('hex')
        const asset: LocalVideoReference = { localAssetId: id, taskId, name: basename(path).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 256) || 'video', mime, size: stat.size, status: 'SAVED', sha256, createdAt: Date.now() }
        const problem = videoReferenceProblem([asset], support)
        if (problem) throw new AppError('INVALID_ARGUMENT', { message: problem })
        await this.files.stream(part, chunks(), { byteLength: stat.size, sha256 }, signal)
        signal.throwIfAborted(); validate()
        await this.files.publish(part, target)
        await this.files.writeJson(this.path(scope, taskId, id, 'json'), asset)
        assets.push(asset)
      } finally { await handle.close(); await rm(part, { force: true }) }
    }
    return assets
  }
  async open(scope: VideoScope, taskId: string, id: string) {
    const asset = await this.get(scope, taskId, id)
    const path = this.path(scope, taskId, id, 'video')
    await this.files.verify(path, { byteLength: asset.size, sha256: asset.sha256, mimeType: asset.mime })
    return { asset, file: await openAsBlob(path, { type: asset.mime }) }
  }
  async saveUpload(scope: VideoScope, taskId: string, id: string, uploaded: UploadedVideoReference): Promise<void> {
    await writes.run(this.directory(scope, taskId), async () => {
      const asset = await this.get(scope, taskId, id)
      const value = uploadedVideoReferenceSchema.parse(uploaded)
      if (value.sha256.toLowerCase() !== asset.sha256 || value.byteLength !== asset.size || value.mimeType !== asset.mime) throw new AppError('INVALID_STATE')
      await this.files.writeJson(this.path(scope, taskId, id, 'json'), { ...asset, uploaded: value, uploadSubscriptionId: scope.subscriptionId })
    })
  }
  async remove(scope: VideoScope, taskId: string, id: string): Promise<void> {
    await writes.run(this.directory(scope, taskId), async () => {
      await this.get(scope, taskId, id)
      for (const extension of ['json', 'video']) {
        const path = this.path(scope, taskId, id, extension)
        await this.files.assertPath(path)
        await rm(path, { force: true })
      }
    })
  }
}
