import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ArrangementDraft } from '../domain/arrangement-plan'
import type { ArrangementPlannerEmployee, ArrangementPlanningProgress } from '../domain/arrangement-planner'
import { ARRANGEMENT_PLANNER_RULES, buildArrangementPlannerInput, buildArrangementPlannerRepairPrompt } from '../domain/arrangement-planner-prompts'
import { AppError } from '../errors/app-error'
import { setLogSink, type LogRecord } from '../common/logger'
import { PiTaskWorker, type PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import { PiCodingAgentAdapter } from '../pi/sdk/pi-coding-agent-adapter'
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
  constructor(private readonly options: PiTaskWorkerOptions) {}

  async run(prompt: string): Promise<void> {
    this.prompts.push(prompt)
    const event = {
      taskId: 'planning-a',
      runId: 'planning-a',
      subscriptionId: 'sub-research',
      sequence: 1,
      type: 'text_delta' as const,
      occurredAt: Date.now(),
      data: {
        text: JSON.stringify({
          title: 'Market report',
          intentAnalysis: { summary: 'Plan the report', steps: [{ id: 'step-research', title: 'Research and write', requiredCapabilities: ['research'], dependsOn: [] }] },
          nodes: [
            {
              id: 'node-research',
              subscriptionId: 'sub-research',
              modelId: 'model-research',
              title: 'Research market',
              instruction: 'Collect relevant market facts.',
              expectedOutput: 'A source-backed fact set.',
              knowledgeQuery: 'Relevant market policies, data and internal research methods',
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
              knowledgeQuery: 'Internal report standards and approved market definitions',
              dependsOn: ['node-research'],
              skillIds: [],
              requiresUserConfirmation: false,
            },
          ],
        }),
      },
    }
    await this.options.onEvent(event)
    await this.options.onResponseSettled?.({ text: event.data.text, stopReason: 'stop' })
  }

  async abort(): Promise<void> {
    this.abortCalls.push(Date.now())
  }

  async dispose(): Promise<void> {
    this.disposeCalls.push(Date.now())
  }
}

describe('PiArrangementPlanner', () => {
  it('emits employee selection after normalizing a media plan instead of failing the entire plan', async () => {
    const progress: ArrangementPlanningProgress[] = []
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'test-token', onAuthenticationRequired() {},
      createWorker: options => ({
        async run() {
          await options.onResponseSettled?.({ stopReason: 'stop', text: JSON.stringify({ title: 'Product image', nodes: [{
            id: 'image', subscriptionId: 'sub-research', modelId: 'model-research', title: 'Product image',
            instruction: 'Generate the product image', knowledgeQuery: 'Product photography standards', dependsOn: [],
            mediaRequirements: [{ kind: 'image', operation: 'text-to-image', inputSelection: 'none', preferred: { style: 'Photography' } }],
            deliverables: [{ id: 'picture', name: 'Picture', format: 'png', path: 'deliverables/picture.png', contentOutline: ['Product'], acceptanceCriteria: ['Readable image'] }],
          }] }) })
        },
        async abort() {}, async dispose() {},
      }),
    })
    const result = await planner.plan({ planningId: 'planning-media', draft, employees, onProgress: event => progress.push(event) })
    assert.equal(result.nodes[0]!.mediaRequirements![0]!.operation, 'generate')
    assert.equal(result.nodes[0]!.deliverables![0]!.artifact!.source, 'media-output')
    assert.deepEqual(progress.filter(event => event.type === 'arrangement_employee_selected').map(event => event.data.subscriptionId), ['sub-research'])
  })

  const validOutput = JSON.stringify({ title: 'Final plan', nodes: [{
    id: 'node-research', subscriptionId: 'sub-research', modelId: 'model-research',
    title: 'Research', instruction: 'Research the market', knowledgeQuery: 'Internal market research methods',
    dependsOn: [],
  }] })

  for (const scenario of [
    { name: 'missing settlement', response: undefined, reason: 'empty-response' },
    { name: 'empty final reply', response: { text: '', stopReason: 'stop' }, reason: 'empty-response' },
    { name: 'whitespace final reply', response: { text: '  \n', stopReason: 'stop' }, reason: 'empty-response' },
    { name: 'thinking only at length limit', response: { text: '', stopReason: 'length' }, reason: 'output-truncated' },
    { name: 'partial JSON at length limit', response: { text: '{"title":', stopReason: 'length' }, reason: 'output-truncated' },
    { name: 'valid JSON at length limit', response: { text: validOutput, stopReason: 'length' }, reason: 'output-truncated' },
    { name: 'aborted reply', response: { text: validOutput, stopReason: 'aborted' }, reason: 'response-not-settled' },
    { name: 'error reply', response: { text: validOutput, stopReason: 'error' }, reason: 'response-not-settled' },
    { name: 'tool turn', response: { text: validOutput, stopReason: 'toolUse' }, reason: 'response-not-settled' },
  ]) {
    it(`does not parse input, thinking, or old fragments on ${scenario.name}`, async () => {
      const progress: ArrangementPlanningProgress[] = []
      const planner = new PiArrangementPlanner({
        gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
        getRefreshToken: () => 'test-token', onAuthenticationRequired() {},
        createWorker: options => ({
          async run() {
            const base = { taskId: 'planning-final', runId: 'planning-final', subscriptionId: 'sub-research', occurredAt: Date.now() }
            await options.onEvent({ ...base, sequence: 1, type: 'message_end',
              data: { message: { role: 'user', content: [{ type: 'text', text: validOutput }] } } })
            await options.onEvent({ ...base, sequence: 2, type: 'text_delta', data: { text: validOutput } })
            await options.onEvent({ ...base, sequence: 3, type: 'message_end',
              data: { message: { role: 'assistant', content: [{ type: 'thinking', thinking: validOutput }] } } })
            if (scenario.response) await options.onResponseSettled?.(scenario.response)
          },
          async abort() {}, async dispose() {},
        }),
      })
      await assert.rejects(planner.plan({ planningId: 'planning-final', draft, employees, onProgress: event => progress.push(event) }),
        error => error instanceof AppError && error.code === 'PLANNING_FAILED' &&
          error.details?.phase === 'response-assembly' && error.details?.reason === scenario.reason)
      assert.equal(progress.length, 0)
    })
  }

  it('uses only the last settled assistant reply after retry fragments', async () => {
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'test-token', onAuthenticationRequired() {},
      createWorker: options => ({
        async run() {
          await options.onEvent({ taskId: 'planning-final', runId: 'planning-final', subscriptionId: 'sub-research',
            sequence: 1, occurredAt: Date.now(), type: 'text_delta', data: { text: '{"title":"old incomplete reply"' } })
          await options.onResponseSettled?.({ text: validOutput, stopReason: 'stop' })
        },
        async abort() {}, async dispose() {},
      }),
    })
    const result = await planner.plan({ planningId: 'planning-final', draft, employees, onProgress() {} })
    assert.equal(result.title, 'Final plan')
  })

  for (const scenario of [
    { text: undefined, phase: 'response-assembly', reason: 'empty-response' },
    { text: '', phase: 'response-assembly', reason: 'empty-response' },
    { text: 'private-model-response', phase: 'json-extraction', reason: 'json-not-found' },
    { text: '{"title":"private-model-response",}', phase: 'json-parse', reason: 'invalid-json' },
    { text: '{"title":"private-model-response","nodes":[', phase: 'json-parse', reason: 'invalid-json' },
    { text: '{"nodes":[]}', phase: 'output-validation', reason: 'invalid-output-shape' },
    { text: '{"title":"Plan","nodes":[]}', phase: 'output-validation', reason: 'empty-plan' },
    { text: '{"title":"Plan","nodes":[{"subscriptionId":"unknown","modelId":"model-research","title":"Research","instruction":"Research","knowledgeQuery":"internal research policy"}]}', phase: 'employee-validation', reason: 'employee-unavailable' },
    { text: '{"title":"Plan","nodes":[{"subscriptionId":"sub-research","modelId":"unknown","title":"Research","instruction":"Research","knowledgeQuery":"internal research policy"}]}', phase: 'model-validation', reason: 'model-not-allowed' },
    { text: '{"title":"Plan","nodes":[{"id":"node-1","subscriptionId":"sub-research","modelId":"model-research","title":"Research","instruction":"Research","knowledgeQuery":"internal research policy","dependsOn":["missing"]}]}', phase: 'dag-validation', reason: 'invalid-draft' },
  ]) {
    it(`logs precise and private-safe failures at ${scenario.phase}: ${scenario.reason}`, async () => {
      const logs: LogRecord[] = []
      const restore = setLogSink(record => logs.push(record))
      const planner = new PiArrangementPlanner({
        gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
        getRefreshToken: () => 'private-refresh-token', onAuthenticationRequired: () => {},
        createWorker: options => ({
          async run() {
            if (scenario.text !== undefined) await options.onEvent({ taskId: 'planning-log', runId: 'planning-log', subscriptionId: 'sub-research', sequence: 1,
              type: 'text_delta', occurredAt: Date.now(), data: { text: scenario.text } })
            await options.onResponseSettled?.({ text: scenario.text ?? '', stopReason: 'stop' })
          },
          async abort() {}, async dispose() {},
        }),
      })
      try {
        await assert.rejects(planner.plan({
          planningId: 'planning-log', draft: { ...draft, goal: 'private-user-goal' }, employees,
          diagnosticContext: { round: 2, employeeScope: 'enterprise' }, onProgress: () => {},
        }))
        const failed = logs.find(record => record.message === 'planning phase failed')
        assert.equal(failed?.fields.phase, scenario.phase)
        assert.equal(failed?.fields.reason, scenario.reason)
        assert.equal(failed?.fields.planningId, 'planning-log')
        assert.equal(failed?.fields.runId, 'planning-log')
        assert.equal(failed?.fields.draftId, draft.id)
        assert.equal(failed?.fields.round, 2)
        assert.equal(failed?.fields.employeeScope, 'enterprise')
        assert.equal(failed?.fields.eventCount, scenario.text === undefined ? 0 : 1)
        assert.equal(failed?.fields.modelId, 'model-research')
        assert.equal(failed?.fields.taskTitle, 'private-user-goal')
        assert.doesNotMatch(JSON.stringify(logs), /private-model-response|private-refresh-token/)
      } finally { restore() }
    })
  }

  it('logs provider status and stack locations without raw provider payloads', async () => {
    const logs: LogRecord[] = []
    const restore = setLogSink(record => logs.push(record))
    const providerError = new Error('503: {"message":"private-provider-payload","token":"private-token"}')
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'private-token', onAuthenticationRequired: () => {},
      createWorker: () => ({ async run() { throw providerError }, async abort() {}, async dispose() {} }),
    })
    try {
      await assert.rejects(planner.plan({ planningId: 'planning-provider', draft, employees, onProgress: () => {} }), error => error === providerError)
      const failed = logs.find(record => record.message === 'planning phase failed')
      assert.equal(failed?.fields.phase, 'provider-request')
      assert.equal(failed?.fields.providerStatus, 503)
      assert.equal(failed?.fields.causeType, 'Error')
      assert.ok(failed?.fields.stack)
      assert.doesNotMatch(JSON.stringify(logs), /private-provider-payload|private-token/)
    } finally { restore() }
  })

  it('keeps the original failure when worker cleanup also fails', async () => {
    const logs: LogRecord[] = []
    const restore = setLogSink(record => logs.push(record))
    const providerError = new Error('503: private-provider-error')
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'private-token', onAuthenticationRequired: () => {},
      createWorker: () => ({ async run() { throw providerError }, async abort() {}, async dispose() { throw new Error('private-cleanup-error') } }),
    })
    try {
      await assert.rejects(planner.plan({ planningId: 'planning-cleanup', draft, employees, onProgress: () => {} }), error => error === providerError)
      assert.equal(logs.find(record => record.message === 'planning cleanup failed')?.fields.phase, 'cleanup')
      assert.equal(logs.find(record => record.message === 'planning phase failed')?.fields.phase, 'provider-request')
      assert.doesNotMatch(JSON.stringify(logs), /private-provider-error|private-cleanup-error|private-token/)
    } finally { restore() }
  })

  it('logs cancellation as a normal outcome even when cleanup fails', async () => {
    const logs: LogRecord[] = []
    const restore = setLogSink(record => logs.push(record))
    const controller = new AbortController()
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'private-token', onAuthenticationRequired: () => {},
      createWorker: () => ({ async run() { controller.abort() }, async abort() {}, async dispose() { throw new Error('private-cleanup-error') } }),
    })
    try {
      await assert.rejects(planner.plan({ planningId: 'planning-cancel-log', draft, employees, signal: controller.signal, onProgress: () => {} }), error => error instanceof Error && error.name === 'AbortError')
      assert.equal(logs.some(record => record.message === 'planning cancelled' && record.level === 'info'), true)
      assert.equal(logs.some(record => record.message === 'planning phase failed'), false)
    } finally { restore() }
  })

  it('uses the settled reply rather than the message_end projection', async () => {
    let worker: TaskWorkerPort | undefined
    const output = JSON.stringify({
      title: 'Message-end report',
      nodes: [{
        id: 'node-research', subscriptionId: 'sub-research', modelId: 'model-research',
        title: 'Research market', instruction: 'Collect relevant market facts.', expectedOutput: 'Facts',
        knowledgeQuery: 'Relevant internal market research materials',
        dependsOn: [], skillIds: [], requiresUserConfirmation: false,
      }],
    })
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {},
      createWorker: options => {
        worker = {
          async run() {
            await options.onEvent({
              taskId: 'planning-a', runId: 'planning-a', subscriptionId: 'sub-research', sequence: 1,
              type: 'message_end', occurredAt: Date.now(),
              data: { message: { role: 'assistant', content: [{ type: 'text', text: 'truncated-event-copy' }] } },
            })
            await options.onResponseSettled?.({ text: output, stopReason: 'stop' })
          },
          async abort() {},
          async dispose() {},
        }
        return worker
      },
    })

    const result = await planner.plan({ planningId: 'planning-a', modelId: 'model-research', draft, employees, onProgress: () => {} })
    assert.equal(result.title, 'Message-end report')
    assert.equal(result.nodes.length, 1)
  })
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
        worker = new FakeWorker(options)
        return worker
      },
    })

    const result = await planner.plan({
      planningId: 'planning-a',
      modelId: 'model-writer',
      draft,
      employees,
      onProgress: event => progress.push(event),
    })

    assert.equal(result.title, 'Market report')
    assert.deepEqual(result.nodes.map(node => node.subscriptionId), ['sub-research', 'sub-writer'])
    assert.deepEqual(progress.map(event => [event.type, event.data.subscriptionId]), [
      ['arrangement_plan_ready', undefined],
      ['arrangement_employee_considering', 'sub-research'],
      ['arrangement_employee_considering', 'sub-writer'],
      ['arrangement_employee_selected', 'sub-research'],
      ['arrangement_employee_selected', 'sub-writer'],
    ])
    assert.equal(worker?.prompts.length, 1)
    assert.match(worker?.prompts[0] ?? '', /Prepare a market report\./)
    assert.doesNotMatch(worker?.prompts[0] ?? '', /不调用工具/)
    assert.match(capturedOptions?.context.transformSystemPrompt?.('You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.') ?? '', /不调用工具/)
    assert.equal(capturedOptions?.context.taskId, 'planning-a')
    assert.equal(capturedOptions?.context.runId, 'planning-a')
    assert.equal(capturedOptions?.context.subscriptionId, 'sub-writer')
    assert.equal(capturedOptions?.context.modelId, 'model-writer')
    assert.equal(capturedOptions?.context.resumeSessionFile, undefined)
    assert.deepEqual(capturedOptions?.context.toolPolicy?.allowedTools, [])
    assert.equal(capturedOptions?.context.toolPolicy?.commandPolicy, 'disabled')
    assert.equal(capturedOptions?.context.toolPolicy?.approvalMode, 'auto-approve')
    assert.equal(worker?.disposeCalls.length, 1)

    const controller = new AbortController()
    controller.abort()
    assert.equal(worker?.abortCalls.length, 0)
  })

  it('uses the selected model for the planning worker', async () => {
    let capturedOptions: PiTaskWorkerOptions | undefined
    const planningEmployees = employees.map((employee, index) => index === 0
      ? { ...employee, allowedModels: [...employee.allowedModels, 'deepseek-v4.1-flash'] }
      : employee)
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {},
      createWorker: options => {
        capturedOptions = options
        return new FakeWorker(options)
      },
    })

    await planner.plan({
      planningId: 'planning-selected-model', draft, employees: planningEmployees,
      plannerModelId: 'deepseek-v4.1-flash', onProgress: () => {},
    })

    assert.equal(capturedOptions?.context.modelId, 'deepseek-v4.1-flash')
  })

  it('reports when the selected planner model is not configured by the gateway', async () => {
    const providerError = new Error('404: {"message":"Model \\"deepseek-v4.1-flash\\" is not supported by any configured account in this group","type":"model_not_found"}')
    let disposeCalls = 0
    const planningEmployees = [{ ...employees[0]!, allowedModels: ['deepseek-v4.1-flash'] }]
    const planner = new PiArrangementPlanner({
      gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {},
      createWorker: () => ({
        async run() { throw providerError },
        async abort() {},
        async dispose() { disposeCalls += 1 },
      }),
    })

    await assert.rejects(
      planner.plan({
        planningId: 'planning-unsupported-model', draft, employees: planningEmployees,
        plannerModelId: 'deepseek-v4.1-flash', onProgress: () => {},
      }),
      error => error instanceof AppError &&
        error.message === '当前选择的模型未配置在服务端账号组中。请管理员同步可用模型，或选择其他模型后重试。' &&
        error.cause === providerError,
    )
    assert.equal(disposeCalls, 1)
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
        worker = new FakeWorker(options)
        worker.run = async () => await new Promise<void>(resolve => { releaseRun = resolve })
        return worker
      },
    })
    const planning = planner.plan({ planningId: 'planning-port-cancel', modelId: 'model-research', draft, employees, onProgress: () => {} })
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
        worker = new FakeWorker(options)
        worker.run = async () => await new Promise<void>(resolve => { releaseRun = resolve })
        return worker
      },
    })
    const controller = new AbortController()
    const planning = planner.plan({
      planningId: 'planning-a',
      modelId: 'model-research',
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

for (const scenario of ['thinking-stop', 'thinking-length', 'long-final', 'network-retry'] as const) {
  it(`real SDK planner reads only the final assistant body: ${scenario}`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-planner-final-'))
    const instruction = 'Research the market. '.repeat(600).trim()
    const output = JSON.stringify({ title: 'Complete report', nodes: [{
      id: 'node-research', subscriptionId: 'sub-research', modelId: 'model-research',
      title: 'Research', instruction, knowledgeQuery: 'Internal market research methods', dependsOn: [],
    }] })
    assert.ok(output.length > 8192)
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const server = createServer((request, response) => {
      request.setEncoding('utf8')
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        requests.push(JSON.parse(body))
        if (scenario === 'network-retry' && requests.length === 1) {
          response.writeHead(503, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'temporary unavailable' } }))
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const valid = scenario === 'long-final' || requests.length > 1
        if (valid) sendChunk(response, { role: 'assistant', content: output })
        else sendChunk(response, { role: 'assistant', reasoning_content: 'Considering the requested plan.' })
        sendChunk(response, {}, !valid && scenario === 'thinking-length' ? 'length' : 'stop')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const planner = new PiArrangementPlanner({
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, workspaceRoot: root,
      getRefreshToken: () => 'mock', onAuthenticationRequired() {},
      createWorker: options => new PiTaskWorker({ ...options,
        runtime: { createSession: config => new PiCodingAgentAdapter().createSession({ ...config, mcpServers: [] }) },
        createTokenManager: () => ({ initialize: async () => {}, getValidToken: async () => 'mock', stop() {} }),
      }),
    })
    try {
      const result = planner.plan({ planningId: 'planning-final-sdk', draft, employees, onProgress() {} })
      assert.equal((await result).nodes[0]?.instruction, instruction)
      assert.equal(requests.length, scenario === 'long-final' ? 1 : 2)
      for (const request of requests) {
        const system = request.messages.find(message => message.role === 'system')?.content ?? ''
        assert.ok(system.startsWith('你运行在 Pi 中。'))
        assert.equal(system.split(ARRANGEMENT_PLANNER_RULES).length - 1, 1, `Unexpected system prompt: ${JSON.stringify(system)}`)
        assert.match(system, /可用工具：\n无/)
        assert.match(system, /主要文档：.*README\.md/)
        assert.ok(system.includes(`当前工作目录：${root.replace(/\\/g, '/')}`))
        assert.doesNotMatch(system, /expert coding assistant|Current working directory:/)
        assert.equal(request.messages.filter(message => message.role === 'user' && message.content.startsWith('目前是自动编排的第一阶段')).length, 1)
      }
      if (scenario === 'thinking-stop' || scenario === 'thinking-length') {
        const repair = requests[1]!.messages.filter(message => message.role === 'user').at(-1)?.content
        assert.equal(repair, buildArrangementPlannerRepairPrompt('response-assembly', buildArrangementPlannerInput(draft, employees, 'authorized')))
      }
      if (scenario === 'network-retry') assert.deepEqual(requests[1]!.messages, requests[0]!.messages)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const invalidTools of [false, true]) {
  it(`real SDK planner: ${invalidTools ? 'stops malformed tool loops after the first response' : 'generates a draft without advertising tools'}`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-planner-no-tools-'))
    const requests: Array<{ tools?: unknown[] }> = []
    const server = createServer((request, response) => {
      request.setEncoding('utf8')
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
            knowledgeQuery: 'Internal market research methods and historical results',
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
      const result = planner.plan({ planningId: 'planning-sdk-test', modelId: 'model-research', draft, employees, onProgress: event => progress.push(event) })
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
      assert.deepEqual(advertisedToolNames, [], 'planning must not advertise the removed web search or execution tools')
      assert.equal(approvals, 0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
}
