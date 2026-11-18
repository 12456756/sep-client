import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import type { PiAgentSessionConfig } from './pi-agent-runtime'

export async function assertMediaToolsInModelRequest(
  directory: string,
  hosts: Pick<PiAgentSessionConfig, 'mediaTools' | 'videoTools'>,
  expected: readonly string[],
): Promise<void> {
  let names: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { function: { name: string } }[] }
    names = body.tools?.map(tool => tool.function.name) ?? []
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const choice = { index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }
    response.end(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'chat-http', choices: [choice] })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const { PiCodingAgentAdapter } = await import('./pi-coding-agent-adapter')
    const session = await new PiCodingAgentAdapter().createSession({
      ...hosts, runId: 'runtime-http-tool-list', modelId: 'chat-http', gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      workspaceDir: directory, agentDir: join(directory, 'agent'), sessionDir: join(directory, 'session'),
      systemPrompt: 'Inspect enabled tools.', mcpServers: [], getAccessToken: async () => 'fixture-token',
      authorizeTool: async () => false,
    })
    try {
      await session.prompt('Confirm the available tools.')
      for (const name of expected) assert.ok(names.includes(name), `Missing ${name} in request tools: ${names.join(', ')}`)
    } finally {
      await session.dispose()
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
