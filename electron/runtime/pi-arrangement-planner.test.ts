import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ArrangementDraft } from '../domain/arrangement-plan'
import type { ArrangementPlannerEmployee, ArrangementPlanningProgress } from '../domain/arrangement-planner'
import { PiTaskWorker, type PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import type { TaskWorkerPort } from './run-types'
import { PiArrangementPlanner } from './pi-arrangement-planner'

const employees: ArrangementPlannerEmployee[] = [
  {
    subscriptionId: 'sub-research',
    employeeId: 'employee-research',
    name: 'Researcher',
    description: 'Researches public information.',
    position: 'Researcher',
    functionalCategory: 'Research',
    allowedModels: ['model-research'],
    status: 'ACTIVE',
  },
  {
    subscriptionId: 'sub-writer',
    employeeId: 'employee-writer',
    name: 'Writer',
    description: 'Turns findings into a concise report.',
    position: 'Writer',
    functionalCategory: 'Content',
    allowedModels: ['model-writer'],
    status: 'ACTIVE',
  },
  {
    subscriptionId: 'sub-paused',
    employeeId: 'employee-paused',
    name: 'Paused employee',
    allowedModels: ['model-paused'],
    status: 'PAUSED',
  },
]

const draft: ArrangementDraft = {
  id: 'draft-a',
  schemaVersion: 1,
  revision: 2,
  owner: { memberId: 'member-a', enterpriseId: 'enterprise-a' },
  mode: 'auto',
  status: 'planning',
  title: '',
  goal: 'Prepare a market report.',
  confirmedInputs: ['Q1 brief'],
  sharedSkillIds: ['skill-a'],
  conversation: null,
  nodes: [],
  workspace: { mode: 'shared', path: null },
  permissions: { preset: 'read-only' },
  createdAt: 1,
  updatedAt: 1,
  lastPlanning: { planningId: 'planning-a', status: 'planning', message: null },
}

class FakeWorker implements TaskWorkerPort {
  readonly prompts: string[] = []
  readonly abortCalls: number[] = []
  readonly disposeCalls: number[] = []
  constructor(private readonly onEvent: PiTaskWorkerOptions['onEvent']) {}

  async run(prompt: string): Promise<void> {
    this.prompts.push(prompt)
    await this.onEvent({
      taskId: 'planning-a',
      runId: 'planning-a',
      subscriptionId: 'sub-research',
      sequence: 1,
      type: 'text_delta',
      occurredAt: Date.now(),
      data: {
        text: JSON.stringify({
          title: 'Market report',
          nodes: [
            {
              id: 'node-research',
              subscriptionId: 'sub-research',
              modelId: 'model-research',
              title: 'Research market',
              instruction: 'Collect relevant market facts.',
              expectedOutput: 'A source-backed fact set.',
              dependsOn: [],
              skillIds: ['skill-a'],
              requiresUserConfirmation: false,
            },
            {
              id: 'node-write',
              subscriptionId: 'sub-writer',
              modelId: 'model-writer',
              title: 'Write report',
              instruction: 'Turn the facts into a report.',
              expectedOutput: 'A concise market report.',
              dependsOn: ['node-research'],
              skillIds: [],
              requiresUserConfirmation: false,
            },
          ],
        }),
      },
    })
  }

  async abort(): Promise<void> {
    this.abortCalls.push(Date.now())
  }

  async dispose(): Promise<void> {
    this.disposeCalls.push(Date.now())
  }
}

describe('PiArrangementPlanner', () => {
  it('runs one independent worker and emits progressive employee selection', async () => {
    const progress: ArrangementPlanningProgress[] = []
    let capturedOptions: PiTaskWorkerOptions | undefined
    let worker: FakeWorker | undefined
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1',
      workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      createWorker: options => {
        capturedOptions = options
        worker = new FakeWorker(options.onEvent)
        return worker
      },
    })

    const result = await planner.plan({
      planningId: 'planning-a',
      draft,
      employees,
      onProgress: event => progress.push(event),
    })

    assert.equal(result.title, 'Market report')
    assert.deepEqual(result.nodes.map(node => node.subscriptionId), ['sub-research', 'sub-writer'])
    assert.deepEqual(progress.map(event => [event.type, event.data.subscriptionId]), [
      ['arrangement_employee_considering', 'sub-research'],
      ['arrangement_employee_considering', 'sub-writer'],
      ['arrangement_employee_selected', 'sub-research'],
      ['arrangement_employee_selected', 'sub-writer'],
    ])
    assert.equal(worker?.prompts.length, 1)
    assert.match(worker?.prompts[0] ?? '', /Prepare a market report\./)
    assert.match(worker?.prompts[0] ?? '', /不调用任何工具/)
    assert.equal(capturedOptions?.context.taskId, 'planning-a')
    assert.equal(capturedOptions?.context.runId, 'planning-a')
    assert.equal(capturedOptions?.context.subscriptionId, 'sub-research')
    assert.equal(capturedOptions?.context.modelId, 'model-research')
    assert.equal(capturedOptions?.context.resumeSessionFile, undefined)
    assert.deepEqual(capturedOptions?.context.toolPolicy?.allowedTools, [])
    assert.equal(capturedOptions?.context.toolPolicy?.commandPolicy, 'disabled')
    assert.equal(capturedOptions?.context.toolPolicy?.approvalMode, 'auto-approve')
    assert.equal(worker?.disposeCalls.length, 1)

    const controller = new AbortController()
    controller.abort()
    assert.equal(worker?.abortCalls.length, 0)
  })

  it('cancels the independent worker through the planner port', async () => {
    let releaseRun: (() => void) | undefined
    let worker: FakeWorker | undefined
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1',
      workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      createWorker: options => {
        worker = new FakeWorker(options.onEvent)
        worker.run = async () => await new Promise<void>(resolve => { releaseRun = resolve })
        return worker
      },
    })
    const planning = planner.plan({ planningId: 'planning-port-cancel', draft, employees, onProgress: () => {} })
    await new Promise<void>(resolve => setImmediate(resolve))
    planner.cancel('planning-port-cancel')
    releaseRun?.()

    await assert.rejects(planning, error => error instanceof DOMException && error.name === 'AbortError')
    assert.equal(worker?.abortCalls.length, 1)
    assert.equal(worker?.disposeCalls.length, 1)
  })

  it('aborts the independent worker when planning is cancelled', async () => {
    let releaseRun: (() => void) | undefined
    let worker: FakeWorker | undefined
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1',
      workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      createWorker: options => {
        worker = new FakeWorker(options.onEvent)
        worker.run = async () => await new Promise<void>(resolve => { releaseRun = resolve })
        return worker
      },
    })
    const controller = new AbortController()
    const planning = planner.plan({
      planningId: 'planning-a',
      draft,
      employees,
      signal: controller.signal,
      onProgress: () => {},
    })

    controller.abort()
    releaseRun?.()

    await assert.rejects(planning, error => error instanceof DOMException && error.name === 'AbortError')
    assert.equal(worker?.abortCalls.length, 1)
    assert.equal(worker?.disposeCalls.length, 1)
  })
})

function sendChunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'planner-response', object: 'chat.completion.chunk', created: 1, model: 'model-research', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

for (const invalidTools of [false, true]) {
  it(`real SDK planner: ${invalidTools ? 'stops malformed tool loops after the first response' : 'generates a draft with web search but without execution tools'}`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-planner-web-search-'))
    const requests: Array<{ tools?: unknown[] }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        requests.push(JSON.parse(body))
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (invalidTools && requests.length === 1) {
          // Reproduce the persisted failing session: empty bash arguments plus unknown "tool".
          sendChunk(response, { role: 'assistant', tool_calls: [
            { index: 0, id: 'empty-bash', type: 'function', function: { name: 'bash', arguments: '{}' } },
            { index: 1, id: 'unknown-tool', type: 'function', function: { name: 'tool', arguments: '{"command":"echo generating workflow"}' } },
          ] })
          sendChunk(response, {}, 'tool_calls')
        } else {
          sendChunk(response, { role: 'assistant', content: JSON.stringify({ title: 'Market report', nodes: [{
            id: 'node-1', subscriptionId: 'sub-research', modelId: 'model-research', title: 'Research',
            instruction: 'Research the market', expectedOutput: 'Facts', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
          }] }) })
          sendChunk(response, {}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    let approvals = 0
    const progress: ArrangementPlanningProgress[] = []
    const planner = new PiArrangementPlanner({
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, workspaceRoot: root,
      getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {},
      createWorker: options => new PiTaskWorker({
        ...options,
        onApprovalRequest: async () => { approvals++; return false },
        createTokenManager: () => ({ initialize: async () => {}, getValidToken: async () => 'test-token', stop: () => {} }),
      }),
    })
    try {
      const result = planner.plan({ planningId: 'planning-sdk-test', draft, employees, onProgress: event => progress.push(event) })
      if (invalidTools) {
        await assert.rejects(result, error => error instanceof Error && /工具调用/.test(error.message))
        assert.equal(progress.some(event => event.type === 'arrangement_employee_selected'), false)
      } else {
        assert.equal((await result).nodes.length, 1)
      }
      assert.equal(requests.length, 1, 'planning must not loop through tool errors')
      const advertisedToolNames = (requests[0]?.tools ?? []).map(tool => {
        if (!tool || typeof tool !== 'object') return null
        const name = (tool as { function?: { name?: unknown } }).function?.name
        return typeof name === 'string' ? name : null
      })
      assert.deepEqual(advertisedToolNames, ['web_search'], 'planning may search the web but must not advertise execution tools')
      assert.equal(approvals, 0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
}
