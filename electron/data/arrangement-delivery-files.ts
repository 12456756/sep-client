import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { PDFDocument } from 'pdf-lib'
import { isSafeDeliveryPath, type ArrangementNode } from '../domain/arrangement-plan'
import { finalDeliveryFileSchema, type DeliveryIssue, type DeliverySubmission, type FinalDeliveryFile } from '../domain/arrangement-delivery'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_XML_BYTES = 8 * 1024 * 1024
const TEXT_FORMATS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'py', 'yaml', 'yml', 'sql'])
type FileResult = { ok: true; files: FinalDeliveryFile[] } | { ok: false; issues: DeliveryIssue[] }

async function readWorkspaceFile(workspace: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  if (!isSafeDeliveryPath(path)) throw new Error('UNSAFE_PATH')
  const root = await realpath(workspace)
  const requested = resolve(root, ...path.split(/[\\/]/))
  if ((await lstat(requested)).isSymbolicLink()) throw new Error('UNSAFE_PATH')
  const actual = await realpath(requested)
  const inside = relative(root, actual)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('UNSAFE_PATH')
  const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
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
    if (!xmlChildren(parsed['[Content_Types].xml'].Types, 'Override').some(item => item['@_PartName'] === `/${main}` && item['@_ContentType'] === `application/vnd.openxmlformats-officedocument.${contentType}.main+xml`)) throw new Error('INVALID_FORMAT')
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

function fileIssue(error: unknown, id: string, path: string): DeliveryIssue {
  const code = error instanceof Error ? error.message : ''
  const messages: Record<string, string> = {
    UNSAFE_PATH: '路径越界或使用了不安全的文件链接，请在共享工作区规定位置保存真实文件。',
    NOT_A_FILE: '交付路径不是普通文件。', EMPTY_FILE: '文件为空，请写入实际成果。',
    FILE_TOO_LARGE: '文件或解压内容超过 64 MiB（单个 XML 超过 8 MiB），请精简成果。', FILE_CHANGED: '校验时文件仍在变化，请完成保存后再提交。',
    INVALID_FORMAT: '文件内容不能按规定文档格式解析，请重新生成有效文档。',
  }
  const missing = !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
  return { code: missing ? 'FILE_MISSING' : messages[code] ? code : 'INVALID_FORMAT', deliverableId: id, path,
    message: missing ? '规定的最终交付文件不存在，请实际生成并保存文件。' : messages[code] ?? '文件无法读取或内容格式无效，请重新保存有效文件。' }
}

export async function validateDeliveryFiles(workspace: string, node: ArrangementNode, submission: DeliverySubmission, nodeRunId: string, signal?: AbortSignal): Promise<FileResult> {
  const files: FinalDeliveryFile[] = []
  const issues: DeliveryIssue[] = []
  for (const submitted of submission.finalDeliverables) {
    signal?.throwIfAborted()
    const expected = node.deliverables?.find(file => file.id === submitted.id && file.path === submitted.path)
    if (!expected) { issues.push({ code: 'DELIVERY_MANIFEST_MISMATCH', message: '提交文件不在节点交付清单中。' }); continue }
    try {
      const bytes = await readWorkspaceFile(workspace, expected.path, signal)
      await validateFormat(bytes, expected.format)
      signal?.throwIfAborted()
      files.push({ id: expected.id, path: expected.path, format: expected.format, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), nodeRunId, validatedAt: Date.now() })
    } catch (error) { signal?.throwIfAborted(); issues.push(fileIssue(error, expected.id, expected.path)) }
  }
  return issues.length ? { ok: false, issues } : { ok: true, files }
}

export async function revalidateDeliveryFiles(workspace: string, files: readonly FinalDeliveryFile[], signal?: AbortSignal): Promise<DeliveryIssue[]> {
  const issues: DeliveryIssue[] = []
  for (const file of files) {
    if (!finalDeliveryFileSchema.safeParse(file).success) { issues.push({ code: 'INVALID_DELIVERY_RECORD', message: '前置最终交付记录不完整。' }); continue }
    try {
      const bytes = await readWorkspaceFile(workspace, file.path, signal)
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) issues.push({ code: 'PREDECESSOR_FILE_CHANGED', deliverableId: file.id, path: file.path, message: '已确认的前置最终文件被修改，不能将其作为有效前置成果。' })
    } catch (error) { signal?.throwIfAborted(); issues.push(fileIssue(error, file.id, file.path)) }
  }
  return issues
}
