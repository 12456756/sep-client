import type { FeishuToken } from './feishu-oauth'
import { runConnectorProcess, type ConnectorProcessOptions } from './connector-process'
import { normalizeConnectorJsonArgs } from './connector-command'

export const FEISHU_PRODUCTS = new Set(['calendar', 'im', 'docs', 'docx', 'drive', 'wiki', 'base', 'bitable', 'sheets', 'slides', 'task', 'contact', 'mail', 'vc', 'meeting', 'minutes', 'attendance', 'approval', 'okr', 'search', 'board', 'whiteboard', 'markdown'])
const forbidden = /^--?(?:as|profile|app[-_]?id|app[-_]?secret|client[-_]?id|client[-_]?secret|.*token|config.*|credential.*|debug|verbose|trace|format|json|f|yes|y|jq|help|h|api[-_]?base.*|base[-_]?url|endpoint|host|header|headers|brand|proxy.*)(?:=|$)/i
export function validateFeishuArgs(args: string[]): string[] {
  args = normalizeConnectorJsonArgs(args)
  if (!Array.isArray(args) || args.length < 2 || args.length > 128 || !FEISHU_PRODUCTS.has(args[0])) throw new Error('Unsupported Feishu command.')
  if (args.some(arg => typeof arg !== 'string' || arg.length > 64000 || arg.includes('\0') || arg === '--' || forbidden.test(arg))) throw new Error('Unsupported Feishu argument.')
  const firstFlag = args.findIndex(arg => arg.startsWith('-'))
  const path = args.slice(0, firstFlag < 0 ? args.length : firstFlag)
  if (path.some(arg => /^(?:credentials?|secrets?|auth|exec|shell|install|upgrade|serve|listen|consume|start|connect)$/i.test(arg))) throw new Error('Unsupported Feishu command.')
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
