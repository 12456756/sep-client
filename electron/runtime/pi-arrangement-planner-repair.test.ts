import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { PiArrangementPlanner } from './pi-arrangement-planner'
import { PiTaskWorker } from '../pi/sdk/pi-task-worker'
import type { PiAgentSessionConfig } from '../pi/sdk/pi-agent-runtime'
import type { ArrangementDraft } from '../domain/arrangement-plan'
import type { ArrangementPlannerEmployee } from '../domain/arrangement-planner'

const draft: ArrangementDraft = {
  id: 'draft', schemaVersion: 1, revision: 1, owner: { memberId: 'm', enterpriseId: 'e' },
  mode: 'auto', status: 'planning', title: '', goal: 'Prepare report', confirmedInputs: ['brief'],
  sharedSkillIds: [], conversation: null, nodes: [], workspace: { mode: 'shared', path: null },
  permissions: { preset: 'read-only' }, createdAt: 1, updatedAt: 1, lastPlanning: null,
}
const employees: ArrangementPlannerEmployee[] = [{ subscriptionId: 'sub', employeeId: 'emp', name: 'Researcher', status: 'ACTIVE', canExecute: true, source: 'authorized', allowedModels: ['model'] }]
const node = { id: 'node', subscriptionId: 'sub', modelId: 'model', title: 'Research', instruction: 'Research', knowledgeQuery: 'Internal standards', dependsOn: [] }
const valid = JSON.stringify({ title: 'Report', nodes: [node] })
type Reply = { text: string; stopReason?: string }

function harness(replies: Reply[], beforePrompt?: (index: number) => void) {
  const prompts: string[] = []
  let config: PiAgentSessionConfig | undefined
  let aborts = 0
  let disposals = 0
  const planner = new PiArrangementPlanner({
    gatewayUrl: 'http://gateway.test/v1', workspaceRoot: 'C:/workspace',
    getRefreshToken: () => 'token', onAuthenticationRequired() {},
    createWorker: options => new PiTaskWorker({ ...options,
      createTokenManager: () => ({ async initialize() {}, async getValidToken() { return 'token' }, stop() {} }),
      runtime: { async createSession(input) {
        config = input
        let reply: Reply = { text: '' }
        return {
          sessionId: 'session', sessionFile: null,
          async prompt(text) {
            const index = prompts.length
            prompts.push(text)
            beforePrompt?.(index)
            assert.ok(index < replies.length, 'unexpected extra request')
            reply = replies[index]!
          },
          getSettledResponse() { return reply },
          subscribe() { return () => {} },
          async abort() { aborts++ }, async dispose() { disposals++ },
        }
      } },
    }),
  })
  return { planner, prompts, get config() { return config }, get aborts() { return aborts }, get disposals() { return disposals } }
}

describe('planning validation repair requests', () => {
  for (const [response, expected] of [
    [{ text: '', stopReason: 'stop' }, '响应完整性检查'],
    [{ text: valid, stopReason: 'length' }, '响应完整性检查'],
    [{ text: 'PRIVATE_BAD_REPLY', stopReason: 'stop' }, '未能提取到规划 JSON'],
    [{ text: '{"title":', stopReason: 'stop' }, 'JSON 语法错误'],
    [{ text: '{"nodes":[]}', stopReason: 'stop' }, '输出结构与节点工作要求检查'],
    [{ text: JSON.stringify({ title: 'Bad', nodes: [{ ...node, deliverables: [] }] }), stopReason: 'stop' }, '输出结构与节点工作要求检查'],
    [{ text: JSON.stringify({ title: 'Bad', nodes: [{ ...node, subscriptionId: 'missing' }] }), stopReason: 'stop' }, '员工有效性检查'],
    [{ text: JSON.stringify({ title: 'Bad', nodes: [{ ...node, modelId: 'missing' }] }), stopReason: 'stop' }, '模型有效性检查'],
    [{ text: JSON.stringify({ title: 'Bad', nodes: [{ ...node, dependsOn: ['missing'] }] }), stopReason: 'stop' }, '草稿与执行节点依赖检查'],
  ] satisfies Array<[Reply, string]>) it(`repairs ${expected} and then validates the full replacement`, async () => {
    const h = harness([response, { text: valid, stopReason: 'stop' }])
    const result = await h.planner.plan({ planningId: 'p', draft, employees, planningStage: 'authorized', onProgress() {} })
    assert.equal(result.title, 'Report')
    assert.equal(h.prompts.length, 2)
    assert.ok(h.prompts[0]!.startsWith('目前是自动编排的第一阶段'))
    assert.ok(h.prompts[1]!.includes(expected))
    assert.doesNotMatch(h.prompts[1]!, /PRIVATE_BAD_REPLY|stopReason|具体错误|第一阶段/)
    const data = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1))
    assert.deepEqual(data(h.prompts[1]!), data(h.prompts[0]!))
    assert.equal(typeof h.config?.transformSystemPrompt, 'function')
    assert.equal(h.config?.systemPrompt, undefined)
    assert.equal(h.disposals, 1)
  })

  it('does not limit the number of content corrections', async () => {
    const h = harness([...Array.from({ length: 8 }, () => ({ text: 'not JSON', stopReason: 'stop' })), { text: valid, stopReason: 'stop' }])
    const result = await h.planner.plan({ planningId: 'p', draft, employees, onProgress() {} })
    assert.equal(result.title, 'Report')
    assert.equal(h.prompts.length, 9)
  })

  it('can cancel during repeated content corrections', async () => {
    const controller = new AbortController()
    const h = harness(Array.from({ length: 10 }, () => ({ text: 'not JSON', stopReason: 'stop' })), index => {
      if (index === 5) controller.abort()
    })
    await assert.rejects(h.planner.plan({ planningId: 'p', draft, employees, signal: controller.signal, onProgress() {} }), error => error instanceof Error && error.name === 'AbortError')
    assert.equal(h.prompts.length, 6)
    assert.ok(h.aborts > 0)
    assert.equal(h.disposals, 1)
  })

  it('does not repair provider or authentication failures', async () => {
    const failure = new Error('503 provider unavailable')
    const h = harness([{ text: valid }], () => { throw failure })
    await assert.rejects(h.planner.plan({ planningId: 'p', draft, employees, onProgress() {} }), error => error === failure)
    assert.equal(h.prompts.length, 1)
  })
})
