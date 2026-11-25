import { runConnectorProcess, type ConnectorProcessOptions } from './connector-process'
import { normalizeConnectorJsonArgs } from './connector-command'
import { ConnectorInputError, type ConnectorCommandDecision } from '../domain/connectors'
import { toolApprovalSummarySchema } from '../../src/shared/tool-approval'

export const DINGTALK_PRODUCTS = new Set(['aisearch', 'aitable', 'attendance', 'calendar', 'chat', 'contact', 'dev', 'devapp', 'devdoc', 'ding', 'doc', 'drive', 'event', 'hrbrain', 'html', 'live', 'mail', 'markdown', 'mind', 'minutes', 'oa', 'report', 'log', 'sheet', 'sport', 'todo', 'wiki', 'whiteboard', 'agoal', 'contract', 'dingtalk-tag', 'pat'])
const forbiddenFlag = /^--?(?:profile|client[-_]?id|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|mcp[-_]?url|pre[-_]?url|config(?:[-_]?dir)?|channel|debug|verbose|mock|format|f|yes|y|help|h|jq|output[-_]?file)(?:=|$)/i

export function validateDingTalkArgs(input: string[]): string[] {
  input = normalizeConnectorJsonArgs(input)
  if (input.length < 2 || !DINGTALK_PRODUCTS.has(input[0])) throw new ConnectorInputError('不支持该钉钉命令，请先调用 dingtalk_schema 查询正式命令。')
  if (input.some(arg => forbiddenFlag.test(arg))) throw new ConnectorInputError('参数包含客户端管理的配置或受限选项，请移除身份、输出、调试及确认参数，并查询 dingtalk_schema。')
  // These commands export credentials, execute arbitrary local programs, or manage the CLI itself.
  const flagIndex = input.findIndex(arg => arg.startsWith('-'))
  const command = input.slice(0, flagIndex === -1 ? input.length : flagIndex)
  if (command.some(arg => /^(?:credentials?|secrets?|exec|shell|install|upgrade|serve|listen|consume|start|connect)$/i.test(arg)) || input.includes('--')) throw new ConnectorInputError('该命令涉及客户端配置或常驻进程，不支持通过业务连接器执行。')
  return [...input, '--format', 'json', '--yes']
}

type ReadCommand = [path: string, required: readonly string[], optional?: readonly string[], switches?: readonly string[]]
// Exact read contracts, not permission by product, command prefix, or claimed effect.
const readCommands: readonly ReadCommand[] = [
  ['aisearch person', ['--query', '--dimension']],
  ['aisearch enterprise', ['--queries', '--types'], ['--time-range']],
  ['contact user get-self', []], ['contact user get', ['--ids']],
  ['contact user search', ['--query']], ['contact user search-mobile', ['--mobile']],
  ['contact dept search', ['--query']], ['contact dept get-info', ['--dept']],
  ['chat +chat-search', ['--query']], ['chat +chat-members-list', ['--group']],
  ['chat +unread-chats', []], ['chat +conversation-list', [], [], ['--page-all']],
  ['chat +chat-messages', [], ['--group', '--user', '--conversation-id', '--start', '--end'], ['--page-all', '--no-reactions']],
  ['chat message list-all', ['--start', '--end'], [], ['--page-all', '--no-reactions']],
]

function readFlags(args: string[], required: readonly string[], optional: readonly string[] = [], switches: readonly string[] = []): Map<string, string> | undefined {
  const fields = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    // Accept the same literal values in --flag value and --flag=value form.
    const arg = args[index]
    const separator = arg.indexOf('=')
    const key = separator < 0 ? arg : arg.slice(0, separator)
    if (fields.has(key)) return
    if (separator < 0 && switches.includes(key)) { fields.set(key, ''); continue }
    if (!required.includes(key) && !optional.includes(key)) return
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1)
    if (!value?.trim() || value.startsWith('-')) return
    fields.set(key, value)
  }
  if (required.every(key => fields.has(key))) return fields
}

export function evaluateDingTalkCommand(input: string[]): ConnectorCommandDecision | undefined {
  let args: string[]
  try { args = validateDingTalkArgs(input).slice(0, -3) } catch { return undefined }
  for (const [path, required, optional, switches] of readCommands) {
    const parts = path.split(' ')
    if (parts.every((part, index) => args[index] === part) && readFlags(args.slice(parts.length), required, optional, switches)) return { kind: 'read' }
  }
  const targetType = args[0] === 'chat' && args[1] === '+dm' ? 'person'
    : args[0] === 'chat' && args[1] === '+send-to-group' ? 'group' : undefined
  if (!targetType) return
  const targetKey = targetType === 'person' ? '--to' : '--group'
  const fields = readFlags(args.slice(2), [targetKey, '--content'])
  if (!fields) return
  const summary = toolApprovalSummarySchema.safeParse({ kind: 'dingtalk-message', targetType,
    target: fields.get(targetKey), body: fields.get('--content') })
  if (summary.success) return { kind: 'approval', summary: summary.data }
}

export function dingTalkSchemaArgs(path: string): string[] {
  const args = ['schema', path, '--compact', '--format', 'json']
  if (!path.includes(' ')) args.push('--jq', '{kind,level,count,product:{id:.product.id,tools:[.product.tools[]|{cli_path,agent_summary,effect,risk,availability}]}}')
  return args
}

export type DingTalkProcessOptions = Omit<ConnectorProcessOptions, 'environment'> & { keychainDirectory: string }
export type DingTalkRunner = (options: DingTalkProcessOptions) => ReturnType<typeof runConnectorProcess>
export const runDingTalk: DingTalkRunner = options => runConnectorProcess({ ...options, environment: {
  DWS_CONFIG_DIR: options.directory, DWS_KEYCHAIN_DIR: options.keychainDirectory, DWS_LANG: 'zh', DWS_NO_UPDATE_CHECK: '1',
} })
