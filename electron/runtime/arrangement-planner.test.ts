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
})
