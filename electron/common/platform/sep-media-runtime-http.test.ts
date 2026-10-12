import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { parseMediaCapabilities } from './media-contract'

test('SEP runtime contract passes through actual HTTP without enabling media execution', async t => {
  const fixtures: { media: unknown }[] = JSON.parse(readFileSync(
    new URL('./fixtures/sep-media-runtime-v1.json', import.meta.url), 'utf8',
  ))
  const requests: { path: string; authenticated: boolean }[] = []
  let media: unknown = fixtures[0].media
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    const authenticated = request.headers.authorization === 'Bearer fixture-access-not-a-real-token'
    requests.push({ path, authenticated })
    if (!authenticated) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }))
      return
    }
    if (path !== '/api/client/subscriptions/sub-http/runtime?mediaProtocolVersion=1') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      manifestVersion: 1, subscriptionId: 'sub-http', templateVersion: '1.0',
      employee: { id: 'employee-http', name: 'Fixture employee', version: '1.0', maxSteps: 10 },
      runtime: { systemPrompt: 'Fixture instructions', modelId: 'chat-fixture', allowedModels: ['chat-fixture'], skills: [],
        ...(media === undefined ? {} : { media }) },
    }))
  })
  const previousBaseUrl = process.env['SEP_BASE_URL']
  t.after(async () => {
    if (previousBaseUrl === undefined) delete process.env['SEP_BASE_URL']
    else process.env['SEP_BASE_URL'] = previousBaseUrl
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  process.env['SEP_BASE_URL'] = `http://127.0.0.1:${address.port}/api`
  const { getEmployeeRuntime } = await import('./platform-api')
  for (const fixture of fixtures) {
    media = fixture.media
    const manifest = await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')
    assert.deepEqual(manifest.runtime.media, fixture.media)
    assert.deepEqual(parseMediaCapabilities(manifest.runtime.media), { protocolVersion: 1, tools: [], profiles: [] })
    assert.equal(manifest.runtime.modelId, 'chat-fixture')
  }
  media = undefined
  assert.equal((await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')).runtime.media, undefined)
  await assert.rejects(getEmployeeRuntime('sub-http', 'invalid-fixture-token'), error => {
    assert.equal((error as { statusCode?: number }).statusCode, 401)
    return true
  })
  assert.equal(requests.length, 4)
  assert.equal(requests.filter(request => request.authenticated).length, 3)
  assert.ok(requests.every(request => request.path === '/api/client/subscriptions/sub-http/runtime?mediaProtocolVersion=1'))
})
