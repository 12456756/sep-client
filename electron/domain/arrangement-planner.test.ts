import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildArrangementPlannerPrompt, parseArrangementPlannerOutput, type ArrangementPlannerEmployee } from './arrangement-planner'
import type { ArrangementDraft } from './arrangement-plan'

const intentAnalysis = {
  summary: '选择员工完成法务客户接待',
  steps: [{ id: 'step-1', title: '法务客户接待', requiredCapabilities: ['法务客户接待'], dependsOn: [] }],
}
const unresolvedSteps = [{ stepId: 'step-1', reason: '等待员工授权', requiredCapabilities: ['法务客户接待'] }]
const draft: ArrangementDraft = {
  id: 'draft-a', schemaVersion: 1, revision: 2, owner: { memberId: 'member-a', enterpriseId: 'enterprise-a' },
  mode: 'auto', status: 'planning', title: '法务客户接待', goal: '选择员工完成法务客户接待',
  confirmedInputs: [], sharedSkillIds: [], conversation: null, nodes: [], intentAnalysis, unresolvedSteps,
  workspace: { mode: 'shared', path: null }, permissions: { preset: 'read-only' },
  createdAt: 1, updatedAt: 1, lastPlanning: null,
}
const authorized: ArrangementPlannerEmployee = {
  subscriptionId: 'subscription-a', employeeId: 'employee-a', name: '法务客户接待',
  source: 'authorized', canExecute: true, status: 'ACTIVE', allowedModels: ['model-a'],
}

function outputExample(prompt: string): Record<string, unknown> {
  const example = prompt.split('\n').find(line => line.startsWith('JSON 格式：'))
  assert.ok(example)
  return JSON.parse(example.slice('JSON 格式：'.length)) as Record<string, unknown>
}

describe('arrangement recommendation output contract', () => {
  for (const source of ['enterprise', 'platform'] as const) {
    const candidate: ArrangementPlannerEmployee = {
      ...authorized, subscriptionId: `${source}:employee-a`, source, canExecute: false,
      status: source === 'platform' ? 'APPROVED' : 'ACTIVE', allowedModels: [], canApply: true,
    }

    it(`uses a recommendation-only prompt and example for ${source} employees`, () => {
      const prompt = buildArrangementPlannerPrompt(draft, [candidate])
      assert.ok(!prompt.includes('生成一个可执行的编排草稿'))
      assert.match(prompt, /本轮是待授权员工推荐阶段/)
      assert.match(prompt, /nodes 必须返回空数组/)
      assert.match(prompt, /选中候选员工不代表该步骤已解决/)
      assert.match(prompt, /原样保留已有 intentAnalysis/)
      assert.match(prompt, /不得重复返回已有执行节点/)
      const example = outputExample(prompt)
      assert.deepEqual(example.nodes, [])
      assert.ok(Array.isArray(example.unresolvedSteps) && example.unresolvedSteps.length > 0)
      assert.ok(Array.isArray(example.candidateMatches) && example.candidateMatches.length > 0)
      assert.ok(!JSON.stringify(example).includes('modelId'))
      assert.ok(!JSON.stringify(example).includes('subscriptionId'))
    })

    it(`accepts ${source} recommendations while preserving the pending authorization step`, () => {
      const result = parseArrangementPlannerOutput(JSON.stringify({
        title: draft.title, intentAnalysis, unresolvedSteps, nodes: [],
        candidateMatches: [{ stepId: 'step-1', employeeId: candidate.employeeId, rationale: '具备法务客户接待能力，等待授权' }],
      }), draft, [candidate])
      assert.deepEqual(result.nodes, [])
      assert.deepEqual(result.intentAnalysis, intentAnalysis)
      assert.deepEqual(result.unresolvedSteps, unresolvedSteps)
      assert.equal(result.candidateMatches?.[0]?.employeeId, candidate.employeeId)
      assert.equal(result.candidateMatches?.[0]?.canExecute, false)
    })

    it(`rejects ${source} execution nodes instead of filling or ignoring invalid fields`, () => {
      for (const modelId of ['', 'model-a']) {
        assert.throws(() => parseArrangementPlannerOutput(JSON.stringify({
          title: draft.title, intentAnalysis, unresolvedSteps: [],
          candidateMatches: [{ stepId: 'step-1', employeeId: candidate.employeeId, rationale: '匹配接待工作' }],
          nodes: [{ id: 'node-1', stepId: 'step-1', subscriptionId: candidate.subscriptionId, modelId,
            title: draft.title, instruction: '接待法律客户', expectedOutput: '接待摘要', dependsOn: [], requiresUserConfirmation: false }],
        }), draft, [candidate]))
      }
    })
  }

  it('keeps executable node guidance for authorized employees', () => {
    const prompt = buildArrangementPlannerPrompt(draft, [authorized])
    assert.match(prompt, /生成一个可执行的编排草稿/)
    assert.ok(!prompt.includes('本轮是待授权员工推荐阶段'))
    const example = outputExample(prompt)
    assert.ok(Array.isArray(example.nodes) && example.nodes.length > 0)
    assert.ok(JSON.stringify(example).includes('modelId'))
  })

  it('does not copy existing executable nodes into the recommendation example', () => {
    const existingNode = { id: 'existing-node', subscriptionId: 'subscription-existing', modelId: 'model-a',
      title: '整理客户材料', instruction: '整理材料', expectedOutput: '客户材料', dependsOn: [], skillIds: [], requiresUserConfirmation: false }
    const prompt = buildArrangementPlannerPrompt({ ...draft, nodes: [existingNode] }, [{ ...authorized, source: 'platform', canExecute: false, allowedModels: [] }])
    assert.match(prompt, /existing-node/)
    assert.deepEqual(outputExample(prompt).nodes, [])
  })
})
