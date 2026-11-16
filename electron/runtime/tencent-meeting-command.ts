import { z } from 'zod'
import { ConnectorInputError } from '../domain/connectors'
import type { MeetingRequest } from './tencent-meeting-api'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
const time = z.string().datetime({ offset: true }).describe('ISO 8601 time with explicit timezone offset, including seconds')
const pagination = { page_size: z.number().int().min(1).max(30).optional(), page_token: z.string().max(8192).optional() }
const fields = { subject: z.string().min(1).max(300).optional(), start: time.optional(), end: time.optional(),
  password: z.string().regex(/^\d{4,6}$/).optional(), timezone: z.string().min(1).max(100).optional(),
}
const validRange = (value: { start?: string; end?: string }): boolean => !value.start || !value.end || Date.parse(value.start) < Date.parse(value.end)
const search = { q: z.string().max(50).optional(), from: time.optional(), to: time.optional(), ...pagination }
export const meetingCommands = {
  'identity.whoami': z.object({}).strict(),
  'meeting.list': z.object({ page_size: pagination.page_size.unwrap().max(20).optional(), page_token: pagination.page_token }).strict(),
  'meeting.get': z.object({ meeting_id: id }).strict(),
  'meeting.search': z.object(search).strict().refine(v => !v.from || !v.to || Date.parse(v.from) < Date.parse(v.to), 'from must be earlier than to'),
  'meeting.create': z.object({ ...fields, subject: fields.subject.unwrap(), start: time, end: time }).strict().refine(validRange, 'start must be earlier than end'),
  'meeting.update': z.object({ meeting_id: id, ...fields }).strict().refine(validRange, 'start must be earlier than end').refine(v => !!v.start === !!v.end, 'supply both start and end when changing times').refine(v => Object.keys(v).length > 1, 'at least one update field is required'),
  'meeting.cancel': z.object({ meeting_id: id, meeting_type: z.literal(0).optional() }).strict(),
  'record.search': z.object({ ...search, meeting_id: id.optional(), file_type: z.enum(['all', 'video', 'audio', 'transcript', 'upload', 'external']).optional() }).strict().refine(v => !v.from || !v.to || Date.parse(v.from) < Date.parse(v.to), 'from must be earlier than to'),
  'record.minutes': z.object({ record_file_id: id, lang: z.string().max(32).optional() }).strict(),
  'record.transcript': z.object({ record_file_id: id, meeting_id: id.optional(), pid: z.string().max(8192).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
} as const
type Method = keyof typeof meetingCommands

function method(path: string): Method {
  const name = path.replaceAll(' ', '.')
  if (!Object.hasOwn(meetingCommands, name)) throw new ConnectorInputError('请通过 tmeet_schema 查询支持的会议或录制方法。')
  return name as Method
}
export function meetingSchema(path: string): string {
  if (path === 'tmeet' || path === 'meeting' || path === 'record' || path === 'identity') return JSON.stringify({ methods: Object.keys(meetingCommands).filter(name => path === 'tmeet' || name.startsWith(`${path}.`)), usage: ['service', 'method', '--json', '{...}'], note: 'CSEP adapter contracts; identity is managed by the client. Ordinary scheduled meetings only.' })
  const name = method(path)
  return JSON.stringify({ method: name, input: z.toJSONSchema(meetingCommands[name]), note: 'Time ranges must be ordered. Updates require a changed field; supply both start and end when changing times. Do not pass identity, credentials, URLs or paths.' })
}
export function meetingRequest(args: string[], openId: string): MeetingRequest {
  if (!Array.isArray(args) || args.length !== 4 || args[2] !== '--json' || args.some(arg => typeof arg !== 'string' || arg.length > 64000 || arg.includes('\0'))) throw new ConnectorInputError('调用格式为 [服务, 方法, "--json", JSON对象]。')
  const name = method(`${args[0]}.${args[1]}`)
  let payload: unknown
  try { payload = JSON.parse(args[3]) } catch { throw new ConnectorInputError('请传入有效 JSON 对象。') }
  const result = meetingCommands[name].safeParse(payload)
  if (!result.success) throw new ConnectorInputError(`参数不符合 ${name} 契约，请先查看 tmeet_schema。`)
  const data: Record<string, unknown> = { ...result.data }
  const operator = { operator_id: openId, operator_id_type: 2 }
  const meetingId = String(data.meeting_id ?? '')
  const recordId = String(data.record_file_id ?? '')
  if (name === 'identity.whoami') return { method: 'POST', path: '/v1/cli/get-user-info', data: operator }
  if (name === 'meeting.list') return { method: 'GET', path: '/v1/meetings', data: { userid: openId, instanceid: 1, page_type: 1, page_size: 20, page_token: '', ...data } }
  if (name === 'meeting.get') return { method: 'GET', path: `/v1/meetings/${meetingId}`, data: { ...operator, instanceid: 1 } }
  if (name === 'meeting.search' || name === 'record.search') return { method: 'GET', path: name === 'meeting.search' ? '/v1/meetings/search-meetings' : '/v1/mcp/records/search', data: { ...operator, page_size: 30, page_token: '', q_fields: 'all', ...(name === 'record.search' ? { file_type: 'all' } : {}), ...data } }
  if (name === 'record.minutes') return { method: 'GET', path: `/v1/smart/minutes/${recordId}`, data: { ...operator, lang: data.lang ?? 'default' } }
  if (name === 'record.transcript') return { method: 'GET', path: '/v1/records/mcp/transcripts/details', data: { ...operator, ...data } }
  delete data.meeting_id
  if (name === 'meeting.cancel') return { method: 'POST', path: `/v1/meetings/${meetingId}/cancel`, data: { userid: openId, instanceid: 1, reason_code: 0, meetingId, meeting_type: 0 } }
  for (const field of ['start', 'end']) if (typeof data[field] === 'string') {
    data[`${field}_time`] = String(Math.floor(Date.parse(data[field]) / 1000)); delete data[field]
  }
  return { method: name === 'meeting.create' ? 'POST' : 'PUT', path: name === 'meeting.create' ? '/v1/meetings' : `/v1/meetings/${meetingId}`,
    data: { userid: openId, instanceid: 1, ...(name === 'meeting.create' ? { type: 0, meeting_type: 0 } : {}), ...data },
  }
}
