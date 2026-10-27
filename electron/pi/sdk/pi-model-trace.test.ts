import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { ModelTraceEntry } from '../../domain/model-trace'
import { modelPayloadText, readableTraceValue, traceModelStream } from './pi-model-trace'
import { redactModelTraceText } from '../../common/redact'

function message(text: string): AssistantMessage {
  return { role: 'assistant', api: 'openai-completions', provider: 'test', model: 'test', timestamp: 1, stopReason: 'stop',
    content: [{ type: 'text', text }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
it('labels every actual message role and preserves rich content and escaped text', () => {
  assert.match(readableTraceValue({ data: '业务数据' }), /业务数据/)
  assert.doesNotMatch(readableTraceValue({ type: 'image', data: 'PRIVATEBINARY' }), /PRIVATEBINARY/)
  const text = modelPayloadText({ model: 'test', messages: [
    { role: 'system', content: 'C:\\new\\test\n系统提示词' },
    { role: 'user', content: [{ type: 'text', text: '任务' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIVATEIMAGE' } }] },
    { role: 'tool', tool_call_id: 'call-a', content: '工具结果' },
  ], tools: [{ type: 'function', function: { name: 'read' } }] })
  assert.match(text, /系统消息/)
  assert.match(text, /用户消息/)
  assert.match(text, /工具返回/)
  assert.match(text, /任务/)
  assert.ok(text.includes('C:\\new\\test'))
  assert.doesNotMatch(text, /PRIVATEIMAGE/)
  assert.match(text, /工具定义/)
})

it('redacts structured credential keys without losing token usage diagnostics', () => {
  const result = readableTraceValue({ headers: { 'X-API-Key': 'PRIVATE_API', 'Proxy-Authorization': 'Basic PRIVATE_BASIC', 'Set-Cookie': 'auth=PRIVATE_COOKIE' },
    credentials: { 'access-token': 'PRIVATE_ACCESS', 'refresh-token': 'PRIVATE_REFRESH', id_token: 'PRIVATE_ID' }, max_tokens: 4096, usage: { totalTokens: 42 } })
  assert.doesNotMatch(result, /PRIVATE_/)
  assert.match(result, /"max_tokens": 4096/)
  assert.match(result, /"totalTokens": 42/)
})
it('does not wait for disk writes before forwarding stream events and records complete snapshots', async () => {
  const saved: ModelTraceEntry[] = []
  let complete = false
  async function* source(): AsyncGenerator<AssistantMessageEvent> {
    for (const delta of ['中文\nBearer spl', 'it-secret\n', '尾行']) yield { type: 'text_delta', delta, contentIndex: 0, partial: message('') }
    yield { type: 'done', reason: 'stop', message: message('中文\nBearer split-secret\n尾行') }
  }
  const iterator = traceModelStream(source(), async entry => { saved.push(entry); await new Promise<void>(() => {}) }, async () => { complete = true })
  for await (const event of iterator) void event
  assert.ok(complete)
  const last = saved.filter(entry => entry.kind === 'output').at(-1)!
  assert.equal(last.text, '中文\nBearer split-secret\n尾行')
  assert.ok(last.replace)
  assert.doesNotMatch(redactModelTraceText(last.text), /split-secret/)
})
it('keeps partial outputs on interruption and records stream timing separately', async () => {
  const saved: ModelTraceEntry[] = []
  async function* source(): AsyncGenerator<AssistantMessageEvent> {
    yield { type: 'text_delta', delta: '未完成内容', contentIndex: 0, partial: message('') }
    throw new Error('connection closed')
  }
  await assert.rejects(async () => {
    for await (const event of traceModelStream(source(), async entry => { saved.push(entry) }, async () => {})) void event
  }, /connection closed/)
  assert.match(saved.find(entry => entry.kind === 'output')!.text, /未完成内容/)
  assert.match(saved.at(-1)!.text, /未正常结束/)
})

it('retains received content when the SDK error message has an empty block', async () => {
  const saved: ModelTraceEntry[] = []
  async function* source(): AsyncGenerator<AssistantMessageEvent> {
    yield { type: 'text_delta', delta: '已经收到', contentIndex: 0, partial: message('') }
    yield { type: 'error', reason: 'error', error: { ...message(''), stopReason: 'error' } }
  }
  for await (const event of traceModelStream(source(), async entry => { saved.push(entry) }, async () => {})) void event
  assert.equal(saved.filter(entry => entry.kind === 'output').at(-1)!.text, '已经收到')
})

it('records the first observable event before completion for an immediate provider error', async () => {
  const order: string[] = []
  async function* source(): AsyncGenerator<AssistantMessageEvent> {
    yield { type: 'error', reason: 'error', error: { ...message(''), stopReason: 'error' } }
  }
  for await (const event of traceModelStream(source(), async () => {}, async () => { order.push('complete') }, Date.now(), () => { order.push('progress') })) void event
  assert.deepEqual(order, ['progress', 'complete'])
})
