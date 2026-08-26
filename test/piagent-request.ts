import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type BeforeProviderHeadersEvent,
  type BeforeProviderRequestEvent,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'

const MODEL_ID = 'piagent-request-test-model'
const REQUEST_TIMEOUT_MS = 30_000

type JsonObject = Record<string, unknown>

function printJson(label: string, value: unknown): void {
  console.log(`\n${label}`)
  console.log(JSON.stringify(value, null, 2))
}

function redactHeaders(headers: IncomingMessage['headers']): JsonObject {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const sensitive = /authorization|cookie|token|api[-_]?key/i.test(key)
    return [key, sensitive ? '[redacted]' : value]
  }))
}

function sendSse(res: ServerResponse, chunks: JsonObject[]): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function toolCallResponse(): JsonObject[] {
  const id = `chatcmpl-tool-${Date.now()}`
  return [
    {
      id,
      object: 'chat.completion.chunk',
      model: MODEL_ID,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_piagent_test',
            type: 'function',
            function: { name: 'bash', arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      model: MODEL_ID,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"echo piagent-test"}' } }] },
        finish_reason: null,
      }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ]
}

function finalTextResponse(): JsonObject[] {
  const id = `chatcmpl-final-${Date.now()}`
  return [
    {
      id,
      object: 'chat.completion.chunk',
      model: MODEL_ID,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'PiAgent request test complete.' }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
}

async function startGateway(requests: JsonObject[]): Promise<{ url: string; close: () => Promise<void> }> {
  let requestNumber = 0
  const server = createServer(async (req, res) => {
    const rawBody = await readBody(req)
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      res.statusCode = 400
      res.end('invalid JSON')
      return
    }

    requestNumber += 1
    const captured = {
      requestNumber,
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers),
      body,
    }
    requests.push(captured)
    printJson(`[gateway] request #${requestNumber}`, captured)

    if (requestNumber === 1) {
      sendSse(res, toolCallResponse())
      return
    }
    sendSse(res, finalTextResponse())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to resolve gateway address')

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

const testExtension = (events: string[]): ExtensionFactory => pi => {
  pi.on('before_provider_request', (event: BeforeProviderRequestEvent) => {
    events.push('before_provider_request')
    printJson('[pi] before_provider_request payload', event.payload)
    return event.payload
  })
  pi.on('before_provider_headers', (event: BeforeProviderHeadersEvent) => {
    events.push('before_provider_headers')
    event.headers.authorization = 'Bearer piagent-test-token'
  })
  pi.on('after_provider_response', event => {
    events.push(`after_provider_response:${event.status}`)
    printJson('[pi] after_provider_response', { status: event.status, headers: event.headers })
  })
  pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
    events.push(`tool_call:${event.toolName ?? 'unknown'}`)
    printJson('[pi] tool_call approval request', { toolName: event.toolName, input: event.input })
    return { block: false }
  })
}

async function waitForSettled(session: Awaited<ReturnType<typeof createAgentSession>>['session']): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`session timeout after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS)
    session.subscribe(event => {
      if (event.type === 'message_update' || event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        printJson(`[pi] ${event.type}`, event)
      } else {
        console.log(`[pi] event: ${event.type}`)
      }
      if (event.type === 'agent_end' && event.willRetry === false) {
        const messages = event.messages as Array<{ role?: string; errorMessage?: string; stopReason?: string }>
        const failure = messages.find(message => message.role === 'assistant' && message.errorMessage)
        if (failure) console.error(`[pi] agent error: ${failure.errorMessage}`)
      }
      if (event.type === 'agent_settled') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

async function main(): Promise<void> {
  console.log('=== PiAgent model request structure test ===')
  console.log(`SDK model: ${MODEL_ID}`)

  const requests: JsonObject[] = []
  const events: string[] = []
  const gateway = await startGateway(requests)
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined

  try {
    console.log(`Gateway: ${gateway.url}/chat/completions`)
    const modelRuntime = await ModelRuntime.create({ modelsPath: null })
    modelRuntime.registerProvider('local-test-gateway', {
      name: 'Local test gateway',
      baseUrl: gateway.url,
      apiKey: 'placeholder',
      api: 'openai-completions',
      models: [{
        id: MODEL_ID,
        name: MODEL_ID,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      }],
    })
    const model = modelRuntime.getModel('local-test-gateway', MODEL_ID)
    if (!model) throw new Error('test model was not registered')

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: '.pi-test',
      extensionFactories: [testExtension(events)],
      noSkills: true,
      noContextFiles: true,
    })
    await resourceLoader.reload()
    const result = await createAgentSession({
      modelRuntime,
      model,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
    })
    session = result.session
    session.subscribe(event => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
        if (update?.type === 'text_delta' && update.delta) console.log(`[pi] text: ${update.delta}`)
      }
    })

    const prompt = 'Run the bash tool once, then report the result.'
    console.log(`\n[prompt] ${prompt}`)
    const settled = waitForSettled(session)
    await session.prompt(prompt)
    await settled

    printJson('[summary]', {
      requestCount: requests.length,
      requestBodies: requests.map(request => request.body),
      eventSequence: events,
    })
    if (requests.length !== 2) throw new Error(`expected two model requests, received ${requests.length}`)
    console.log('\nPASS: request bodies and PiAgent response events were captured.')
  } finally {
    await session?.dispose()
    await gateway.close()
  }
}

main().catch(error => {
  console.error('\nFAIL:', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
