import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ToolApprovals } from './run-approvals'

const handoff = { taskId: 'task', runId: 'run', subscriptionId: 'sub', toolName: 'mcp__playwright__browser_set_mode',
  input: { operation: 'manual-handoff', autoDetect: true } }

test('browser detection resolves only the originating handoff after delivery', async () => {
  const events: Array<[string, boolean, string]> = []
  let delivered = false
  const approvals = new ToolApprovals({ onRequest: async request => { if (request.toolName === handoff.toolName) { await Promise.resolve(); delivered = true } },
    onResolved: (request, approved, reason) => events.push([request.toolName, approved, reason]) })
  const unrelated = approvals.request({ ...handoff, toolName: 'bash', input: {} })
  try {
    assert.equal(await approvals.request(handoff, { signal: new AbortController().signal, waitForCompletion: async () => {
      assert.equal(delivered, true)
    } }), true)
    assert.equal(approvals.size, 1)
    assert.deepEqual(events, [[handoff.toolName, true, 'browser_handoff_detected']])
    assert.equal(await approvals.request(handoff), false, 'a payload cannot opt into detection without the host callback')
  } finally { approvals.denyAll(); await unrelated }
})

for (const outcome of ['manual', 'cancel', 'timeout'] as const) {
  test(`browser detection stops on ${outcome} and cannot resolve a second time`, async () => {
    const source = new AbortController()
    const events: boolean[] = []
    let id = ''
    let finish!: () => void
    let armed!: () => void
    let detectionSignal: AbortSignal | undefined
    const started = new Promise<void>(resolve => { armed = resolve })
    const approvals = new ToolApprovals({ timeoutMs: outcome === 'timeout' ? 40 : 5_000,
      onRequest: request => { id = request.requestId }, onResolved: (_request, approved) => events.push(approved) })
    const result = approvals.request(handoff, { signal: source.signal, waitForCompletion: signal => new Promise<void>(resolve => {
      detectionSignal = signal
      finish = resolve
      armed()
    }) })
    await started
    if (outcome === 'manual') assert.equal(approvals.respond({ requestId: id, approved: true }), true)
    if (outcome === 'cancel') source.abort()
    assert.equal(await result, outcome === 'manual')
    assert.equal(detectionSignal?.aborted, true)
    finish()
    await Promise.resolve()
    assert.deepEqual(events, [outcome === 'manual'])
  })
}
