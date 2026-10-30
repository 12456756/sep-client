import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { PDFDocument } from 'pdf-lib'
import { isSafeDeliveryPath, type ArrangementNode } from '../domain/arrangement-plan'
import { finalDeliveryFileSchema, type DeliveryIssue, type DeliverySubmission, type FinalDeliveryFile } from '../domain/arrangement-delivery'
import { resolveArrangementMediaFile, restoreArrangementMediaSnapshot } from './arrangement-media-files'
import { publishDeliverySnapshot } from './delivery-snapshot-recovery'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_XML_BYTES = 8 * 1024 * 1024
const TEXT_FORMATS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'py', 'yaml', 'yml', 'sql'])
type FileResult = { ok: true; files: FinalDeliveryFile[] } | { ok: false; issues: DeliveryIssue[] }

export interface DeliveryFileOptions {
  taskDirectory?: string
  allowWorkspaceChanges?: boolean
  /** Execution recovery only; previews remain strictly read-only. */
  repairSnapshots?: boolean
  /** Main-process media coordinator receipts, never model/renderer-provided records. */
  mediaFiles?: readonly FinalDeliveryFile[]
}

export interface ResolvedDeliveryFiles {
  files: FinalDeliveryFile[]
  readPaths: string[]
  issues: DeliveryIssue[]
  warnings: DeliveryIssue[]
}

function snapshotRelativePath(file: FinalDeliveryFile): string {
  const extension = /^[a-z0-9]{1,32}$/i.test(file.format) ? file.format.toLowerCase() : 'bin'
  return `delivery-snapshots/${file.snapshot!.sha256}.${extension}`
}

async function saveSnapshot(taskDirectory: string, file: FinalDeliveryFile, bytes: Buffer, source: 'confirmed' | 'workspace-recovery', signal?: AbortSignal): Promise<FinalDeliveryFile> {
  const snapshot = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, source }
  const saved = { ...file, snapshot }
  await mkdir(taskDirectory, { recursive: true })
  const root = await realpath(taskDirectory)
  const directory = join(root, 'delivery-snapshots')
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('UNSAFE_PATH')
  const target = resolve(root, snapshotRelativePath(saved))
  const temporary = join(directory, `${randomUUID()}.tmp`)
  try {
    signal?.throwIfAborted()
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    signal?.throwIfAborted()
    await publishDeliverySnapshot(temporary, target, async path => {
      const bytes = await readWorkspaceFile(root, relative(root, path).split(sep).join('/'), signal).catch(error => {
        if (error instanceof Error && error.message === 'EMPTY_FILE') throw new Error('SNAPSHOT_CHANGED')
        throw error
      })
      if (bytes.length !== snapshot.size || createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256) throw new Error('SNAPSHOT_CHANGED')
    }, async () => {
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('UNSAFE_PATH')
    }, signal)
    const verified = await readWorkspaceFile(root, snapshotRelativePath(saved), signal)
    if (verified.length !== snapshot.size || createHash('sha256').update(verified).digest('hex') !== snapshot.sha256) throw new Error('SNAPSHOT_CHANGED')
    return saved
  } finally { await rm(temporary, { force: true }) }
}

export async function readWorkspaceFile(workspace: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  if (!isSafeDeliveryPath(path)) throw new Error('UNSAFE_PATH')
  const root = await realpath(workspace)
  const requested = resolve(root, ...path.split(/[\\/]/))
  const requestedInfo = await lstat(requested)
  if (requestedInfo.isSymbolicLink()) throw new Error('UNSAFE_PATH')
  if (!requestedInfo.isFile()) throw new Error('NOT_A_FILE')
  const actual = await realpath(requested)
  const inside = relative(root, actual)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('UNSAFE_PATH')
  const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('NOT_A_FILE')
    if (!before.size) throw new Error('EMPTY_FILE')
    if (before.size > MAX_BYTES) throw new Error('FILE_TOO_LARGE')
    signal?.throwIfAborted()
    // Bound allocation and reads even if a writer grows the file during validation.
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, length, Math.min(1024 * 1024, buffer.length - length), length)
      if (!bytesRead) break
      length += bytesRead
    }
    const data = buffer.subarray(0, length)
    const after = await file.stat()
    if (data.length > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== after.size) throw new Error('FILE_CHANGED')
    const current = await lstat(requested)
    if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || await realpath(requested) !== actual) throw new Error('UNSAFE_PATH')
    return data
  } finally { await file.close() }
}

function parseXml(data: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('INVALID_FORMAT')
  const value: unknown = new XMLParser({ ignoreAttributes: false, processEntities: false, removeNSPrefix: true }).parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_FORMAT')
  return value as Record<string, unknown>
}

function xmlChildren(value: unknown, name: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  const children = (value as Record<string, unknown>)[name]
  return (Array.isArray(children) ? children : [children]).filter((child): child is Record<string, unknown> => !!child && typeof child === 'object')
}

async function validateFormat(bytes: Buffer, format: string): Promise<void> {
  const lower = format.toLowerCase()
  if (TEXT_FORMATS.has(lower)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.trim()) throw new Error('EMPTY_FILE')
    if (lower === 'json') JSON.parse(text) as unknown
    if (lower === 'xml') parseXml(bytes)
  } else if (['docx', 'xlsx', 'pptx'].includes(lower)) {
    let total = 0
    let count = 0
    const entries = unzipSync(bytes, { filter: entry => {
      if (++count > 2_048 || (total += entry.originalSize) > MAX_BYTES || entry.originalSize > MAX_BYTES) throw new Error('FILE_TOO_LARGE')
      const xml = entry.name.endsWith('.xml') || entry.name.endsWith('.rels')
      if (xml && entry.originalSize > MAX_XML_BYTES) throw new Error('FILE_TOO_LARGE')
      return xml
    } })
    if (!entries['[Content_Types].xml'] || !entries['_rels/.rels']) throw new Error('INVALID_FORMAT')
    const parsed = Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, parseXml(data)]))
    const main = lower === 'docx' ? 'word/document.xml' : lower === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'
    const root = lower === 'docx' ? 'document' : lower === 'xlsx' ? 'workbook' : 'presentation'
    const section = lower === 'docx' ? 'body' : lower === 'xlsx' ? 'sheets' : 'sldIdLst'
    const contentType = lower === 'docx' ? 'wordprocessingml.document' : lower === 'xlsx' ? 'spreadsheetml.sheet' : 'presentationml.presentation'
    const types = parsed['[Content_Types].xml'].Types
    const override = xmlChildren(types, 'Override').find(item => item['@_PartName'] === `/${main}`)
    // An explicit Override takes precedence even if its content type is invalid.
    const declaration = override ?? xmlChildren(types, 'Default').find(item =>
      typeof item['@_Extension'] === 'string' && item['@_Extension'].toLowerCase() === 'xml')
    if (declaration?.['@_ContentType'] !== `application/vnd.openxmlformats-officedocument.${contentType}.main+xml`) throw new Error('INVALID_FORMAT')
    if (!xmlChildren(parsed['_rels/.rels'].Relationships, 'Relationship').some(item => typeof item['@_Type'] === 'string' && item['@_Type'].endsWith('/officeDocument') && String(item['@_Target']).replace(/^\//, '') === main)) throw new Error('INVALID_FORMAT')
    const document = parsed[main]?.[root]
    if (!document || typeof document !== 'object' || !Object.hasOwn(document, section)) throw new Error('INVALID_FORMAT')
    if (lower === 'xlsx' && !Object.keys(parsed).some(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name) && Object.hasOwn(parsed[name], 'worksheet'))) throw new Error('INVALID_FORMAT')
    if (lower === 'pptx' && !Object.keys(parsed).some(name => /^ppt\/slides\/slide\d+\.xml$/.test(name) && Object.hasOwn(parsed[name], 'sld'))) throw new Error('INVALID_FORMAT')
  } else if (lower === 'pdf') {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    if (!pdf.getPageCount()) throw new Error('INVALID_FORMAT')
  }
}

export function deliveryFileIssue(error: unknown, id: string, path: string): DeliveryIssue {
  const errno = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const code = typeof errno === 'string' ? errno : error instanceof Error ? error.message : ''
  const messages: Record<string, string> = {
    UNSAFE_PATH: '路径越界或使用了不安全的文件链接，请在共享工作区规定位置保存真实文件。',
    NOT_A_FILE: '交付路径不是普通文件。', EMPTY_FILE: '文件为空，请写入实际成果。',
    FILE_TOO_LARGE: '文件或解压内容超过 64 MiB（单个 XML 超过 8 MiB），请精简成果。', FILE_CHANGED: '校验时文件仍在变化，请完成保存后再提交。',
    INVALID_FORMAT: '文件内容不能按规定文档格式解析，请重新生成有效文档。',
    SNAPSHOT_CHANGED: '交付快照已损坏，不能使用变化后的文件代替已确认快照。',
    SNAPSHOT_UNAVAILABLE: '交付快照缺失或无法读取，请恢复快照后继续。',
    MEDIA_INTEGRITY_MISMATCH: '媒体文件与原始资产的大小或哈希不一致，请恢复原文件。',
    MEDIA_MIME_MISMATCH: '媒体文件的真实类型与交付格式不一致。',
    MEDIA_DESTINATION_CONFLICT: '目标路径已有不同内容，请保留现有文件并处理冲突后重试落盘。',
    PREDECESSOR_FILE_CHANGED: '已确认的前置媒体文件被修改，不能替换原始来源。',
    ENOSPC: '磁盘空间不足，客户端无法保存成果；不要重新生成、删除无关文件或更换计划路径。',
    EACCES: '成果目录没有读写权限；不要修改系统权限或更换计划路径。',
    EPERM: '系统拒绝访问成果文件；不要修改系统权限或更换计划路径。',
    EBUSY: '成果文件暂时被占用，请完成保存后重试。',
    EIO: '保存或读取成果时发生磁盘 I/O 错误。',
  }
  const missing = !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
  return { code: missing ? 'FILE_MISSING' : messages[code] ? code : 'INVALID_FORMAT', deliverableId: id, path,
    message: missing ? '规定的最终交付文件不存在，请实际生成并保存文件。' : messages[code] ?? '文件无法读取或内容格式无效，请重新保存有效文件。' }
}

export async function validateDeliveryFiles(workspace: string, node: ArrangementNode, submission: DeliverySubmission, nodeRunId: string, signal?: AbortSignal, options: DeliveryFileOptions = {}): Promise<FileResult> {
  signal?.throwIfAborted()
  // Enable these contracts only after scoped asset materialization and media validation are wired.
  if (!options.mediaFiles && (submission.mediaDeliverables?.length || node.deliverables?.some(file => file.artifact?.kind === 'image' || file.artifact?.kind === 'video'))) {
    return { ok: false, issues: [{ code: 'MEDIA_DELIVERY_NOT_READY', message: '编排媒体资产物化与类型验收尚未接通，当前不能确认此媒体交付。已保存的资产无需重新生成。' }] }
  }
  const files: FinalDeliveryFile[] = []
  const issues: DeliveryIssue[] = []
  for (const submitted of submission.finalDeliverables) {
    signal?.throwIfAborted()
    const expected = node.deliverables?.find(file => file.id === submitted.id && file.path === submitted.path)
    if (!expected) { issues.push({ code: 'DELIVERY_MANIFEST_MISMATCH', message: '提交文件不在节点交付清单中。' }); continue }
    try {
      if (expected.artifact?.kind === 'image' || expected.artifact?.kind === 'video') {
        const media = options.mediaFiles?.find(file => file.id === expected.id &&
          file.sourceArtifact?.kind === expected.artifact?.kind && submission.mediaDeliverables?.some(mapping =>
            mapping.deliverableId === file.id && mapping.artifactId === file.sourceArtifact?.artifactId))
        if (!media || !finalDeliveryFileSchema.safeParse(media).success) throw new Error('INVALID_FORMAT')
        await resolveArrangementMediaFile(workspace, media, options.taskDirectory, signal)
        files.push(media)
        continue
      }
      const bytes = await readWorkspaceFile(workspace, expected.path, signal)
      await validateFormat(bytes, expected.format)
      signal?.throwIfAborted()
      const file = { id: expected.id, path: expected.path, format: expected.format, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), nodeRunId, validatedAt: Date.now() }
      files.push(options.taskDirectory ? await saveSnapshot(options.taskDirectory, file, bytes, 'confirmed', signal) : file)
    } catch (error) { signal?.throwIfAborted(); issues.push(deliveryFileIssue(error, expected.id, expected.path)) }
  }
  return issues.length ? { ok: false, issues } : { ok: true, files }
}

export async function resolveDeliveryFiles(workspace: string, files: readonly FinalDeliveryFile[], signal?: AbortSignal, options: DeliveryFileOptions = {}): Promise<ResolvedDeliveryFiles> {
  const result: ResolvedDeliveryFiles = { files: [], readPaths: [], issues: [], warnings: [] }
  for (const file of files) {
    signal?.throwIfAborted()
    if (!finalDeliveryFileSchema.safeParse(file).success || !isSafeDeliveryPath(file.path)) { result.issues.push({ code: 'INVALID_DELIVERY_RECORD', message: '前置最终交付记录不完整或路径无效。' }); continue }
    try {
      if (file.sourceArtifact) {
        let path: string
        try { path = await resolveArrangementMediaFile(workspace, file, options.taskDirectory, signal) }
        catch (error) {
          signal?.throwIfAborted()
          if (!options.repairSnapshots || !file.snapshot || !(error instanceof Error) || !['SNAPSHOT_CHANGED', 'SNAPSHOT_UNAVAILABLE'].includes(error.message)) throw error
          await restoreArrangementMediaSnapshot(workspace, file, options.taskDirectory, signal)
          path = await resolveArrangementMediaFile(workspace, file, options.taskDirectory, signal)
        }
        result.files.push(file)
        result.readPaths.push(path)
        continue
      }
      if (file.snapshot) {
        if (!options.taskDirectory) throw new Error('SNAPSHOT_UNAVAILABLE')
        let bytes: Buffer
        try {
          bytes = await readWorkspaceFile(options.taskDirectory, snapshotRelativePath(file), signal)
          if (bytes.length !== file.snapshot.size || createHash('sha256').update(bytes).digest('hex') !== file.snapshot.sha256) throw new Error('SNAPSHOT_CHANGED')
        } catch (error) {
          signal?.throwIfAborted()
          const issue = deliveryFileIssue(error, file.id, file.path)
          if (!options.repairSnapshots || !['FILE_MISSING', 'SNAPSHOT_CHANGED', 'EMPTY_FILE'].includes(issue.code)) {
            if (issue.code === 'FILE_MISSING') throw new Error('SNAPSHOT_UNAVAILABLE')
            throw error
          }
          bytes = await readWorkspaceFile(workspace, file.path, signal)
          if (bytes.length !== file.snapshot.size || createHash('sha256').update(bytes).digest('hex') !== file.snapshot.sha256) throw new Error('SNAPSHOT_CHANGED')
          await validateFormat(bytes, file.format)
          await saveSnapshot(options.taskDirectory, file, bytes, file.snapshot.source, signal)
        }
        result.files.push(file)
        result.readPaths.push(resolve(await realpath(options.taskDirectory), snapshotRelativePath(file)))
        continue
      }
      const bytes = await readWorkspaceFile(workspace, file.path, signal)
      const changed = bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256
      if (changed && (!options.allowWorkspaceChanges || file.sourceArtifact)) {
        result.issues.push({ code: 'PREDECESSOR_FILE_CHANGED', deliverableId: file.id, path: file.path, message: '已确认的前置最终文件被修改，不能将其作为有效前置成果。' })
        continue
      }
      await validateFormat(bytes, file.format)
      const saved = options.taskDirectory ? await saveSnapshot(options.taskDirectory, file, bytes, changed ? 'workspace-recovery' : 'confirmed', signal) : file
      if (changed) result.warnings.push({ code: 'LEGACY_DELIVERY_UPDATED', deliverableId: file.id, path: file.path,
        message: '历史任务没有交付快照，已使用当前格式有效的文件继续；该恢复版本不等同于原验收版本。' })
      result.files.push(saved)
      result.readPaths.push(saved.snapshot ? resolve(await realpath(options.taskDirectory!), snapshotRelativePath(saved)) : resolve(await realpath(workspace), file.path))
    } catch (error) {
      signal?.throwIfAborted()
      const issue = deliveryFileIssue(error, file.id, file.path)
      if (file.sourceArtifact && !file.snapshot && issue.code === 'MEDIA_INTEGRITY_MISMATCH') {
        result.issues.push(deliveryFileIssue(new Error('PREDECESSOR_FILE_CHANGED'), file.id, file.path))
      } else result.issues.push(issue)
    }
  }
  return result
}

export async function revalidateDeliveryFiles(workspace: string, files: readonly FinalDeliveryFile[], signal?: AbortSignal, options: DeliveryFileOptions = {}): Promise<DeliveryIssue[]> {
  return (await resolveDeliveryFiles(workspace, files, signal, options)).issues
}

/** Preview is strictly read-only: unlike predecessor recovery it must never archive new bytes. */
export async function readDeliveryPreviewFile(workspace: string, file: FinalDeliveryFile, taskDirectory: string): Promise<{ bytes: Buffer; source: 'snapshot' | 'recovered-snapshot' | 'verified-original' }> {
  if (!finalDeliveryFileSchema.safeParse(file).success || file.sourceArtifact) throw new Error('INVALID_DELIVERY_RECORD')
  const snapshot = file.snapshot
  const bytes = snapshot
    ? await readWorkspaceFile(taskDirectory, snapshotRelativePath(file))
    : await readWorkspaceFile(workspace, file.path)
  if (bytes.length !== (snapshot?.size ?? file.size) || createHash('sha256').update(bytes).digest('hex') !== (snapshot?.sha256 ?? file.sha256)) {
    throw new Error('PREVIEW_FILE_CHANGED')
  }
  return { bytes, source: snapshot ? snapshot.source === 'workspace-recovery' ? 'recovered-snapshot' : 'snapshot' : 'verified-original' }
}
