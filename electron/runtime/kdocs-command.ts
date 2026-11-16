import { z } from 'zod'
import { ConnectorInputError } from '../domain/connectors'

// Bounded contracts verified against the official kdocs-cli 2.9.0 schema output.
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)
const text = z.string().min(1).max(60000)
const locator = {
  file_id: id.optional(), link_id: id.optional(),
  url: z.url().max(2048).refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && ['kdocs.cn', 'www.kdocs.cn', '365.kdocs.cn'].includes(url.hostname) && !url.username && !url.password && !url.port && /^\/l\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.search && !url.hash
  }, 'Use a Kdocs document share URL').optional(),
}
const located = (value: { file_id?: string; link_id?: string; url?: string }): boolean => !!(value.file_id || value.link_id || value.url)
const page = { page_size: z.number().int().min(1).max(100).default(50), page_token: z.string().max(4096).optional() }
const order = { order: z.enum(['desc', 'asc']).optional(), order_by: z.enum(['ctime', 'mtime', 'dtime', 'fname', 'fsize']).optional() }
const coordinates = { rowFrom: z.number().int().min(0).max(1048575), rowTo: z.number().int().min(0).max(1048575), colFrom: z.number().int().min(0).max(16383), colTo: z.number().int().min(0).max(16383) }
const validRange = (value: z.infer<typeof range>): boolean => value.rowTo >= value.rowFrom && value.colTo >= value.colFrom && (value.rowTo - value.rowFrom + 1) * (value.colTo - value.colFrom + 1) <= 10000
const range = z.object(coordinates).strict()
const list = { ...page, ...order, filter_exts: z.string().max(256).optional(), filter_type: z.enum(['file', 'folder', 'shortcut']).optional(), with_permission: z.boolean().optional(), with_ext_attrs: z.boolean().optional() }
const target = { dst_drive_id: id.optional(), dst_parent_id: id }
const destination = (value: { dst_drive_id?: string; dst_parent_id: string }): boolean => value.dst_parent_id !== '0' || !!value.dst_drive_id
const create = z.object({ name: z.string().min(1).max(256), file_extension: z.enum(['otl', 'docx', 'md', 'pdf']), content: text, drive_id: id.optional(), parent_id: id.optional() }).strict()
  .refine(value => !/\.(?:otl|docx|md|pdf)$/i.test(value.name) && (value.parent_id !== '0' || !!value.drive_id), 'Put the extension in file_extension; root 0 requires drive_id')

export const kdocsCommands = {
  'drive.search-files': z.object({ ...page, keyword: z.string().max(1024).optional(), type: z.enum(['all', 'file_name', 'content']).default('all'), file_type: z.enum(['file', 'folder']).optional(), file_exts: z.array(z.string().regex(/^[a-z0-9]{1,16}$/)).max(20).optional(), with_total: z.boolean().optional(), with_link: z.boolean().optional() }).strict(),
  'drive.list-my-files': z.object(list).strict(),
  'drive.list-files': z.object({ ...list, drive_id: id.optional(), parent_id: id }).strict().refine(value => value.parent_id !== '0' || !!value.drive_id, 'Root 0 requires drive_id'),
  'drive.get-file-info': z.object({ ...locator, with_permission: z.boolean().optional(), with_ext_attrs: z.boolean().optional(), with_drive: z.boolean().optional() }).strict().refine(located),
  'drive.get-file-link': z.object(locator).strict().refine(located),
  'drive.read-file': z.object({ ...locator, format: z.enum(['markdown', 'plain', 'kdc']).optional(), task_id: id.optional(), enable_upload_medias: z.boolean().optional() }).strict().refine(located),
  'drive.create-file-with-content': create,
  'drive.rename-file': z.object({ drive_id: id.optional(), file_id: id, dst_name: z.string().min(1).max(256) }).strict(),
  'drive.move-file': z.object({ drive_id: id.optional(), file_ids: z.array(id).min(1).max(100), ...target }).strict().refine(destination),
  'drive.copy-file': z.object({ ...locator, drive_id: id.optional(), ...target }).strict().refine(located).refine(destination),
  'otl.block-query': z.object({ ...locator, params: z.object({ blockIds: z.array(id).min(1).max(100) }).strict().optional() }).strict().refine(located),
  'otl.insert-content': z.object({ ...locator, title: z.string().max(256).optional(), content: text, format: z.enum(['markdown', 'html']), mode: z.enum(['prepend', 'append', 'replace']) }).strict().refine(located),
  'sheet.get-sheets-info': z.object(locator).strict().refine(located),
  'sheet.get-range-data': z.object({ ...locator, worksheet_id: z.number().int().nonnegative(), range: range.refine(validRange) }).strict().refine(located),
  'sheet.update-range-data': z.object({ ...locator, worksheet_id: z.number().int().nonnegative(), rangeData: z.array(z.object({ ...coordinates, opType: z.literal('formula'), formula: z.string().max(8000) }).strict().refine(validRange)).min(1).max(100) }).strict().refine(located),
}
export type KdocsMethod = keyof typeof kdocsCommands
export interface KdocsRequest { method: KdocsMethod; tool: string; data: Record<string, unknown>; mutating: boolean }
const writes = new Set<KdocsMethod>(['drive.create-file-with-content', 'drive.rename-file', 'drive.move-file', 'drive.copy-file', 'otl.insert-content', 'sheet.update-range-data'])
function method(value: string): KdocsMethod {
  if (!Object.hasOwn(kdocsCommands, value)) throw new ConnectorInputError('请通过 kdocs_schema 查询支持的文档方法。')
  return value as KdocsMethod
}
export function kdocsSchema(path: string): string {
  if (['kdocs', 'drive', 'otl', 'sheet'].includes(path)) return JSON.stringify({ methods: Object.keys(kdocsCommands).filter(name => path === 'kdocs' || name.startsWith(`${path}.`)), usage: ['service', 'action', '--json', '{...}'], note: 'CSEP bounded adapter of kdocs-cli 2.9.0; WPS personal accounts. No raw calls, credentials, local files, sharing changes or deletion. Sheet updates support values/formulas only.' })
  const name = method(path.replace(' ', '.'))
  return JSON.stringify({ method: name, input: z.toJSONSchema(kdocsCommands[name], { io: 'input' }), constraints: 'Supply file_id/link_id/url. Folder root 0 requires a drive ID. Ranges: zero-based, ordered, at most 10000 cells. Read before writing; verify afterward. Never retry uncertain writes.' })
}
export function kdocsRequest(args: string[]): KdocsRequest {
  if (!Array.isArray(args) || args.length !== 4 || args.some(arg => typeof arg !== 'string' || arg.length > 64000 || arg.includes('\0')) || args[2] !== '--json') throw new ConnectorInputError('参数必须为 [service, action, --json, JSON对象]。')
  const name = method(`${args[0]}.${args[1]}`)
  let value: unknown
  try { value = JSON.parse(args[3]) } catch { throw new ConnectorInputError('文档参数必须是有效的 JSON 对象。') }
  const parsed = kdocsCommands[name].safeParse(value)
  if (!parsed.success) throw new ConnectorInputError(`参数不符合 ${name} 契约，请先查看 kdocs_schema。`)
  return { method: name, tool: (args[0] === 'drive' ? args[1] : name).replaceAll('-', '_'), data: parsed.data, mutating: writes.has(name) }
}
