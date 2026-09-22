import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { McpServerConfig } from './pi-agent-runtime'

const MAX_CONFIG_BYTES = 256_000
const stringMap = z.record(z.string(), z.string())
const toolNames = z.array(z.string().min(1).max(128)).max(128)
const transportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'), command: z.string().min(1),
    args: z.array(z.string()).optional(), env: stringMap.optional(),
    cwd: z.string().refine(isAbsolute).optional(),
  }).strict(),
  z.object({
    type: z.literal('streamable-http'),
    url: z.string().url().refine(value => {
      const url = new URL(value)
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      return !url.username && !url.password && !url.hash &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && local))
    }),
    headers: stringMap.refine(headers => Object.entries(headers).every(([key, value]) =>
      /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) && !/[\r\n]/.test(value),
    )).optional(),
  }).strict(),
])
const serversSchema = z.array(z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,19}$/).refine(name => !name.includes('__')),
  transport: transportSchema,
  enabledTools: toolNames.optional(), autoApproveTools: toolNames.optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
}).strict()).max(16).superRefine((servers, context) => {
  if (new Set(servers.map(server => server.name)).size !== servers.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate server name' })
  }
  for (const server of servers) {
    if (server.autoApproveTools?.some(name => !server.enabledTools?.includes(name))) {
      context.addIssue({ code: 'custom', message: 'Auto-approval requires explicit enablement' })
    }
  }
})

export function parseMcpServers(input: unknown): McpServerConfig[] {
  const result = serversSchema.safeParse(input)
  // Do not include Zod's input values: configuration may contain credentials.
  if (!result.success) throw new Error('Invalid MCP configuration: check server names, transport, enabledTools and autoApproveTools.')
  return result.data
}

/** No workspace discovery: only the host-selected absolute file is trusted. */
export async function loadMcpServers(path: string | undefined): Promise<McpServerConfig[]> {
  if (!path) return []
  if (!isAbsolute(path)) throw new Error('MCP configuration path must be absolute.')
  let input: unknown
  try {
    if ((await stat(path)).size > MAX_CONFIG_BYTES) throw new Error('Configuration too large')
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error('Configuration too large')
    input = JSON.parse(text)
  } catch {
    throw new Error('Cannot read MCP configuration: expected a UTF-8 JSON file of at most 256 KB.')
  }
  const document = z.object({ servers: z.unknown() }).strict().safeParse(input)
  if (!document.success) throw new Error('Invalid MCP configuration: expected { servers: [...] }.')
  return parseMcpServers(document.data.servers)
}
