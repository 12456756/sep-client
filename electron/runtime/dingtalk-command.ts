import { runConnectorProcess, type ConnectorProcessOptions } from './connector-process'
import { normalizeConnectorJsonArgs } from './connector-command'
import { ConnectorInputError, type ConnectorCommandDecision, type ConnectorCommandResult, type ScheduledExternalOperation } from '../domain/connectors'
import { scheduledDingTalkActionLabels } from '../../src/shared/scheduled-tasks'
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

const tableScope = ['--base-id', '--table-id']
const recordQueryFlags = ['--cursor', '--field-ids', '--filters', '--limit', '--page-limit', '--query', '--record-ids', '--sort', '--view-id']
const recordStatsFlags = ['--data-version', '--filters', '--limit', '--sort']
// Scheduled classification does not change the interactive approval allowlist.
const scheduledTableReads: readonly ReadCommand[] = [
  ['aitable base search', ['--query'], ['--cursor']],
  ['aitable base list', [], ['--cursor', '--limit']],
  ['aitable base get', ['--base-id']],
  ['aitable table get', ['--base-id'], ['--table-ids']],
  ['aitable table list', ['--base-id'], ['--table-ids']],
  ['aitable field get', tableScope, ['--field-ids']],
  ['aitable record get', [...tableScope, '--record-ids'], ['--field-ids']],
  ['aitable record list', tableScope, recordQueryFlags, ['--all']],
  ['aitable record query', tableScope, recordQueryFlags, ['--all']],
  ['aitable record stats', [...tableScope, '--stats'], [...recordStatsFlags, '--keyword', '--search-field-ids']],
  ['aitable record group-stats', [...tableScope, '--stats'], [...recordStatsFlags, '--group']],
]
const psqlAliases: Readonly<Record<string, string>> = { '-d': '--database', '-c': '--command', '-t': '--table', '-l': '--list', '-x': '--expanded' }

function readFlags(args: string[], required: readonly string[], optional: readonly string[] = [], switches: readonly string[] = [], aliases?: Readonly<Record<string, string>>): Map<string, string> | undefined {
  const fields = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    // Accept the same literal values in --flag value and --flag=value form.
    const arg = args[index]
    const separator = arg.indexOf('=')
    const flag = separator < 0 ? arg : arg.slice(0, separator)
    const key = aliases && Object.hasOwn(aliases, flag) ? aliases[flag] : flag
    if (fields.has(key)) return
    if (separator < 0 && switches.includes(key)) { fields.set(key, ''); continue }
    if (!required.includes(key) && !optional.includes(key)) return
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1)
    if (!value?.trim() || value.startsWith('-')) return
    fields.set(key, value)
  }
  if (required.every(key => fields.has(key))) return fields
}

export function isScheduledDingTalkReadOnly(input: string[]): boolean {
  let args: string[]
  try { args = validateDingTalkArgs(input).slice(0, -3) } catch { return false }
  if (args[0] !== 'aitable') return false
  if (args[1] === 'psql') {
    const fields = readFlags(args.slice(2), ['--database'], ['--command', '--table', '--limit', '--timeout'], ['--list', '--expanded', '--all-properties'], psqlAliases)
    if (!fields || ['--command', '--table', '--list'].filter(flag => fields.has(flag)).length !== 1) return false
    // DWS psql accepts only read queries; keep this allowlist to documented SELECT usage.
    return !fields.has('--command') || /^\s*SELECT\b/i.test(fields.get('--command')!)
  }
  return scheduledTableReads.some(([path, required, optional, switches]) => {
    const parts = path.split(' ')
    return parts.every((part, index) => args[index] === part) && !!readFlags(args.slice(parts.length), required, optional, switches)
  })
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

export function describeScheduledDingTalkOperation(args: string[]): ScheduledExternalOperation {
  const dingTalkAction = (Object.keys(scheduledDingTalkActionLabels) as (keyof typeof scheduledDingTalkActionLabels)[])
    .find(path => path.split(' ').every((part, index) => args[index] === part))
  const description = dingTalkAction ? { dingTalkAction } : {}
  const decision = evaluateDingTalkCommand(args)
  if (decision?.kind === 'approval' && decision.summary.kind === 'dingtalk-message') {
    const { target, body, targetType } = decision.summary
    return { identity: ['message', targetType, target, body], target, ...description }
  }
  return { identity: ['command', args], ...description }
}

export function dingTalkFailureReason(text: string): ConnectorCommandResult['scheduledReason'] {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object') return
    if ('error' in value && value.error && typeof value.error === 'object') {
      const error = value.error
      if ('category' in error && (error.category === 'auth' || error.category === 'authentication')) return 'authentication-required'
    }
    if ('summary' in value && typeof value.summary === 'string' &&
      /^(?:base|table|field|record|view) not found$/i.test(value.summary.trim())) return 'resource-not-found'
  } catch { /* Unstructured connector output is not safe to retain in history. */ }
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
