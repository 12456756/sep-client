import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import { buildExtensions } from './pi-coding-agent-adapter'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import type { McpRuntime } from './pi-mcp-client'
import { BROWSER_MODE_TOOL } from './pi-browser-runtime'

test('scheduled tools use actual inputs without approval and leave conversation approval unchanged', async () => {
  const ding = 'dingtalk_execute', mail = 'qqmail_execute', navigate = 'mcp__playwright__browser_navigate'
  const click = 'mcp__playwright__browser_click', fill = 'mcp__playwright__browser_fill_form', snapshot = 'mcp__playwright__browser_snapshot'
  const unclassified = 'mcp__other__publish'
  const active = [ding, mail, navigate, click, fill, snapshot, unclassified, BROWSER_MODE_TOOL]
  const runtime: McpRuntime = { builtinBrowser: true, tools: [], permissions: new Map(active.map(tool => [tool, 'confirm-each'])),
    dispose: async () => {}, scheduledConnectorExecutors: new Set([ding, mail]) }
  let asks = 0
  const blocked: Array<[string, string]> = []
  const base: PiAgentSessionConfig = { runId: 'test', modelId: 'm', gatewayUrl: '', workspaceDir: process.cwd(), agentDir: '', sessionDir: '',
    getAccessToken: async () => '', authorizeTool: async () => { asks++; return false } }
  const handlersFor = async (config: PiAgentSessionConfig) => {
    const handlers: Array<(event: ToolCallEvent) => Promise<ToolCallEventResult>> = []
    const api = { on: (name: string, handler: unknown) => { if (name === 'tool_call') handlers.push(handler as typeof handlers[number]) },
      registerTool: () => {}, getActiveTools: () => active } as unknown as ExtensionAPI
    for (const extension of buildExtensions(config, runtime)) await extension(api)
    return (toolName: string, input: Record<string, unknown>) => handlers[0]({ type: 'tool_call', toolCallId: 'operation', toolName, input })
  }
  const invoke = await handlersFor({ ...base, scheduledTools: {
    issue: async () => undefined, submit: async () => { throw new Error('Guard must not execute') },
    recordBlocked: async (tool, reason) => { blocked.push([tool, reason]) },
  } })
  for (const [tool, input] of [
    [navigate, { url: 'https://example.test/intake?step=entry' }], [snapshot, {}],
    [fill, { fields: [{ name: 'Name', type: 'textbox', target: 'e1', value: 'Alice' }] }], [click, { target: 'e2' }],
    [ding, { args: ['chat', '+dm', '--to', 'Alice', '--content', 'Hi'] }], [mail, { args: ['message', 'reply', '--json', '{}'] }],
  ] as const) assert.equal((await invoke(tool, input)).block, false, tool)
  assert.equal((await invoke(navigate, { url: 'file:///etc/passwd' })).block, true)
  assert.equal((await invoke(BROWSER_MODE_TOOL, { mode: 'visible' })).block, true)
  assert.equal((await invoke(unclassified, {})).block, true)
  assert.equal((await invoke('mcp__playwright__browser_run_code', {})).block, true)
  assert.equal(asks, 0)
  assert.deepEqual(blocked, [[navigate, 'scope-unverified'], [BROWSER_MODE_TOOL, 'interaction-required'], [unclassified, 'scope-unverified']])
  const conversation = await handlersFor(base)
  assert.equal((await conversation(click, { target: 'e2' })).block, true)
  assert.equal(asks, 1)
})
