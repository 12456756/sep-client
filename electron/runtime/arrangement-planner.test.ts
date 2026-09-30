import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  buildArrangementPlannerPrompt,
  parseArrangementPlannerOutput,
  type ArrangementPlannerEmployee,
} from '../domain/arrangement-planner'

const employees: ArrangementPlannerEmployee[] = [
  { subscriptionId: 'sub-a', employeeId: 'emp-a', name: 'Researcher', description: 'Researches public information', position: 'Researcher', functionalCategory: 'Research', allowedModels: ['m-a'], status: 'ACTIVE' },
]
const draft = {
  id: 'draft-a', schemaVersion: 1 as const, revision: 1, owner: { memberId: 'm', enterpriseId: 'e' }, mode: 'auto' as const,
  status: 'planning' as const, title: '', goal: 'Prepare a market report', confirmedInputs: ['Q1 brief'], sharedSkillIds: ['skill-a'], conversation: null,
  nodes: [], workspace: { mode: 'shared' as const, path: null }, permissions: { preset: 'read-only' as const }, createdAt: 1, updatedAt: 1, lastPlanning: null,
}

describe('arrangement planner', () => {
  it('builds a prompt with the goal and employee responsibilities', () => {
    const prompt = buildArrangementPlannerPrompt(draft, employees)
    assert.match(prompt, /Prepare a market report/)
    assert.match(prompt, /Researches public information/)
    assert.match(prompt, /sub-a/)
    assert.match(prompt, /JSON/)
    assert.ok(prompt.startsWith("\u4f60\u662f SEP \u81ea\u52a8\u7f16\u6392 Agent"))
    assert.ok(prompt.includes("\u53ea\u80fd\u4ece employeeCatalog \u4e2d\u9009\u62e9\u5458\u5de5"))
    assert.match(prompt, /intentAnalysis/)
    assert.match(prompt, /unresolvedSteps/)
  })

  it('parses a valid plan and rejects unauthorized employees and models', () => {
    const result = parseArrangementPlannerOutput(JSON.stringify({ title: 'Report', nodes: [{ id: 'node-1', subscriptionId: 'sub-a', modelId: 'm-a', title: 'Research', instruction: 'Research sources', expectedOutput: 'Sources', dependsOn: [], skillIds: ['skill-a'], requiresUserConfirmation: false }] }), draft, employees)
    assert.equal(result.nodes[0]?.subscriptionId, 'sub-a')
    assert.throws(() => parseArrangementPlannerOutput(JSON.stringify({ title: 'Bad', nodes: [{ id: 'node-1', subscriptionId: 'sub-x', modelId: 'm-a', title: 'x', instruction: 'x', expectedOutput: 'x', dependsOn: [], skillIds: [], requiresUserConfirmation: false }] }), draft, employees))
    assert.throws(() => parseArrangementPlannerOutput(JSON.stringify({ title: 'Bad', nodes: [{ id: 'node-1', subscriptionId: 'sub-a', modelId: 'm-x', title: 'x', instruction: 'x', expectedOutput: 'x', dependsOn: [], skillIds: [], requiresUserConfirmation: false }] }), draft, employees))
  })

  it('does not expose reasoning in the parsed result', () => {
    const result = parseArrangementPlannerOutput('```json\n{"title":"Report","reasoning":"secret chain","nodes":[{"id":"node-1","subscriptionId":"sub-a","modelId":"m-a","title":"Research","instruction":"Research","expectedOutput":"Sources","dependsOn":[],"skillIds":[],"requiresUserConfirmation":false}]}\n```', draft, employees)
    assert.equal('reasoning' in result, false)
  })

  it('parses candidate matches without turning unavailable employees into executable nodes', () => {
    const result = parseArrangementPlannerOutput(JSON.stringify({
      title: 'Report',
      intentAnalysis: { summary: '整理市场信息', steps: [{ id: 'step-1', title: '分析趋势', requiredCapabilities: ['趋势分析'], dependsOn: [] }] },
      unresolvedSteps: [{ stepId: 'step-1', reason: '需要更多员工', requiredCapabilities: ['趋势分析'] }],
      candidateMatches: [{ stepId: 'step-1', employeeId: 'emp-platform', source: 'platform', name: '趋势分析员工', rationale: '具备趋势分析能力' }],
      nodes: [],
    }), draft, [...employees, { subscriptionId: 'platform-employee', employeeId: 'emp-platform', name: '趋势分析员工', description: '趋势分析', allowedModels: [], status: 'ACTIVE', source: 'platform', canExecute: false, canApply: true }])
    assert.equal(result.candidateMatches?.[0]?.source, 'platform')
    assert.equal(result.nodes.length, 0)
  })

  it('ignores non-applicable employee suggestions while preserving unresolved steps', () => {
    const result = parseArrangementPlannerOutput(JSON.stringify({
      title: 'AI news report',
      intentAnalysis: {
        summary: 'Search for current AI news and prepare a report',
        steps: [
          { id: 'step-1', title: 'Search AI news', requiredCapabilities: ['web-search'], dependsOn: [] },
        ],
      },
      unresolvedSteps: [{ stepId: 'step-1', reason: 'No employee has web search access', requiredCapabilities: ['web-search'] }],
      candidateMatches: [{ stepId: 'step-1', employeeId: 'emp-a', rationale: 'Can summarize news' }],
      nodes: [],
    }), draft, [{ ...employees[0]!, source: 'authorized', canExecute: true, canApply: false }])

    assert.deepEqual(result.unresolvedSteps?.map(step => step.stepId), ['step-1'])
    assert.deepEqual(result.candidateMatches ?? [], [])
    assert.deepEqual(result.nodes, [])
  })

  it('keeps the intent snapshot and unresolved capability steps for later matching', () => {
    const result = parseArrangementPlannerOutput(JSON.stringify({
      title: 'Report',
      intentAnalysis: {
        summary: '整理市场信息并形成报告',
        steps: [{ id: 'step-1', title: '分析趋势', requiredCapabilities: ['趋势分析'], dependsOn: [] }],
      },
      unresolvedSteps: [{ stepId: 'step-1', reason: '当前授权员工不具备趋势分析能力', requiredCapabilities: ['趋势分析'] }],
      nodes: [],
    }), draft, employees)
    assert.equal(result.nodes.length, 0)
    assert.equal(result.intentAnalysis?.steps[0]?.id, 'step-1')
    assert.equal(result.unresolvedSteps?.[0]?.stepId, 'step-1')
  })
})
