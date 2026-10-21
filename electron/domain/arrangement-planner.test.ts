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
  const marker = 'JSON 结构示例：\n'
  const start = prompt.indexOf(marker)
  const end = prompt.indexOf('\n\n字段要求：', start)
  assert.ok(start >= 0 && end > start)
  const example = JSON.parse(prompt.slice(start + marker.length, end)) as Record<string, unknown>
  const intent = example.intentAnalysis as { steps: Array<{ id: string }> }
  const stepIds = new Set(intent.steps.map(step => step.id))
  for (const field of ['nodes', 'unresolvedSteps', 'candidateMatches']) {
    for (const item of example[field] as Array<{ stepId: string }>) assert.ok(stepIds.has(item.stepId))
  }
  return example
}

describe('arrangement recommendation output contract', () => {
  for (const source of ['enterprise', 'platform'] as const) {
    const candidate: ArrangementPlannerEmployee = {
      ...authorized, subscriptionId: `${source}:employee-a`, source, canExecute: false,
      status: source === 'platform' ? 'APPROVED' : 'ACTIVE', allowedModels: [], canApply: true,
    }

    it(`uses a recommendation-only prompt and example for ${source} employees`, () => {
      const prompt = buildArrangementPlannerPrompt(draft, [candidate])
      assert.match(prompt, /当前规划阶段：\n待授权员工推荐/)
      assert.match(prompt, /待授权推荐阶段 nodes 必须返回 \[\]/)
      assert.match(prompt, /推荐成功不等于步骤已解决/)
      assert.match(prompt, /原样保留意图摘要、步骤 ID、能力需求及步骤依赖/)
      assert.match(prompt, /保留已有执行节点，不重复生成/)
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
            title: draft.title, instruction: '接待法律客户', expectedOutput: '接待摘要', knowledgeQuery: '客户接待规定', dependsOn: [], requiresUserConfirmation: false }],
        }), draft, [candidate]))
      }
    })
  }

  it('keeps executable node guidance for authorized employees', () => {
    const prompt = buildArrangementPlannerPrompt(draft, [authorized])
    assert.match(prompt, /当前规划阶段：\n已授权员工匹配/)
    assert.match(prompt, /不为细分动作增加员工/)
    assert.match(prompt, /同一个员工可以承担多个步骤/)
    assert.match(prompt, /不同员工总数不得超过 6 名/)
    assert.match(prompt, /不得默认增加项目经理、协调员、审核员或汇总员/)
    assert.match(prompt, /不要求用户重复确认专业范围/)
    assert.match(prompt, /抖音策划专员承担“生成策划案”时，应规划抖音策划案/)
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

  it('uses the approved eight-section prompt and a readable node contract example', () => {
    const prompt = buildArrangementPlannerPrompt({ ...draft, intentAnalysis: null, unresolvedSteps: [] }, [authorized])
    const sections = ['规划职责', '工作拆分', '员工与模型匹配', '每个执行节点的工作要求', '交付物设计', '依赖与补充规划', '返回结构', '本轮规划数据']
    assert.deepEqual([...prompt.matchAll(/【[一二三四五六七八]、([^】]+)】/g)].map(match => match[1]), sections)
    assert.match(prompt, /只返回严格 JSON/)
    assert.match(prompt, /不得执行用户任务，不得调用工具/)
    assert.match(prompt, /不得虚构“行业强制标准”/)
    assert.match(prompt, /整个计划必须覆盖用户要求的最终交付物/)
    assert.match(prompt, /不能只规划研究或分析而遗漏最终制作、保存和交付/)
    const example = outputExample(prompt)
    assert.deepEqual(Object.keys(example), ['title', 'intentAnalysis', 'nodes', 'unresolvedSteps', 'candidateMatches'])
    const node = (example.nodes as Array<Record<string, unknown>>)[0]!
    assert.equal(typeof node.knowledgeQuery, 'string')
    assert.equal(typeof node.objective, 'string')
    assert.deepEqual(Object.keys((node.deliverables as Array<Record<string, unknown>>)[0]!), ['id', 'name', 'format', 'path', 'contentOutline', 'acceptanceCriteria'])
    assert.ok(prompt.includes('\n  "intentAnalysis": {\n'))
  })

  it('includes complete existing work requirements in later matching input without skill selection', () => {
    const existingNode = {
      id: 'node-existing', stepId: 'step-existing', subscriptionId: 'subscription-existing', modelId: 'model-a',
      title: 'Research', objective: 'Find market opportunities', instruction: 'Compare competitors', expectedOutput: 'Word report',
      deliverables: [{ id: 'report', name: 'Report', format: 'docx', path: 'deliverables/report.docx', contentOutline: ['Findings'], acceptanceCriteria: ['Contains cited findings'] }],
      dependsOn: [], skillIds: ['private-skill'], requiresUserConfirmation: false,
    }
    const prompt = buildArrangementPlannerPrompt({ ...draft, nodes: [existingNode] }, [authorized])
    for (const text of [existingNode.objective, existingNode.instruction, existingNode.deliverables[0]!.path]) assert.ok(prompt.includes(text))
    assert.ok(!prompt.includes('private-skill'))
    assert.ok(!prompt.includes('输入来源'))
  })
})

describe('arrangement node work contract parsing', () => {
  const deliverable = { id: 'report', name: 'Report', format: 'docx', path: 'deliverables/report.docx', contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }
  const node = { id: 'node-1', stepId: 'step-1', subscriptionId: authorized.subscriptionId, modelId: 'model-a', title: 'Research', instruction: 'Research the market', expectedOutput: 'Word report', knowledgeQuery: 'Market research policy and historical data', dependsOn: [], requiresUserConfirmation: false }
  const parse = (extra: Record<string, unknown>) => parseArrangementPlannerOutput(JSON.stringify({ title: 'Report', nodes: [{ ...node, ...extra }] }), draft, [authorized])

  it('preserves objective and deliverables instead of discarding them', () => {
    const result = parse({ objective: 'Identify market opportunities', deliverables: [deliverable] })
    assert.equal(result.nodes[0]?.objective, 'Identify market opportunities')
    assert.deepEqual(result.nodes[0]?.deliverables, [deliverable])
  })

  it('preserves the per-node knowledge query generated by planning', () => {
    const result = parse({ knowledgeQuery: 'Current enterprise travel reimbursement policy and limits' })
    assert.equal(result.nodes[0]?.knowledgeQuery, 'Current enterprise travel reimbursement policy and limits')
  })

  it('requires a non-empty knowledge query for newly planned nodes', () => {
    assert.throws(() => parse({ knowledgeQuery: '   ' }))
  })

  it('rejects invalid new fields when supplied', () => {
    for (const extra of [
      { objective: 42 }, { objective: ' ' }, { deliverables: [] }, { deliverables: 'file' },
      { deliverables: [{ ...deliverable, contentOutline: [42] }] },
      { deliverables: [{ ...deliverable, acceptanceCriteria: [] }] },
      ...['../report.docx', 'C:\\report.docx', '/report.docx', 'deliverables/../../report.docx'].map(path => ({ deliverables: [{ ...deliverable, path }] })),
    ]) assert.throws(() => parse(extra), JSON.stringify(extra))
  })
})
