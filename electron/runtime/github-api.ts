import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { GitHubCredentials } from '../../src/shared/connectors'
import { ConnectorInputError } from '../domain/connectors'

export const GITHUB_ENDPOINT = 'https://api.githubcopilot.com/mcp/'
export const GITHUB_READ_TOOLS = ['get_me', 'search_repositories', 'search_code', 'get_file_contents', 'list_branches', 'list_commits', 'get_commit', 'list_issues', 'search_issues', 'issue_read', 'list_pull_requests', 'search_pull_requests', 'pull_request_read'] as const
const WRITE_TOOLS = ['issue_write', 'add_issue_comment', 'create_pull_request'] as const
export function gitHubTools(readOnly: boolean): string[] { return [...GITHUB_READ_TOOLS, ...(readOnly ? [] : WRITE_TOOLS)] }

export function gitHubHttpFailure(status: number): ConnectorInputError {
  return new ConnectorInputError(status === 401 ? 'GitHub 令牌无效或已过期，请重新连接。'
    : status === 403 ? 'GitHub 拒绝访问，请检查令牌权限、组织授权及远程 MCP 访问策略。'
    : status === 429 ? 'GitHub 请求过于频繁，请稍后重试。'
    : 'GitHub 请求未完成；如已提交写入，请先在 GitHub 核实，勿自动重试。')
}

export function gitHubMcpFetch(credentials: GitHubCredentials, signal: AbortSignal, request: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href !== GITHUB_ENDPOINT) throw new ConnectorInputError('GitHub 请求地址无效。')
    signal.throwIfAborted()
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    headers.delete('Cookie'); headers.delete('Proxy-Authorization')
    headers.set('Authorization', `Bearer ${credentials.token}`)
    headers.set('X-MCP-Tools', gitHubTools(credentials.readOnly).join(','))
    headers.set('X-MCP-Readonly', String(credentials.readOnly))
    const source = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const combined = AbortSignal.any([signal, AbortSignal.timeout(60000), ...(source ? [source] : [])])
    try {
      combined.throwIfAborted()
      return await request(input, { ...init, headers, redirect: 'error', credentials: 'omit', signal: combined })
    } catch { throw new ConnectorInputError('GitHub 网络连接未完成，请检查网络；已提交的写入请先在 GitHub 核实，勿自动重试。') }
  }
}

async function identity(response: Response): Promise<string> {
  if (!response.ok) { await response.body?.cancel(); throw gitHubHttpFailure(response.status) }
  const reader = response.body?.getReader()
  if (!reader) throw new ConnectorInputError('GitHub 账号响应异常，请重试连接。')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 65536) throw new Error('Oversized identity')
      chunks.push(chunk.value)
    }
    return z.object({ login: z.string().min(1).max(39).regex(/^[A-Za-z0-9-]+$/) }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).login
  } catch { throw new ConnectorInputError('GitHub 账号响应异常，请重试连接。') }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export async function verifyGitHub(credentials: GitHubCredentials, signal: AbortSignal, request: typeof fetch): Promise<{ login: string; tools: string[] }> {
  let response: Response
  try { response = await request('https://api.github.com/user', { headers: { Authorization: `Bearer ${credentials.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', credentials: 'omit', signal }) }
  catch { throw new ConnectorInputError('GitHub 网络连接失败，请检查网络后重试。') }
  const login = await identity(response)
  const client = new Client({ name: 'csep-github-check', version: '1.0.0' }, { capabilities: {} })
  const authenticated = gitHubMcpFetch(credentials, signal, request)
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(GITHUB_ENDPOINT), { fetch: async (input, init) => {
      const result = await authenticated(input, init)
      if (!result.ok && result.status !== 405) { await result.body?.cancel(); throw gitHubHttpFailure(result.status) }
      return result
    } }), { timeout: 20000 })
    const names = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 32; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20000, signal })
      for (const tool of result.tools) names.add(tool.name)
      cursor = result.nextCursor
      if (!cursor) break
      if (cursors.has(cursor) || page === 31) throw new Error('Invalid tool pagination')
      cursors.add(cursor)
    }
    const tools = gitHubTools(credentials.readOnly).filter(name => names.has(name))
    if (!tools.includes('get_file_contents') || !tools.includes('search_repositories')) throw new ConnectorInputError('GitHub 仓库工具不可用，请检查令牌权限及远程 MCP 策略。')
    return { login, tools }
  } catch (error) {
    throw error instanceof ConnectorInputError ? error : new ConnectorInputError('GitHub 远程工具验证失败，请检查网络、令牌权限和远程 MCP 访问策略。')
  } finally { await client.close().catch(() => undefined) }
}
