import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { PiSkillRewriter } from './pi-skill-rewriter'
import type { SkillRewriteRuntimeInput } from '../domain/skill-rewrite'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiTaskWorker } from '../pi/sdk/pi-task-worker'

const input: SkillRewriteRuntimeInput = { requestId: '00000000-0000-4000-8000-000000000001', capabilityId: 'cap', versionId: 'v1',
  modelId: 'model', subscriptionId: 'sub', skillName: 'Report', content: '---\nname: report\n---\n# Body', prompt: 'Add sources',
  history: [{ prompt: 'Earlier', content: '---\nname: report\n---\n# Suggestion', status: 'ignored' }] }
const output = { body: '# Body\nSources required.', summary: 'Sources', changes: [{ kind: 'add', title: 'Sources', detail: 'Require sources.' }] }

test('model editing disables tools and skills, receives body/history, and repairs invalid responses', async () => {
  let disposed = 0
  const runtime = new PiSkillRewriter({ gatewayUrl: 'http://invalid', workspaceRoot: 'rewrites', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run(prompt) {
        assert.equal(options.context.disableTools, true)
        assert.equal(options.context.disableSkills, true)
        assert.equal(await options.onApprovalRequest({} as never), false)
        assert.deepEqual(JSON.parse(prompt), { skillName: 'Report', body: '# Body', prompt: 'Add sources', history: [{ prompt: 'Earlier', content: '# Suggestion', status: 'ignored' }] })
        assert.ok((await options.onResponseSettled?.({ text: 'invalid', stopReason: 'stop' }))?.continueWith)
        assert.ok((await options.onResponseSettled?.({ text: JSON.stringify({ ...output, body: '---\nname: changed\n---\nBody' }), stopReason: 'stop' }))?.continueWith)
        await options.onResponseSettled?.({ text: JSON.stringify(output), stopReason: 'stop' })
      }, async abort() {}, async dispose() { disposed++ },
    }),
  })
  assert.deepEqual(await runtime.rewrite(input, new AbortController().signal), output)
  assert.equal(disposed, 1)
})

test('invalid generation has bounded repairs and always releases its worker', async () => {
  let disposed = 0
  const runtime = new PiSkillRewriter({ gatewayUrl: 'http://invalid', workspaceRoot: 'rewrites', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() { for (let index = 0; index < 3; index++) await options.onResponseSettled?.({ text: '{}' }) },
      async abort() {}, async dispose() { disposed++ },
    }),
  })
  await assert.rejects(runtime.rewrite(input, new AbortController().signal), { code: 'SKILL_REWRITE_FAILED' })
  assert.equal(disposed, 1)
})

test('cancel interrupts an unresponsive model and ignores its later response', async () => {
  let aborted = 0; let disposed = 0
  const controller = new AbortController()
  const runtime = new PiSkillRewriter({ gatewayUrl: 'http://invalid', workspaceRoot: 'rewrites', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: () => ({ run: () => new Promise<void>(() => {}), async abort() { aborted++ }, async dispose() { disposed++ } }),
  })
  const pending = runtime.rewrite(input, controller.signal)
  controller.abort()
  await assert.rejects(pending, { code: 'SKILL_REWRITE_CANCELLED' })
  assert.equal(aborted, 1); assert.equal(disposed, 1)
})

test('real SDK sends a tool-free request to the gateway and returns the validated suggestion', { timeout: 30_000 }, async t => {
  const requests: Array<{ model: string; tools?: unknown[]; messages: Array<{ role: string; content: string }> }> = []
  const server = createServer((request, response) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { text += String(chunk) })
    request.on('end', () => {
      requests.push(JSON.parse(text) as typeof requests[number])
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [delta, finishReason] of [[{ role: 'assistant', content: JSON.stringify(output) }, null], [{}, 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'rewrite', object: 'chat.completion.chunk', model: 'model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const root = await mkdtemp(join(tmpdir(), 'sep-rewrite-gateway-'))
  const runtime = new PiSkillRewriter({ gatewayUrl: `http://127.0.0.1:${address.port}/v1`, workspaceRoot: root,
    getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => new PiTaskWorker({ ...options, createTokenManager: () => ({
      async initialize() {}, async getValidToken() { return 'test-only' }, stop() {},
    }) }),
  })
  assert.deepEqual(await runtime.rewrite(input, new AbortController().signal), output)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'model')
  assert.equal(requests[0].tools?.length ?? 0, 0)
  assert.match(requests[0].messages.find(message => message.role === 'system')!.content, /技能文档编辑器/)
  assert.equal(JSON.parse(requests[0].messages.find(message => message.role === 'user')!.content).body, '# Body')
})
