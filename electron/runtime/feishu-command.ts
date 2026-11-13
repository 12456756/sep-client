import type { FeishuToken } from './feishu-oauth'
import { runConnectorProcess, type ConnectorProcessOptions } from './connector-process'
import { normalizeConnectorJsonArgs } from './connector-command'
import { ConnectorInputError } from '../domain/connectors'

export const FEISHU_PRODUCTS = new Set(['calendar', 'im', 'docs', 'docx', 'drive', 'wiki', 'base', 'bitable', 'sheets', 'slides', 'task', 'contact', 'mail', 'vc', 'meeting', 'minutes', 'attendance', 'approval', 'okr', 'search', 'board', 'whiteboard', 'markdown'])
const forbidden = /^--?(?:as|profile|app[-_]?id|app[-_]?secret|client[-_]?id|client[-_]?secret|.*token|config.*|credential.*|debug|verbose|trace|format|json|f|yes|y|jq|help|h|api[-_]?base.*|base[-_]?url|endpoint|host|header|headers|brand|proxy.*)(?:=|$)/i
export function validateFeishuArgs(args: string[]): string[] {
  args = normalizeConnectorJsonArgs(args)
  const normalized: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--as') {
      if (args[++index] !== 'user') throw new ConnectorInputError('飞书连接器仅允许当前授权用户身份，请移除 --as 或使用 --as user。')
    } else if (args[index] === '--as=user') {
      continue
    } else normalized.push(args[index])
  }
  args = normalized
  if (args.length < 2 || !FEISHU_PRODUCTS.has(args[0])) throw new ConnectorInputError('不支持该飞书命令，请先调用 feishu_schema 查询正式命令。')
  if (args.some(arg => arg === '--' || forbidden.test(arg))) throw new ConnectorInputError('参数包含客户端管理的配置或受限选项，请移除身份、输出、调试及确认参数，并查询 feishu_schema。')
  const firstFlag = args.findIndex(arg => arg.startsWith('-'))
  const path = args.slice(0, firstFlag < 0 ? args.length : firstFlag)
  if (path.some(arg => /^(?:credentials?|secrets?|auth|exec|shell|install|upgrade|serve|listen|consume|start|connect)$/i.test(arg))) throw new ConnectorInputError('该命令涉及客户端配置或常驻进程，不支持通过业务连接器执行。')
  return [...args, '--as', 'user', '--format', 'json']
}
export function feishuSchemaArgs(path: string): string[] {
  const dotted = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/.test(path)
  const words = path.split(' ')
  if (path.length > 160 || !FEISHU_PRODUCTS.has(path.split(/[ .]/)[0]) || !dotted && !words.every(word => /^\+?[a-z][a-z0-9_-]*$/.test(word))) throw new Error('Invalid Feishu schema path.')
  return dotted ? ['schema', path] : [...words, '--help']
}
export interface FeishuProcessOptions extends Omit<ConnectorProcessOptions, 'environment'> {
  identity?: { clientId: string; token: FeishuToken }
}
export type FeishuRunner = (options: FeishuProcessOptions) => ReturnType<typeof runConnectorProcess>
export const runFeishu: FeishuRunner = options => runConnectorProcess({ ...options, environment: {
  LARKSUITE_CLI_CONFIG_DIR: options.directory,
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  ...(options.identity ? {
    LARKSUITE_CLI_APP_ID: options.identity.clientId,
    LARKSUITE_CLI_USER_ACCESS_TOKEN: options.identity.token.accessToken,
    LARKSUITE_CLI_BRAND: 'feishu', LARKSUITE_CLI_DEFAULT_AS: 'user', LARKSUITE_CLI_STRICT_MODE: 'user',
  } : {}),
} })
