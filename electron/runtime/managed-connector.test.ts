import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ConnectorDependencyPort } from '../domain/connector-dependencies'
import type { ConnectorRuntimePort } from '../domain/connectors'
import { ManagedConnector } from './managed-connector'

const owner = { enterpriseId: 'enterprise', memberId: 'member' }
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function fixture(dependency: ConnectorDependencyPort) {
  let connects = 0; let disconnects = 0; let calls = 0
  let current: typeof owner | null = owner
  const runtime: ConnectorRuntimePort = {
    state: async () => ({ id: 'feishu', status: connects ? 'connected' : 'disconnected', connectedAt: 1 }),
    connect: async () => { connects++ }, disconnect: async () => { disconnects++ }, cancel: () => {},
    binding: async () => ({ revision: '1', servers: [], fetch, commands: [{ id: 'feishu', name: '飞书', instructions: { reference: '', schema: '', execute: '' },
      reference: async () => { calls++; return 'guide' }, schema: async () => { calls++; return { text: 'schema', isError: false } }, execute: async () => { calls++; return { text: 'ok', isError: false } },
    }] }),
  }
  const managed = new ManagedConnector(runtime, dependency, () => current)
  return { managed, counts: () => ({ connects, disconnects, calls }), switchAccount: () => { current = null; managed.cancel() } }
}

test('state queries and tool discovery do not prepare dependencies; actual tools do', async () => {
  let preparations = 0
  const { managed, counts } = fixture({ ensure: async () => { preparations++ } })
  await managed.state(owner)
  const binding = await managed.binding(owner)
  assert.equal(preparations, 0)
  await binding!.commands![0].reference('guide')
  await binding!.commands![0].schema('schema')
  await binding!.commands![0].execute([], '.', new AbortController().signal)
  assert.equal(preparations, 3)
  assert.equal(counts().calls, 3)
})

test('connect exposes progress, deduplicates clicks, then continues authorization', async () => {
  let complete!: () => void
  let preparations = 0
  const { managed, counts } = fixture({ ensure: async (_signal, progress) => {
    preparations++; progress({ phase: 'downloading', received: 20, total: 100 })
    await new Promise<void>(resolve => { complete = resolve })
  } })
  await managed.connect(owner); await managed.connect(owner)
  assert.equal(preparations, 1)
  const state = await managed.state(owner)
  assert.equal(state.status, 'preparing')
  assert.equal(state.dependency?.received, 20)
  assert.equal(counts().connects, 0)
  complete(); await tick()
  assert.equal(counts().connects, 1)
  assert.equal((await managed.state(owner)).status, 'connected')
})

test('cancel and account switch prevent authorization without deleting existing credentials', async () => {
  for (const switchAccount of [false, true]) {
    const { managed, counts, switchAccount: change } = fixture({ ensure: async signal => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    } })
    await managed.connect(owner)
    if (switchAccount) change()
    else await managed.disconnect(owner)
    await tick()
    assert.equal(counts().connects, 0)
    assert.equal(counts().disconnects, 0)
  }
})

test('failed preparation is retryable and never invokes business commands', async () => {
  let fail = true
  const { managed, counts } = fixture({ ensure: async (_signal, progress) => {
    progress({ phase: 'downloading', received: 0, total: 100 })
    if (fail) throw new Error('network')
  } })
  const binding = await managed.binding(owner)
  await assert.rejects(binding!.commands![0].execute([], '.'), /组件尚未准备完成/)
  assert.equal(counts().calls, 0)
  await managed.connect(owner); await tick()
  assert.equal((await managed.state(owner)).status, 'error')
  assert.equal(counts().connects, 0)
  fail = false
  await managed.connect(owner); await tick()
  assert.equal(counts().connects, 1)
})

test('task cancellation and disconnect abort preparation before invoking an old tool binding', async () => {
  for (const disconnect of [false, true]) {
    const { managed, counts } = fixture({ ensure: async signal => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        if (signal.aborted) reject(new Error('cancelled'))
      })
    } })
    const binding = await managed.binding(owner)
    const controller = new AbortController()
    const call = binding!.commands![0].reference('guide', controller.signal)
    const rejected = assert.rejects(call, /组件尚未准备完成/)
    if (disconnect) await managed.disconnect(owner)
    else controller.abort()
    await rejected
    assert.equal(counts().calls, 0)
  }
})

test('cancelling while authorization starts does not wait for the browser before cancelling runtime', async () => {
  let finish!: () => void
  let cancelled = false
  const runtime: ConnectorRuntimePort = {
    state: async () => ({ id: 'feishu', status: cancelled ? 'disconnected' : 'authorizing' }),
    connect: async () => { await new Promise<void>(resolve => { finish = resolve }) },
    disconnect: async () => { cancelled = true; finish() }, binding: async () => undefined, cancel: () => {},
  }
  const managed = new ManagedConnector(runtime, { ensure: async () => {} }, () => owner)
  await managed.connect(owner)
  await tick()
  await managed.disconnect(owner)
  assert.equal((await managed.state(owner)).status, 'disconnected')
})
