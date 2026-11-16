import { z } from 'zod'
import { ConnectorInputError } from '../domain/connectors'

const safeLine = /^[^\p{Cc}]+$/u
const folder = z.string().min(1).max(256).regex(safeLine).default('INBOX')
const uid = z.number().int().min(1).max(4294967295)
const validity = z.string().regex(/^[1-9][0-9]{0,19}$/)
const address = z.string().max(254).regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/)
const recipients = z.array(address).min(1).max(20)
const body = z.string().min(1).max(100000)
const single = { folder, uid, uid_validity: validity }
const page = { folder, limit: z.number().int().min(1).max(50).default(20), before_uid: uid.optional(), uid_validity: validity.optional() }
const cursorValid = (v: { before_uid?: number; uid_validity?: string }): boolean => !!v.before_uid === !!v.uid_validity
export const qqMailCommands = {
  'identity.whoami': z.object({}).strict(),
  'folder.list': z.object({}).strict(),
  'message.list': z.object(page).strict().refine(cursorValid),
  'message.search': z.object({ ...page, query: z.string().min(1).max(200).regex(safeLine), unread: z.boolean().optional() }).strict().refine(cursorValid),
  'message.get': z.object(single).strict(),
  'message.send': z.object({ to: recipients, cc: recipients.optional(), subject: z.string().min(1).max(300).regex(safeLine), text: body }).strict().refine(v => v.to.length + (v.cc?.length ?? 0) <= 20),
  'message.reply': z.object({ ...single, to: recipients.describe('Expected Reply-To, or From when no Reply-To exists'), text: body }).strict(),
} as const
export type QQMailRequest = { [K in keyof typeof qqMailCommands]: { method: K; data: z.infer<typeof qqMailCommands[K]> } }[keyof typeof qqMailCommands]

function method(path: string): keyof typeof qqMailCommands {
  const value = path.replaceAll(' ', '.')
  if (!Object.hasOwn(qqMailCommands, value)) throw new ConnectorInputError('请通过 qqmail_schema 查询支持的邮件方法。')
  return value as keyof typeof qqMailCommands
}
export function qqMailSchema(path: string): string {
  if (['qqmail', 'identity', 'folder', 'message'].includes(path)) return JSON.stringify({ methods: Object.keys(qqMailCommands).filter(name => path === 'qqmail' || name.startsWith(`${path}.`)), usage: ['service', 'method', '--json', '{...}'] })
  const name = method(path)
  return JSON.stringify({ method: name, input: z.toJSONSchema(qqMailCommands[name]), note: 'Use UID and uid_validity from list results. Supply both before_uid and uid_validity for pagination. Sender and credentials are managed by the client.' })
}
export function qqMailRequest(args: string[]): QQMailRequest {
  if (!Array.isArray(args) || args.length !== 4 || args[2] !== '--json' || args.some(v => typeof v !== 'string' || v.length > 150000 || v.includes('\0'))) throw new ConnectorInputError('调用格式为 [服务, 方法, "--json", JSON对象]。')
  const name = method(`${args[0]}.${args[1]}`)
  let value: unknown
  try { value = JSON.parse(args[3]) } catch { throw new ConnectorInputError('请传入有效 JSON 对象。') }
  const result = qqMailCommands[name].safeParse(value)
  if (!result.success) throw new ConnectorInputError(`参数不符合 ${name} 契约，请先查看 qqmail_schema。`)
  return { method: name, data: result.data } as QQMailRequest
}
