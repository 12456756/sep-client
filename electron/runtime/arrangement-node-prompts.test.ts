import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildArrangementNodeSystemPrompt } from './arrangement-node-prompts'
import { formatKnowledgeContext } from '../common/knowledge-context'
import type { EmployeeRuntimeConfig } from './run-types'
import type { WorkPlan, ArrangementNode } from '../domain/arrangement-plan'

const node: ArrangementNode = {
  id: 'node-b', title: '策略方案', objective: '制定业务策略', instruction: '基于研究结果制定策略',
  expectedOutput: '策略与测算文件', subscriptionId: 'employee', modelId: 'model',
  dependsOn: ['node-a'], skillIds: [], requiresUserConfirmation: false,
  deliverables: [
    { id: 'strategy', name: '策略方案', format: 'docx', path: 'deliverables/策略.docx', contentOutline: ['渠道策略'], acceptanceCriteria: ['引用研究结果'] },
    { id: 'budget', name: '预算测算', format: 'xlsx', path: 'deliverables/预算.xlsx', contentOutline: ['成本与公式'], acceptanceCriteria: ['公式可复算'] },
  ],
}

describe('arrangement node system prompt', () => {
  it('uses actual employee, node, predecessor snapshots and knowledge data with an annotated final manifest', () => {
    const employee: EmployeeRuntimeConfig = {
      subscriptionId: 'employee', modelId: 'model', gatewayUrl: 'https://invalid', systemPrompt: 'Old override',
      employeeProfile: { name: '策略员工', position: '电商顾问', functionalCategory: '运营', description: '制定电商策略' },
      runtimeSnapshot: {
        manifestVersion: 1, subscriptionId: 'employee', enterpriseId: 'enterprise', employeeId: 'employee-id',
        templateVersion: 'v1', employeeVersion: 'v1', maxSteps: 10, systemPrompt: 'Old override', modelId: 'model', allowedModels: ['model'], approvedSkills: [],
        skills: [{ capabilityId: 'cap-1', name: 'strategy', description: '策略方法', versionId: 'v1', baseSkillVersionId: 'v1', version: '1', source: 'approved', content: 'External English skill', sha256: 'a'.repeat(64), path: 'D:/skills/strategy/SKILL.md' }],
      },
    }
    const knowledge = formatKnowledgeContext('内部预算规范是什么？', null)
    const result = buildArrangementNodeSystemPrompt({ goal: '新品上市' }, node, [{
      node: { ...node, id: 'node-a', title: '市场研究' },
      files: [{ id: 'research', path: 'deliverables/研究.docx', readPath: 'D:/snapshots/research.docx', format: 'docx', size: 50, sha256: 'a'.repeat(64), nodeRunId: 'run-a', validatedAt: 1, snapshot: { source: 'workspace-recovery', size: 50, sha256: 'b'.repeat(64) } }],
    }], employee, knowledge)
    for (const text of ['硅基员工节点执行要求', '策略员工', '电商顾问', '运营', '制定电商策略', 'capabilities', 'cap-1', '策略方法', '新品上市', '策略方案（node-b）', node.objective!, node.instruction, '市场研究（node-a）', 'deliverables/研究.docx', '读取快照：D:/snapshots/research.docx', '历史任务恢复版本', knowledge]) assert.ok(result.includes(text), text)
    assert.ok(result.indexOf('本节点知识库参考') > result.indexOf('最终输出'))
    for (const file of node.deliverables!) assert.ok(result.includes(JSON.stringify(file.path)))
    assert.match(result, /"nodeId": "node-b", \/\/ 当前节点/)
    assert.match(result, /"summary": .*\/\//)
    assert.match(result, /"finalDeliverables": \[ \/\//)
    assert.match(result, /"id": "strategy", \/\//)
    assert.match(result, /"path": "deliverables\/策略.docx" \/\//)
    assert.match(result, /实际输出必须删除全部注释/)
    assert.doesNotMatch(result, /Old override|最多校验|首次提交加|当前执行次数|responsibility_judgment/)
  })

  it('does not invent missing employee capabilities, dependencies or knowledge results', () => {
    const result = buildArrangementNodeSystemPrompt({ goal: '新品上市' } as WorkPlan, node, [], {
      subscriptionId: 'employee', modelId: 'model', gatewayUrl: 'https://invalid', employeeProfile: { name: '策略员工' },
    })
    assert.match(result, /"capabilities": \[\]/)
    assert.match(result, /前置依赖成果：\n无/)
    assert.match(result, /本轮没有知识库参考资料/)
    assert.doesNotMatch(result, /\{\{|undefined/)
  })
})
