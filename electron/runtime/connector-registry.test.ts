import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ConnectorRegistry } from './connector-registry'
import type { ConnectorRuntimePort } from '../domain/connectors'
import type { ConnectorId } from '../../src/shared/connectors'

test('registry dispatches independent providers and refreshes a deterministic aggregate revision', async () => {
  const connected = new Set<ConnectorId>(['dingtalk'])
  const cancelled: string[] = []
  const provider = (id: ConnectorId): ConnectorRuntimePort => ({ state: async () => ({ id, status: connected.has(id) ? 'connected' : 'disconnected' }), connect: async () => { connected.add(id) }, disconnect: async () => { connected.delete(id) }, cancel: () => { cancelled.push(id) }, binding: async () => connected.has(id) ? ({ revision: `${id}-1`, servers: [], fetch, commands: [{ id, name: id, instructions: { reference: '', schema: '', execute: '' }, reference: async () => '', schema: async () => ({ text: '', isError: false }), execute: async () => ({ text: '', isError: false }) }] }) : undefined })
  const registry = new ConnectorRegistry({ dingtalk: async () => provider('dingtalk'), feishu: async () => provider('feishu'), wecom: async () => provider('wecom'), tmeet: async () => provider('tmeet') })
  const owner = { enterpriseId: 'e', memberId: 'm' }
  const before = await registry.binding(owner)
  await (await registry.provider('feishu')).connect(owner)
  const both = await registry.binding(owner)
  assert.deepEqual(both?.commands?.map(command => command.id), ['dingtalk', 'feishu'])
  assert.notEqual(both?.revision, before?.revision)
  assert.equal((await registry.binding(owner))?.revision, both?.revision)
  await (await registry.provider('dingtalk')).disconnect(owner)
  assert.deepEqual((await registry.binding(owner))?.commands?.map(command => command.id), ['feishu'])
  await (await registry.provider('wecom')).connect(owner)
  assert.deepEqual((await registry.binding(owner))?.commands?.map(command => command.id), ['feishu', 'wecom'])
  registry.cancel(); assert.deepEqual(cancelled.sort(), ['dingtalk', 'feishu', 'tmeet', 'wecom'])
})

test('an unavailable provider does not hide another provider binding and can retry loading', async () => {
  let loads = 0
  const runtime: ConnectorRuntimePort = { state: async () => ({ id: 'dingtalk', status: 'connected' }), connect: async () => {}, disconnect: async () => {}, cancel: () => {}, binding: async () => ({ revision: 'legacy', servers: [], fetch }) }
  const registry = new ConnectorRegistry({ dingtalk: async () => runtime, feishu: async () => { loads++; throw new Error('missing runtime') }, wecom: async () => { throw new Error('missing WeCom runtime') }, tmeet: async () => { throw new Error('missing Tencent Meeting runtime') } })
  const scope = { enterpriseId: 'e', memberId: 'm' }
  assert.ok(await registry.binding(scope)); assert.ok(await registry.binding(scope)); assert.equal(loads, 2)
})

test('aggregate MCP fetch routes credentials only to the provider owning that endpoint', async () => {
  const routed: string[] = []
  const provider = (id: ConnectorId): ConnectorRuntimePort => ({ state: async () => ({ id, status: 'connected' }), connect: async () => {}, disconnect: async () => {}, cancel: () => {},
    binding: async () => ({ revision: id, servers: [{ name: id, transport: { type: 'streamable-http', url: `https://${id}.example/mcp` }, enabledTools: [] }], fetch: async () => { routed.push(id); return new Response('ok') } }),
  })
  const registry = new ConnectorRegistry({ dingtalk: async () => provider('dingtalk'), feishu: async () => provider('feishu'), wecom: async () => provider('wecom'), tmeet: async () => provider('tmeet') })
  const binding = await registry.binding({ enterpriseId: 'e', memberId: 'm' })
  assert.ok(binding)
  await binding.fetch('https://feishu.example/mcp')
  await binding.fetch(new Request('https://dingtalk.example/mcp'))
  await assert.rejects(binding.fetch('https://foreign.example/mcp'))
  assert.deepEqual(routed, ['feishu', 'dingtalk'])
})
