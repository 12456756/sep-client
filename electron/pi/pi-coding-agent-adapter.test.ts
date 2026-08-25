import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  classifyGatewayError,
  createGatewayFetch,
  gatewayBackoffMs,
  normalizeGatewayPayload,
  parseRetryAfterMs,
} from './sdk/pi-coding-agent-adapter'

describe('SEP gateway payload compatibility', () => {
  it('flattens tool calls and tool results into supported messages', () => {
    const result = normalizeGatewayPayload({
      model: 'gpt-5.2',
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        },
        { role: 'tool', content: 'file-a.txt', tool_call_id: 'call-1' },
      ],
    }) as { messages: Array<Record<string, unknown>> }

    assert.deepEqual(result.messages, [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: '[tool call: bash] {"command":"ls"}' },
      { role: 'user', content: '[tool result]\nfile-a.txt' },
    ])
  })

  it('leaves ordinary requests unchanged', () => {
    const payload = { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hello' }] }
    assert.deepEqual(normalizeGatewayPayload(payload), {
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('removes provider-only fields and converts content parts to strings', () => {
    const result = normalizeGatewayPayload({
      model: 'gpt-5.2',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }], extra: true }],
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
    })
    assert.deepEqual(result, {
      model: 'gpt-5.2',
      messages: [{ role: 'assistant', content: 'hello' }],
      stream: true,
    })
  })
})

describe('SEP gateway retry policy', () => {
  it('refreshes an expired employment token once and uses it on the retry', async () => {
    const authorizations: Array<string | null> = []
    let requests = 0
    let refreshes = 0
    const baseFetch: typeof fetch = async (_input, init) => {
      requests += 1
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return requests === 1 ? new Response('', { status: 401 }) : new Response('ok')
    }
    const gatewayFetch = createGatewayFetch({
      refreshAccessToken: async () => {
        refreshes += 1
        return 'replacement-token'
      },
    }, baseFetch, async () => undefined)

    const response = await gatewayFetch('https://sep.example/gateway', {
      headers: { Authorization: 'Bearer expired-token' },
    })

    assert.equal(response.status, 200)
    assert.equal(requests, 2)
    assert.equal(refreshes, 1)
    assert.deepEqual(authorizations, ['Bearer expired-token', 'Bearer replacement-token'])
  })

  it('does not loop when the refreshed employment token is also unauthorized', async () => {
    let requests = 0
    let refreshes = 0
    const gatewayFetch = createGatewayFetch({
      refreshAccessToken: async () => {
        refreshes += 1
        return 'still-invalid'
      },
    }, async () => {
      requests += 1
      return new Response('', { status: 401 })
    }, async () => undefined)

    const response = await gatewayFetch('https://sep.example/gateway')

    assert.equal(response.status, 401)
    assert.equal(requests, 2)
    assert.equal(refreshes, 1)
  })

  it('returns a forbidden response without retrying', async () => {
    let requests = 0
    const rejected: number[] = []
    const gatewayFetch = createGatewayFetch({
      onGatewayAuthorizationRejected: status => { rejected.push(status) },
    }, async () => {
      requests += 1
      return new Response('', { status: 403 })
    }, async () => undefined)

    const response = await gatewayFetch('https://sep.example/gateway')

    assert.equal(response.status, 403)
    assert.equal(requests, 1)
    assert.deepEqual(rejected, [403])
  })

  it('limits transient HTTP retries and respects Retry-After', async () => {
    const delays: number[] = []
    let requests = 0
    const gatewayFetch = createGatewayFetch({}, async () => {
      requests += 1
      return new Response('', { status: 429, headers: { 'Retry-After': '120' } })
    }, async delay => { delays.push(delay) })

    const response = await gatewayFetch('https://sep.example/gateway')

    assert.equal(response.status, 429)
    assert.equal(requests, 3)
    assert.deepEqual(delays, [60_000, 60_000])
  })

  it('limits network retries to two attempts after the initial request', async () => {
    let requests = 0
    const gatewayFetch = createGatewayFetch({}, async () => {
      requests += 1
      throw new TypeError('fetch failed')
    }, async () => undefined)

    await assert.rejects(() => gatewayFetch('https://sep.example/gateway'), /fetch failed/)
    assert.equal(requests, 3)
  })

  it('classifies gateway errors and caps backoff values', () => {
    assert.equal(classifyGatewayError({ status: 401 }).kind, 'unauthorized')
    assert.equal(classifyGatewayError({ response: { status: 403 } }).kind, 'forbidden')
    assert.equal(classifyGatewayError({ statusCode: 429, headers: { 'retry-after': '2.5' } }).kind, 'rate_limited')
    assert.equal(classifyGatewayError(new TypeError('fetch failed')).kind, 'transient')
    assert.equal(classifyGatewayError({ status: 400 }).kind, 'non_retryable')
    assert.equal(parseRetryAfterMs('120'), 60_000)
    assert.equal(parseRetryAfterMs('not-a-date'), undefined)
    assert.equal(gatewayBackoffMs({ kind: 'transient', retryable: true, message: 'failed' }, 20), 8_000)
  })
})
