import { runConnectorProcess, type ConnectorProcessOptions } from './connector-process'
import { normalizeConnectorJsonArgs } from './connector-command'
import { ConnectorInputError } from '../domain/connectors'

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
