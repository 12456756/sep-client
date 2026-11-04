import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  ARRANGEMENT_PLANNER_RULES,
  buildArrangementPlannerInput,
  buildArrangementPlannerUserPrompt,
  buildArrangementPlannerRepairPrompt,
  buildArrangementReplacementPrompt,
  type ArrangementPlanningStage,
} from './arrangement-planner-prompts'
import type { ArrangementDraft } from './arrangement-plan'

const draft: ArrangementDraft = {
  id: 'draft', schemaVersion: 1, revision: 1, owner: { memberId: 'm', enterpriseId: 'e' },
  mode: 'auto', status: 'planning', title: '', goal: '制作智能行李箱策划案', confirmedInputs: ['inputs/需求.docx'],
  sharedSkillIds: ['private-skill'], conversation: null, nodes: [],
  workspace: { mode: 'shared', path: null }, permissions: { preset: 'read-only' },
  createdAt: 1, updatedAt: 1, lastPlanning: null,
  candidateMatches: [{ stepId: 's1', employeeId: 'candidate', subscriptionId: null, source: 'platform', name: '候选', rationale: '匹配', canExecute: false, canApply: true }],
}

describe('arrangement planner prompt separation', () => {
  it('constrains employee replacement to the existing node contract and authorized catalog', () => {
    const prompt = buildArrangementReplacementPrompt({
      taskGoal: 'Create a product launch plan.',
      node: { ...({ id: 'node-a', title: 'Research', instruction: 'Assess the market', expectedOutput: 'Market report',
        deliverables: [{ id: 'report', name: 'Report', format: 'md', path: 'deliverables/report.md', contentOutline: ['Findings'], acceptanceCriteria: ['Evidence'] }], dependsOn: ['node-0'],
        mediaRequirements: [], modelId: 'model-a', subscriptionId: 'sub-old' } as const) },
      employees: [{ subscriptionId: 'sub-new', employeeId: 'employee-new', name: 'Researcher', position: 'Research',
        description: 'Market research', functionalCategory: 'Research', allowedModels: ['model-a'], status: 'ACTIVE', canExecute: true }],
    })
    assert.match(prompt, /Create a product launch plan/)
    assert.match(prompt, /node-a/)
    assert.match(prompt, /sub-old/)
    assert.match(prompt, /node-0/)
    assert.match(prompt, /sub-new/)
    assert.match(prompt, /subscriptionId/)
    assert.match(prompt, /null/)
    assert.match(prompt, /不得修改/)
  })

  for (const [stage, heading] of [
    ['authorized', '第一阶段：已授权员工匹配'],
    ['enterprise', '第二阶段：企业待授权员工推荐'],
    ['platform', '第三阶段：平台待授权员工推荐'],
  ] as const) it(`uses the approved first user message for ${stage}`, () => {
    const input = buildArrangementPlannerInput(draft, [], stage)
    const prompt = buildArrangementPlannerUserPrompt(input)
    assert.ok(prompt.startsWith(`目前是自动编排的${heading}。`))
    assert.equal(input.planningStage, stage)
    assert.deepEqual(Object.keys(input), ['planningStage', 'knowledgeSelection', 'knowledgeCatalog', 'userGoal', 'confirmedInputs', 'attachments', 'intentSnapshot', 'unresolvedSteps', 'existingNodes', 'existingCandidateMatches', 'employeeCatalog'])
    assert.deepEqual(input.existingCandidateMatches, draft.candidateMatches)
    assert.ok(prompt.includes(JSON.stringify(input, null, 2)))
    assert.doesNotMatch(prompt, /核心规划原则|candidateMatches 返回|nodes 返回|private-skill|不得默认增加/)
  })

  it('requires platform-stage coverage with the closest capable employee rather than an exact job or skill match', () => {
    const prompt = buildArrangementPlannerUserPrompt(buildArrangementPlannerInput(draft, [], 'platform'))
    assert.match(prompt, /逐一检查 unresolvedSteps/)
    assert.match(prompt, /能力最接近且能够完成该步骤预期交付/)
    assert.match(prompt, /必须为该步骤补齐至少一名候选员工/)
    assert.match(prompt, /不得仅因职位、行业、技能名称不完全一致或缺少对应 Skill 而放弃推荐/)
    assert.match(prompt, /rationale.*具体胜任依据/)
    assert.match(prompt, /同一员工可以承担多个步骤/)
  })

  it('keeps platform fallback within real candidates, authorization and delivery constraints', () => {
    const prompt = buildArrangementPlannerUserPrompt(buildArrangementPlannerInput(draft, [], 'platform'))
    assert.match(prompt, /canApply=true、canExecute=false/)
    assert.match(prompt, /真实 employeeId/)
    assert.match(prompt, /nodes 必须为 \[\]/)
    assert.match(prompt, /保留 unresolvedSteps 并说明等待授权/)
    assert.match(prompt, /保留已有意图分析、执行节点和候选推荐/)
    assert.match(prompt, /不同员工总数最多 6 名/)
    assert.match(prompt, /allowedModels 为空或媒体工具状态为 unknown/)
    assert.match(prompt, /必需工具明确不可用且无可行替代/)
    assert.match(prompt, /不得虚构员工、能力或权限/)
    assert.match(prompt, /不得.*降低交付要求/)
  })

  it('does not add the platform fallback policy to the first or second stage', () => {
    const expected = {
      authorized: '目前是自动编排的第一阶段：已授权员工匹配。\n\n请围绕用户目标，优先使用当前已授权员工安排工作。\n首次规划时建立完整意图分析。',
      enterprise: '目前是自动编排的第二阶段：企业待授权员工推荐。\n\n上一阶段仍有未解决工作，请从当前企业员工目录中推荐适合申请授权的员工。\n保留已有意图分析和已确定的工作。',
    }
    for (const stage of ['authorized', 'enterprise'] as const) {
      const prompt = buildArrangementPlannerUserPrompt(buildArrangementPlannerInput(draft, [], stage))
      assert.equal(prompt.split('\n\n以下是本轮规划数据')[0], expected[stage])
      assert.doesNotMatch(prompt, /能力最接近且能够完成该步骤预期交付/)
    }
  })

  it('snapshots data without leaking execution-only node fields', () => {
    const source = structuredClone(draft)
    source.nodes = [{ id: 'n1', title: '研究', subscriptionId: 'sub', modelId: 'model', instruction: '研究需求', expectedOutput: '报告', knowledgeQuery: '内部标准', dependsOn: [], skillIds: ['private'], requiresUserConfirmation: true }]
    const input = buildArrangementPlannerInput(source, [], 'authorized')
    source.confirmedInputs.push('changed')
    assert.deepEqual(input.confirmedInputs, draft.confirmedInputs)
    assert.doesNotMatch(JSON.stringify(input), /skillIds|requiresUserConfirmation/)
  })

  it('passes real tool availability and keeps unknown distinct from an unavailable tool', () => {
    const mediaTools = { media_generate_image: { state: 'available', reason: 'authorized-runtime' },
      video_generate: { state: 'unavailable', reason: 'runtime-unavailable' },
      video_from_image: { state: 'unknown', reason: 'runtime-not-checked' } } as const
    const input = buildArrangementPlannerInput(draft, [{ subscriptionId: 'sub', employeeId: 'employee', name: 'Creator',
      allowedModels: ['model'], status: 'ACTIVE', mediaTools }], 'authorized')
    assert.deepEqual(input.employeeCatalog[0]!.mediaTools, mediaTools)
    const candidate = buildArrangementPlannerInput(draft, [{ subscriptionId: '', employeeId: 'candidate', name: 'Candidate',
      allowedModels: [], status: 'ACTIVE', canExecute: false }], 'enterprise')
    assert.equal(candidate.employeeCatalog[0]!.mediaTools?.video_generate.state, 'unknown')
    assert.doesNotMatch(JSON.stringify(input), /accessToken|gatewayUrl|systemPrompt|skillPaths/)
  })

  it('passes the user-selected knowledge scope and trusted catalog to the planner', () => {
    const source = structuredClone(draft) as typeof draft & { knowledge?: { mode: 'auto'; knowledgeBaseIds: string[] }; plannerKnowledgeCatalog?: Array<{ id: string; name: string }> }
    source.knowledge = { mode: 'auto', knowledgeBaseIds: ['kb-a'] }
    source.plannerKnowledgeCatalog = [{ id: 'kb-a', name: '企业制度库' }]
    const input = buildArrangementPlannerInput(source, [], 'authorized')
    assert.deepEqual(input.knowledgeSelection, source.knowledge)
    assert.deepEqual(input.knowledgeCatalog, source.plannerKnowledgeCatalog)
    assert.match(buildArrangementPlannerUserPrompt(input), /企业制度库/)
  })

  it('preserves existing media requirements in every stage and correction input', () => {
    const source = structuredClone(draft)
    source.nodes = [{
      id: 'n1', title: 'Video', subscriptionId: 'sub', modelId: 'model', instruction: 'Animate the poster',
      expectedOutput: 'Video', dependsOn: ['image'], skillIds: [],
      mediaRequirements: [{ id: 'animate', kind: 'video', operation: 'image-to-video',
        inputFrom: { nodeId: 'image', deliverableId: 'poster' }, preferred: { durationSeconds: 5 } }],
    }]
    for (const stage of ['authorized', 'enterprise', 'platform'] as const) {
      const input = buildArrangementPlannerInput(source, [], stage)
      assert.deepEqual(input.existingNodes[0]?.mediaRequirements, source.nodes[0]!.mediaRequirements)
      const requirement = JSON.stringify(input.existingNodes[0]!.mediaRequirements, null, 2)
      for (const phase of ['response-assembly', 'json-extraction', 'json-parse', 'output-validation', 'employee-validation', 'model-validation', 'dag-validation'] as const) {
        assert.ok(buildArrangementPlannerRepairPrompt(phase, input).includes(JSON.stringify(input, null, 2)))
      }
      assert.ok(buildArrangementPlannerUserPrompt(input).includes(JSON.stringify(input, null, 2)))
      assert.match(requirement, /poster/)
    }
  })

  for (const [phase, phrase] of [
    ['response-assembly', '响应完整性检查'], ['json-extraction', '未能提取到规划 JSON'],
    ['json-parse', 'JSON 语法错误'], ['output-validation', '输出结构与节点工作要求检查'],
    ['employee-validation', '员工有效性检查'], ['model-validation', '模型有效性检查'],
    ['dag-validation', '草稿与执行节点依赖检查'],
  ] as const) it(`repairs ${phase} with stage-specific structure and the same trusted data`, () => {
    for (const stage of ['authorized', 'enterprise', 'platform'] as ArrangementPlanningStage[]) {
      const input = buildArrangementPlannerInput(draft, [], stage)
      const prompt = buildArrangementPlannerRepairPrompt(phase, input)
      assert.ok(prompt.includes(phrase))
      assert.ok(prompt.includes(JSON.stringify(input, null, 2)))
      assert.match(prompt, /当前阶段完整输出结构/)
      assert.match(prompt, /保留用户目标/)
      assert.doesNotMatch(prompt, /具体错误|stopReason|上一份实际原始回复|第一阶段|第二阶段|第三阶段/)
    }
  })

  it('omits the unnecessary previous-output disclaimer from system rules', () => {
    assert.doesNotMatch(ARRANGEMENT_PLANNER_RULES, /上一份输出可能不是合法 JSON|应以程序提供的实际原始输出和错误信息为依据/)
  })

  it('keeps the fixed rules synchronized with the approved document', async () => {
    const document = await readFile(new URL('../../prompts/arrangement-planner-prompts.md', import.meta.url), 'utf8')
    const rules = document.slice(document.indexOf('# 硅基员工自动编排规划 Agent')).trim()
    assert.equal(ARRANGEMENT_PLANNER_RULES, rules.replace(/\r\n/g, '\n').replace('"path": "deliverables/具体文件"', '"path": "deliverables/具体文件.docx"'))
  })
})
