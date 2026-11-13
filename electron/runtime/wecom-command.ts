import { ConnectorInputError } from '../domain/connectors'
import { runConnectorProcess, type ConnectorProcessOptions } from './connector-process'

export const WECOM_SERVICES = new Set(['chat', 'message', 'identity', 'contact'])
const word = /^[a-z][a-z0-9_]*$/
const blocked = /^(?:auth|config|cache|schema|exec|shell|install|upgrade|listen|connect|upload|download|export|import)$/i

function commandPath(parts: string[]): void {
  if (parts.length < 1 || parts.length > 6 || !WECOM_SERVICES.has(parts[0]) || parts.some(part => !word.test(part) || blocked.test(part))) {
    throw new ConnectorInputError('请先调用 wecom_schema 查询消息、会话、身份或通讯录的正式命令。')
  }
}

export function wecomSchemaArgs(path: string): string[] {
  if (path.length > 160) throw new ConnectorInputError('企业微信命令路径过长。')
  if (path.includes('.')) {
    const parts = path.split('.')
    commandPath(parts)
    if (parts.length < 2) throw new ConnectorInputError('请输入完整方法路径。')
    return ['schema', 'get', path]
  }
  const parts = path.split(' ')
  commandPath(parts)
  return [...parts, '--help']
}

export function validateWecomArgs(args: string[]): string[] {
  if (args.length > 24 || args.some(arg => typeof arg !== 'string' || arg.length > 64000 || arg.includes('\0'))) throw new ConnectorInputError('企业微信调用参数无效。')
  const firstFlag = args.findIndex(arg => arg.startsWith('-'))
  const path = args.slice(0, firstFlag < 0 ? args.length : firstFlag)
  commandPath(path)
  if (path.length < 2) throw new ConnectorInputError('请输入业务方法，并先核对 wecom_schema。')
  const seen = new Set<string>()
  const normalized = [...path]
  for (let index = path.length; index < args.length; index++) {
    const flag = args[index]
    if (!['--json', '--page-count'].includes(flag) || seen.has(flag)) throw new ConnectorInputError('仅支持 --json 和 --page-count；身份、输出路径及配置由客户端管理。')
    seen.add(flag)
    const value = args[++index]
    if (flag === '--page-count') {
      if (!/^(?:[1-9]|10)$/.test(value ?? '')) throw new ConnectorInputError('分页数量应为 1 至 10。')
      if (!/^(?:list|get|search|messages|history|members|sessions)$/.test(path.at(-1) ?? '')) throw new ConnectorInputError('自动分页仅用于查询方法；发送操作不能分页重复执行。')
      normalized.push(flag, value)
    } else {
      let payload: unknown
      try { payload = JSON.parse(value) } catch { throw new ConnectorInputError('--json 必须是有效 JSON 对象。') }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ConnectorInputError('--json 必须是对象。')
      if (path[0] === 'message') {
        const data = payload as Record<string, unknown>
        const messageType = data.msg_type ?? data.msgtype
        if (messageType !== undefined && !['text', 'markdown'].includes(String(messageType))) throw new ConnectorInputError('首批连接器仅支持文本或 Markdown 消息。')
      }
      const check = (item: unknown, depth = 0): void => {
        if (depth > 20) throw new ConnectorInputError('JSON 层级过深。')
        if (!item || typeof item !== 'object') return
        for (const [key, nested] of Object.entries(item)) {
          if (/^(?:.*token|.*secret|authorization|headers?|config|endpoint|file_?path|local_?path|output(?:_dir)?)$/i.test(key)) throw new ConnectorInputError('首批消息连接器不接受凭据、网络配置和本地文件路径。')
          check(nested, depth + 1)
        }
      }
      check(payload)
      normalized.push(flag, JSON.stringify(payload))
    }
  }
  return normalized
}

export interface WecomProcessOptions extends Omit<ConnectorProcessOptions, 'environment'> { token?: string }
export type WecomRunner = (options: WecomProcessOptions) => ReturnType<typeof runConnectorProcess>
export const runWecom: WecomRunner = options => runConnectorProcess({ ...options, preferStdout: true, environment: {
  WECOM_CLI_CONFIG_DIR: options.directory,
  ...(options.token ? { WECOM_CLI_ACCESS_TOKEN: options.token } : {}),
} })

export function wecomAuthorizationUrl(output: string): string | undefined {
  const match = /https:\/\/work\.weixin\.qq\.com\/ai\/qc\/gen\?[A-Za-z0-9_%=&+./~-]+(?=\r?\n)/.exec(output)
  if (!match) return undefined
  const url = new URL(match[0])
  if (url.origin !== 'https://work.weixin.qq.com' || url.pathname !== '/ai/qc/gen' || url.username || url.password || url.hash || url.searchParams.get('source') !== 'wecom_cli_external' || url.searchParams.getAll('scode').length !== 1 || !url.searchParams.get('scode')) throw new Error('Unexpected WeCom authorization URL.')
  return url.href
}
