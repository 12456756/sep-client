import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import OpenAI, { APIError } from '../../node_modules/openai/index.mjs'
import type { FunctionTool, ResponseInputItem, ResponseOutputItem } from '../../node_modules/openai/resources/responses/responses.mjs'
import { z } from '../../node_modules/zod/index.js'

export type ModelAccess = { url: string; credential: string }

const chatRequest = z.object({
  model: z.string(), stream: z.literal(true),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string().nullish(), tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  })),
  tools: z.array(z.object({ function: z.object({ name: z.string(), description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()) }) })).default([]),
})

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const data of request) {
    const chunk = Buffer.from(data)
    size += chunk.length
    if (size > 4 * 1024 * 1024) throw new Error('Evaluation request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not bind the evaluation listener')
  return { url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}

function fail(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: { message } }))
}

export async function startResponsesRelay(access: ModelAccess, modelId: string, budget: number) {
  const credential = randomBytes(24).toString('hex')
  let requests = 0
  const sdk = new OpenAI({ baseURL: access.url, apiKey: access.credential, maxRetries: 0, timeout: 85_000,
    organization: null, project: null, fetch: async (input, init) => {
      if (requests >= budget) throw new Error('Evaluation request limit')
      requests++
      // Never send this credential to a redirect target.
      return fetch(input, { ...init, redirect: 'error' })
    } })
  const completedTurns = new Map<string, ResponseOutputItem[]>()
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${credential}`) {
      fail(response, 403, 'Invalid evaluation relay request.'); return
    }
    const controller = new AbortController()
    response.once('close', () => controller.abort())
    try {
      const chat = chatRequest.parse(await readJson(request))
      if (chat.model !== modelId) throw new Error('Unexpected evaluation model')
      const input: ResponseInputItem[] = []
      const instructions: string[] = []
      for (const message of chat.messages) {
        if (message.role === 'system') instructions.push(message.content ?? '')
        else if (message.role === 'tool') {
          if (!message.tool_call_id || message.content == null) throw new Error('Invalid tool result')
          input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content })
        } else if (message.role === 'assistant' && message.tool_calls?.length) {
          const previous = completedTurns.get(JSON.stringify(message.tool_calls.map(call => call.id)))
          if (!previous) throw new Error('Cannot replay an unknown tool turn')
          for (const item of previous) {
            if (item.type === 'reasoning' || item.type === 'function_call' || item.type === 'message') input.push(item)
          }
        } else if (message.content != null) input.push({ role: message.role, content: message.content })
      }
      const tools: FunctionTool[] = chat.tools.map(({ function: fn }) => ({ ...fn, type: 'function', strict: false }))
      const stream = await sdk.responses.create({ model: modelId, input, instructions: instructions.join('\n\n'), tools,
        stream: true, store: false, include: ['reasoning.encrypted_content'] }, { signal: controller.signal })
      for await (const event of stream) {
        if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') break
        if (event.type !== 'response.completed') continue
        const result = event.response
        const calls = result.output.filter(item => item.type === 'function_call')
        const text = result.output.flatMap(item => item.type === 'message' ? item.content.map(part =>
          part.type === 'output_text' ? part.text : part.refusal) : []).join('\n')
        if (calls.length) completedTurns.set(JSON.stringify(calls.map(call => call.call_id)), result.output)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (choices: unknown[], usage?: object) => response.write(`data: ${JSON.stringify({ id: result.id,
          object: 'chat.completion.chunk', model: modelId, choices, ...(usage ? { usage } : {}) })}\n\n`)
        chunk([{ index: 0, delta: { role: 'assistant', ...(text ? { content: text } : {}), ...(calls.length ? {
          tool_calls: calls.map((call, index) => ({ index, id: call.call_id, type: 'function',
            function: { name: call.name, arguments: call.arguments } })),
        } : {}) }, finish_reason: null }])
        chunk([{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }])
        if (result.usage) chunk([], { prompt_tokens: result.usage.input_tokens, completion_tokens: result.usage.output_tokens,
          total_tokens: result.usage.total_tokens, prompt_tokens_details: result.usage.input_tokens_details })
        response.end('data: [DONE]\n\n')
        return
      }
      fail(response, 502, 'Responses stream did not complete.')
    } catch (error) {
      if (response.destroyed || response.headersSent) return
      const status = error instanceof APIError && error.status && error.status >= 400 ? error.status : 502
      fail(response, status, 'Responses request did not complete.')
    }
  })
  const local = await listen(server)
  return { ...local, url: `${local.url}/v1`, credential, requests: () => requests }
}
