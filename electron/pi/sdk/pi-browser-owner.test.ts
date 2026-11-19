import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { SharedBrowserOwner } from './pi-browser-owner'
import type { McpRuntime } from './pi-mcp-client'

it('leases reuse browser state, refresh handoff authorization and reject released rounds', async () => {
  let created = 0
  let closed = 0
  let handoffs = 0
  const owner = new SharedBrowserOwner()
  const factory = async (handoff: () => Promise<boolean>): Promise<McpRuntime> => {
    created++
    return { permissions: new Map(), tools: [{ name: 'test', label: 'test', description: '', promptSnippet: '', executionMode: 'sequential', parameters: {} as never,
      execute: async () => ({ content: [{ type: 'text', text: String(await handoff()) }], details: { serverName: 'playwright', toolName: 'test', isError: false } }),
    }], dispose: async () => { closed++ } }
  }
  const first = await owner.acquire('workspace', factory, async () => false)
  await first.dispose()
  const second = await owner.acquire('workspace', factory, async () => { handoffs++; return true })
  await assert.rejects(first.tools[0].execute('old', {}, undefined), /lease/i)
  assert.equal((await second.tools[0].execute('new', {}, undefined)).content[0].text, 'true')
  assert.equal(handoffs, 1)
  assert.equal(created, 1)
  assert.equal(closed, 0)
  await second.dispose()
  await owner.close()
  assert.equal(closed, 1)
})

it('revokes an active lease before cleanup and does not reuse uncertain operations', async () => {
  const owner = new SharedBrowserOwner()
  let signal: AbortSignal | undefined
  let finish!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let closed = 0
  const lease = await owner.acquire('workspace', async () => ({ permissions: new Map(), tools: [{
    name: 'test', label: 'test', description: '', promptSnippet: '', executionMode: 'sequential', parameters: {} as never,
    execute: async (_id, _input, cancellation) => {
      signal = cancellation
      entered()
      await new Promise<void>(resolve => { finish = resolve })
      return { content: [], details: { serverName: 'playwright', toolName: 'test', isError: false } }
    },
  }], dispose: async () => { closed++; finish() } }))
  const pending = lease.tools[0].execute('pending', {}, undefined)
  await started
  const rejection = assert.rejects(pending)
  await owner.close()
  assert.equal(signal?.aborted, true)
  await rejection
  assert.equal(closed, 1)
  await assert.rejects(lease.tools[0].execute('late', {}, undefined), /lease/i)
})

it('isolates workspaces and concurrent leases and expires idle browsers', async () => {
  const owner = new SharedBrowserOwner(15)
  let closed = 0
  const factory = async (): Promise<McpRuntime> => ({ tools: [], permissions: new Map(), dispose: async () => { closed++ } })
  const first = await owner.acquire('a', factory)
  await assert.rejects(owner.acquire('a', factory), /lease/i)
  await first.dispose()
  const next = await owner.acquire('b', factory)
  assert.equal(closed, 1)
  await next.dispose()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(closed, 2)
  await owner.close()
})

it('does not revive an initializing lease after account revocation or disposal', async () => {
  const owner = new SharedBrowserOwner()
  let entered!: () => void
  let finish!: () => void
  let closed = 0
  const started = new Promise<void>(resolve => { entered = resolve })
  const acquiring = owner.acquire('a', async () => {
    entered()
    await new Promise<void>(resolve => { finish = resolve })
    return { tools: [], permissions: new Map(), dispose: async () => { closed++ } }
  })
  const rejection = assert.rejects(acquiring, /lease/i)
  await started
  await owner.revoke()
  await assert.rejects(owner.acquire('b', async () => { throw new Error('must not run') }), /revoked/)
  finish()
  await rejection
  assert.equal(closed, 1)
  await owner.dispose()
  assert.throws(() => owner.resume(), /disposed/)
})

for (const reason of ['executionUncertain', 'browserSessionClosed'] as const) {
  it(`retires a browser after ${reason} instead of lending stale state to the next round`, async () => {
    const owner = new SharedBrowserOwner()
    let created = 0
    let closed = 0
    const factory = async (): Promise<McpRuntime> => {
      created++
      return { tools: [{ name: 'test', label: 'test', description: '', promptSnippet: '', executionMode: 'sequential', parameters: {} as never,
        execute: async () => ({ content: [], details: { serverName: 'playwright', toolName: 'test', isError: true, [reason]: true } }),
      }], permissions: new Map(), dispose: async () => { closed++ } }
    }
    try {
      const first = await owner.acquire('w', factory)
      await first.tools[0].execute('test', {}, undefined)
      await first.dispose()
      assert.equal(closed, 1)
      const next = await owner.acquire('w', factory)
      assert.equal(created, 2)
      await next.dispose()
    } finally { await owner.dispose() }
  })
}
