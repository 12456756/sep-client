import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { Type } from 'typebox'
import type { RegisteredToolPermissions } from '../../../pi-extension/guard'
import { logger } from '../../common/logger'
import { redactText } from '../../common/redact'
import { withTimeout } from '../../common/with-timeout'
import type { McpServerConfig } from './pi-agent-runtime'
import { parseMcpServers } from './pi-mcp-config'

const log = logger.child('pi-mcp')
const DEFAULT_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 2_000
const MAX_TOOL_PAGES = 32
const MAX_DISCOVERED_TOOLS = 512
const MAX_TOOL_NAME_LENGTH = 64
const MAX_TOOL_RESULT_CHARS = 128_000

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: { serverName: string; toolName: string; isError: boolean }
}

function safeText(text: string, config: McpServerConfig, maxLength?: number): string {
  // This public runtime switch is not a credential. Redacting "1" corrupts refs/URLs.
  const values = config.transport.type === 'stdio'
    ? Object.entries(config.transport.env ?? {}).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE').map(([, value]) => value)
    : Object.values(config.transport.headers ?? {})
  // A server may echo only the token, without its Authorization scheme.
  const bearerTokens = values.flatMap(value => /^Bearer\s+(\S+)$/i.exec(value)?.slice(1) ?? [])
  const secrets = [...values, ...bearerTokens, ...(config.transport.type === 'streamable-http'
    ? [...new URL(config.transport.url).searchParams.values()] : [])]
  const scrubbed = secrets.filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text)
  return redactText(scrubbed, maxLength)
}

export function mcpToolName(serverName: string, originalName: string): string {
  const prefix = `mcp__${serverName}__`
  const available = MAX_TOOL_NAME_LENGTH - prefix.length
  if (/^[a-zA-Z0-9_-]+$/.test(originalName) && originalName.length <= available) return prefix + originalName
  const hash = createHash('sha256').update(originalName).digest('hex').slice(0, 10)
  return prefix + originalName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, available - hash.length - 1) + '_' + hash
}

function resultFor(config: McpServerConfig, name: string, result: CallToolResult): McpToolResult {
  const text = result.content.filter(item => item.type === 'text').map(item => item.text)
  if (result.structuredContent !== undefined) text.push(JSON.stringify(result.structuredContent))
  const unsupported = result.content.filter(item => item.type !== 'text').map(item => item.type)
  if (unsupported.length) text.push(`Unsupported MCP content types: ${[...new Set(unsupported)].join(', ')}. Only text/structuredContent are supported.`)
  const isError = result.isError === true || (unsupported.length > 0 && !result.content.some(item => item.type === 'text') && result.structuredContent === undefined)
  return {
    content: [{ type: 'text', text: safeText(text.join('\n') || (isError ? 'MCP tool failed without details.' : 'MCP tool completed with no content.'), config, MAX_TOOL_RESULT_CHARS) }],
    details: { serverName: config.name, toolName: name, isError },
  }
}

function createTool(config: McpServerConfig, client: Client, tool: Tool) {
  const name = mcpToolName(config.name, tool.name)
  return {
    name, label: `${config.name}: ${tool.name}`,
    description: safeText(tool.description ?? `Call ${tool.name} on MCP server ${config.name}.`, config),
    promptSnippet: `MCP tool from ${config.name}: ${tool.name}.`,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
    // External effects are not assumed safe to run concurrently.
    executionMode: 'sequential' as const,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<McpToolResult> {
      // The SDK retains its request listener. Keep it off the shared session signal.
      const controller = new AbortController()
      const onAbort = (): void => controller.abort(signal?.reason)
      try {
        if (signal?.aborted) throw new Error('MCP tool call cancelled.')
        signal?.addEventListener('abort', onAbort, { once: true })
        const result = await client.callTool({ name: tool.name, arguments: params }, undefined, {
          signal: controller.signal, timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxTotalTimeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })
        return resultFor(config, tool.name, result as CallToolResult)
      } catch (error) {
        const message = signal?.aborted ? 'MCP tool call cancelled.' : error instanceof Error ? error.message : 'Unknown MCP error'
        // Returned as a tool result, never retried here. The Pi extension sets isError.
        return resultFor(config, tool.name, { isError: true, content: [{ type: 'text', text: `MCP tool failed (${name}): ${message}` }] })
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

export interface McpRuntime {
  readonly tools: ReturnType<typeof createTool>[]
  readonly permissions: RegisteredToolPermissions
  dispose(): Promise<void>
}

interface Connection {
  config: McpServerConfig
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport
}

function makeConnection(config: McpServerConfig, workspaceDir: string): Connection {
  const transport = config.transport.type === 'stdio'
    ? new StdioClientTransport({
      command: config.transport.command, args: config.transport.args, env: config.transport.env,
      cwd: config.transport.cwd ?? workspaceDir, stderr: 'pipe', maxBufferSize: 1_048_576,
    })
    : new StreamableHTTPClientTransport(new URL(config.transport.url), {
      requestInit: { headers: config.transport.headers, redirect: 'error' },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    })
  // Drain stderr without inheriting it into application logs (it can contain secrets).
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {})
  const client = new Client({ name: 'sep-client', version: '0.1.0' }, { capabilities: {} })
  client.onerror = error => log.warn('MCP transport error', { serverName: config.name, error: safeText(error.message, config) })
  return { config, client, transport }
}

async function discover(connection: Connection): Promise<Tool[]> {
  const { config, client } = connection
  const tools: Tool[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  const deadline = Date.now() + (config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('MCP tools/list timed out.')
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: remaining })
    tools.push(...result.tools)
    if (tools.length > MAX_DISCOVERED_TOOLS) throw new Error('MCP tools/list exceeds the tool limit.')
    if (!result.nextCursor) return tools
    if (seenCursors.has(result.nextCursor)) throw new Error('MCP tools/list repeated a pagination cursor.')
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw new Error('MCP tools/list exceeds the page limit.')
}

async function closeConnection(connection: Connection): Promise<void> {
  const { client, transport, config } = connection
  try {
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
      await withTimeout(transport.terminateSession(), CLOSE_TIMEOUT_MS, 'MCP terminate session')
    }
  } catch (error) {
    log.warn('MCP session termination failed', { serverName: config.name, error: safeText(String(error), config) })
  } finally {
    try {
      await withTimeout(client.close(), CLOSE_TIMEOUT_MS, 'MCP close')
    } catch (error) {
      log.warn('MCP connection close failed', { serverName: config.name, error: safeText(String(error), config) })
    }
  }
}

export async function createMcpRuntime(servers: readonly McpServerConfig[], workspaceDir: string): Promise<McpRuntime> {
  const configs = parseMcpServers(servers)
  const connections: Connection[] = []
  const tools: McpRuntime['tools'] = []
  const permissions = new Map<string, 'confirm-each' | 'auto-approve'>()
  let closing: Promise<void> | undefined
  const dispose = (): Promise<void> => closing ??= Promise.all(connections.map(closeConnection)).then(() => undefined)
  try {
    for (const config of configs) {
      if (!config.enabledTools?.length) continue
      const connection = makeConnection(config, workspaceDir)
      connections.push(connection)
      const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
      await withTimeout(connection.client.connect(connection.transport, { timeout }), timeout, 'MCP connect')
      const discovered = await discover(connection)
      const missing = config.enabledTools.filter(name => !discovered.some(tool => tool.name === name))
      if (missing.length) throw new Error(`MCP ${config.name}: configured tools missing: ${missing.join(', ')}`)
      for (const tool of discovered.filter(item => config.enabledTools?.includes(item.name))) {
        const definition = createTool(config, connection.client, tool)
        if (permissions.has(definition.name)) throw new Error(`MCP tool name collision: ${definition.name}`)
        permissions.set(definition.name, config.autoApproveTools?.includes(tool.name) ? 'auto-approve' : 'confirm-each')
        tools.push(definition)
      }
    }
    return { tools, permissions, dispose }
  } catch (error) {
    await dispose()
    const message = configs.reduce((text, config) => safeText(text, config), String(error))
    throw new Error(`MCP initialization failed: ${message}`)
  }
}
