import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ToolApprovals } from './run-approvals'
import { LOCAL_MEDIA_TOOL } from '../../src/shared/local-media-progress'
import { ORIGINAL_DOCUMENT_REPLACE_TOOL, RUN_PYTHON_TOOL } from '../../src/shared/python-tool'

const handoff = { taskId: 'task', runId: 'run', subscriptionId: 'sub', toolName: 'mcp__playwright__browser_set_mode',
  input: { operation: 'manual-handoff', autoDetect: true } }

test('interactive execution bypasses generic tool approval without creating pending requests', async () => {
  const approvals = new ToolApprovals({ onRequest: () => assert.fail('unexpected approval request'),
    onResolved: () => assert.fail('unexpected pending approval resolution') })
  for (const toolName of ['write', 'edit', LOCAL_MEDIA_TOOL, RUN_PYTHON_TOOL]) {
    assert.equal(await approvals.requestTaskTool({ ...handoff, toolName, input: {} }), true, toolName)
  }
  for (const toolName of ['feishu_execute', 'mcp__officecli__officecli', 'mcp__playwright__browser_click', 'mcp__custom__write']) {
    assert.equal(await approvals.requestTaskTool({ ...handoff, toolName, input: {}, registeredTool: true }), true, toolName)
  }
  assert.equal(approvals.size, 0)
})

test('existing consent and unattended execution do not inherit the interactive task default', async () => {
  let requestId = ''
  const approvals = new ToolApprovals({ onRequest: request => { requestId = request.requestId } })
  const reserved = [
    { toolName: 'file_select_original', input: { path: '/external/file.txt' } },
    { toolName: 'file_edit_once', input: {} },
    { toolName: ORIGINAL_DOCUMENT_REPLACE_TOOL, input: {}, registeredTool: true },
    { toolName: 'bash', input: {} },
    { toolName: 'media_generate_image', input: {} },
    { toolName: handoff.toolName, input: { profile: 'persistent' } },
    { toolName: 'dingtalk_execute', input: { args: ['--format=json', 'pat', 'grant'] }, registeredTool: true },
    { toolName: 'mcp__playwright__browser_snapshot', input: {}, registeredTool: true, summary: { kind: 'browser-snapshot', savesFile: true } },
  ] as const
  for (const request of reserved) {
    const result = approvals.requestTaskTool({ ...handoff, ...request })
    assert.equal(approvals.getPending(requestId)?.toolName, request.toolName)
    assert.equal(approvals.respond({ requestId, approved: false }), true)
    assert.equal(await result, false)
  }
  const result = approvals.requestTaskTool({ ...handoff, toolName: 'feishu_execute', input: {}, registeredTool: true }, undefined, true)
  assert.equal(approvals.getPending(requestId)?.toolName, 'feishu_execute')
  approvals.denyAll()
  assert.equal(await result, false)
})

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
