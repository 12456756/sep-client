import { constants } from 'node:fs'
import { copyFile, mkdtemp, open, lstat, realpath, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { ReadableStream } from 'node:stream/web'
import type { ResultFileRequest } from '../../src/shared/result-files'
import type { TaskReadView } from '../../src/shared/types'
import type { DocumentPreviewStore } from './document-preview-store'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { resolveArrangementMediaFile } from './arrangement-media-files'
import { resolveDocumentSnapshot } from './arrangement-delivery-files'
import { AppError } from '../errors/app-error'
import { ResultFilePathError, resultFileSystemError } from '../errors/result-file-path-error'
import type { MediaStorePort } from '../domain/media'
import type { VideoStorePort } from '../domain/video-media'
import { resolveWorkspaceResult } from './workspace-result-path'

type VerifiedVideoStore = VideoStorePort & {
  verifiedAssetPath(scope: { enterpriseId: string; memberId: string; subscriptionId: string }, taskId: string, jobId: string, outputId: string): Promise<string>
}

const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' }
export interface OpenResultFile {
  mime: string
  kind: 'image' | 'video'
  size: number
  validate(): Promise<void>
  authorize?(): Promise<void>
  stream(start: number, end: number, signal: AbortSignal, validate: () => void): ReadableStream<Uint8Array>
  close(): Promise<void>
}
export interface ResultFileStorePort {
  open(scope: TaskOwnerScope, input: ResultFileRequest): Promise<OpenResultFile>
  revealPath(scope: TaskOwnerScope, input: ResultFileRequest): Promise<string>
  actionFile(scope: TaskOwnerScope, input: ResultFileRequest): Promise<ResultActionFile>
}

export interface ResultActionFile { path: string; name: string; version: string; temporaryOpen?: boolean }

async function managedResultPath(file: string): Promise<string> {
  if (!isAbsolute(file)) throw new ResultFilePathError('invalidPath')
  // Managed storage does not allow workspace aliases, even above the per-task directory.
  return (await resolveWorkspaceResult(parse(file).root, file)).path
}

export async function saveResultCopy(file: ResultActionFile, destination: string): Promise<void> {
  if (!isAbsolute(destination)) throw new AppError('INVALID_ARGUMENT')
  const extension = extname(file.name), selectedExtension = extname(destination)
  if (extension && selectedExtension && extension.toLowerCase() !== selectedExtension.toLowerCase()) {
    throw new AppError('INVALID_ARGUMENT', { message: '请保留原文件的扩展名。' })
  }
  try { await copyFile(file.path, selectedExtension ? destination : destination + extension, constants.COPYFILE_EXCL) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('INVALID_ARGUMENT', { message: '目标文件已存在，请选择其他名称。' })
    throw new AppError('INTERNAL_ERROR', { message: '无法另存文件，请检查目标目录权限和可用空间。', cause: error })
  }
}

export async function createResultOpenCopy(file: ResultActionFile): Promise<{ path: string; dispose: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), 'csep-result-'))
  const dispose = () => rm(folder, { recursive: true, force: true }).catch(() => undefined)
  // Use a fixed stem: an attachment display name is not a safe filesystem path.
  const path = join(folder, 'attachment' + extname(file.name).toLowerCase())
  try { await copyFile(file.path, path, constants.COPYFILE_EXCL); return { path, dispose } }
  catch (error) { await dispose(); throw error }
}

export class ResultFileStore implements ResultFileStorePort {
  private readonly paths: ScopePath
  constructor(root: string, private readonly deliveries: DocumentPreviewStore, private readonly getTask: (taskId: string) => Promise<TaskReadView>,
    private readonly media?: MediaStorePort, private readonly videos?: VideoStorePort,
    private readonly attachment?: (scope: TaskOwnerScope, taskId: string, attachmentId: string, sha256: string) => Promise<{ path: string; name: string; size: number }>) {
    this.paths = new ScopePath(root)
  }

  private async task(scope: TaskOwnerScope, taskId: string): Promise<TaskReadView> {
    const task = await this.getTask(taskId)
    if (task.id !== taskId || task.ownerId !== scope.memberId || task.ownerEnterpriseId !== scope.enterpriseId) throw new AppError('NOT_FOUND')
    return task
  }

  private async resolve(scope: TaskOwnerScope, input: ResultFileRequest, original: boolean) {
    const task = await this.task(scope, input.taskId)
    if ('attachmentId' in input) {
      const attachment = await this.attachment?.(scope, input.taskId, input.attachmentId, input.sha256)
      if (!attachment) throw new AppError('NOT_FOUND')
      const path = await managedResultPath(attachment.path)
      return { path, name: basename(attachment.name.replaceAll('\\', '/')).replace(/[<>:"|?*]/g, '_') || 'attachment',
        temporaryOpen: true, format: extname(attachment.name).slice(1).toLowerCase(), version: input.sha256,
        expected: { size: attachment.size, sha256: input.sha256 } }
    }
    if ('assetId' in input) {
      const asset = await this.media?.getAsset(scope, input.taskId, input.assetId)
      if (!asset || asset.status !== 'SAVED') throw new AppError('NOT_FOUND')
      await this.media?.readAsset(scope, input.taskId, input.assetId)
      const root = resolve(this.paths.mediaRoot(scope, input.taskId))
      const requested = resolve(root, asset.relativePath)
      const rel = relative(root, requested)
      if (!rel) throw new ResultFilePathError('notFile')
      if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..') throw new ResultFilePathError('outside')
      const path = await managedResultPath(requested)
      if (!path.startsWith((await realpath(root)) + sep)) throw new ResultFilePathError('outside')
      return { path, format: asset.mime.slice(asset.mime.indexOf('/') + 1), version: `${asset.localAssetId}:${asset.sha256}:${asset.relativePath}`, expected: { size: asset.size, sha256: asset.sha256 } }
    }
    if ('jobId' in input) {
      if (!task.subscriptionId || !this.videos) throw new AppError('NOT_FOUND')
      const videoScope = { ...scope, subscriptionId: task.subscriptionId }
      const job = await this.videos.getJob(videoScope, input.taskId, input.jobId)
      const output = job?.receipt?.outputs.find(item => item.outputId === input.outputId)
      const asset = output && await this.videos.getAsset(videoScope, input.taskId, input.jobId, input.outputId)
      if (!job || !output || !asset || asset.status !== 'SAVED') throw new AppError('NOT_FOUND')
      const path = await (this.videos as VerifiedVideoStore).verifiedAssetPath(videoScope, input.taskId, input.jobId, input.outputId)
      return { path, format: output.mimeType.slice(output.mimeType.indexOf('/') + 1), version: `${asset.localAssetId}:${output.sha256}:${asset.relativePath}`, expected: { size: output.byteLength, sha256: output.sha256.toLowerCase() } }
    }
    if ('fileId' in input) {
      if (task.workType.state !== 'resolved' || task.workType.kind !== 'conversation') throw new AppError('NOT_FOUND')
      const name = task.files.find((_file, index) => `${task.id}-file-${index}` === input.fileId)
      if (!name) throw new AppError('NOT_FOUND')
      const file = await resolveWorkspaceResult(task.workDir ?? '', name)
      return { path: file.path, name: basename(file.path), format: extname(file.path).slice(1).toLowerCase(), version: name }
    }
    const delivery = await this.deliveries.getDelivery(scope, input.taskId, input.nodeId, input.deliverableId)
    if (!delivery || delivery.status !== 'completed') throw new AppError('NOT_FOUND')
    const file = original ? { ...delivery.file, snapshot: undefined } : delivery.file
    const taskDirectory = this.paths.taskDir(scope, input.taskId)
    const path = file.snapshot && !file.sourceArtifact ? await resolveDocumentSnapshot(delivery.workspace, file, taskDirectory)
      : await resolveArrangementMediaFile(delivery.workspace, file, taskDirectory)
    return { path, name: basename(file.path.replaceAll('\\', '/')), temporaryOpen: !!file.snapshot,
      format: file.format.toLowerCase(), version: `${file.nodeRunId}:${file.sha256}:${file.path}`, expected: { size: file.size, sha256: file.sha256 } }
  }

  async revealPath(scope: TaskOwnerScope, input: ResultFileRequest): Promise<string> {
    try { return (await this.resolve(scope, input, true)).path }
    catch (error) {
      if (error instanceof AppError) throw error
      throw resultFileSystemError(error) ?? new AppError('NOT_FOUND', { message: '产出文件不存在、已被修改或无法访问，请确认文件仍保存在原位置。', cause: error })
    }
  }

  async actionFile(scope: TaskOwnerScope, input: ResultFileRequest): Promise<ResultActionFile> {
    try {
      const file = await this.resolve(scope, input, false)
      const info = await lstat(file.path)
      if (info.isSymbolicLink()) throw new ResultFilePathError('link')
      if (!info.isFile()) throw new ResultFilePathError('notFile')
      const version = JSON.stringify([file.version, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
      return { path: file.path, name: file.name ?? basename(file.path), version, temporaryOpen: file.temporaryOpen }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw resultFileSystemError(error) ?? new AppError('NOT_FOUND', { message: '文件不存在、已更改或无法访问，请检查原文件。', cause: error })
    }
}

  async open(scope: TaskOwnerScope, input: ResultFileRequest): Promise<OpenResultFile> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const file = await this.resolve(scope, input, false)
      const mime = types[file.format]
      if (!mime) throw new AppError('INVALID_ARGUMENT', { message: '此文件格式暂不支持直接播放或显示。' })
      handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const opened = handle
      const before = await opened.stat()
      if (!before.isFile() || before.size <= 0 || before.size > 256 * 1024 * 1024) throw new Error('INVALID_FILE')
      const hash = createHash('sha256')
      for (let offset = 0; offset < before.size;) {
        const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, before.size - offset))
        const read = await opened.read(chunk, 0, chunk.length, offset)
        if (!read.bytesRead) throw new Error('FILE_CHANGED')
        hash.update(chunk.subarray(0, read.bytesRead)); offset += read.bytesRead
      }
      if (file.expected && (before.size !== file.expected.size || hash.digest('hex') !== file.expected.sha256)) throw new Error('FILE_CHANGED')
      let closed = false
      const validate = async () => {
        if (closed) throw new Error('PREVIEW_CLOSED')
        const after = await opened.stat()
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('FILE_CHANGED')
      }
      await validate()
      return {
        mime, kind: mime.startsWith('image/') ? 'image' : 'video', size: before.size, validate,
        authorize: async () => {
          const current = await this.resolve(scope, input, false)
          if (current.version !== file.version || current.path !== file.path) throw new AppError('INVALID_STATE')
        },
        close: async () => { if (!closed) { closed = true; await opened.close() } },
        stream: (start, end, signal, check) => {
          let offset = start
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                signal.throwIfAborted(); check(); await validate()
                const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, end - offset + 1))
                const { bytesRead } = await opened.read(buffer, 0, buffer.length, offset)
                signal.throwIfAborted(); check(); await validate()
                if (!bytesRead) throw new Error('FILE_CHANGED')
                offset += bytesRead; controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)))
                if (offset > end) controller.close()
              } catch (error) { controller.error(error) }
            },
          }, { highWaterMark: 0 })
        },
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (error instanceof AppError) throw error
      throw resultFileSystemError(error) ?? new AppError('NOT_FOUND', { message: '媒体文件无法读取，可能已被删除或修改，请检查原文件。', cause: error })
    }
  }
}
