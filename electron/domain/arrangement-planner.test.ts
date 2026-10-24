import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildArrangementPlannerPrompt, parseArrangementPlannerOutput, type ArrangementPlannerEmployee } from './arrangement-planner'
import { arrangementNodeWorkContractSchema, type ArrangementDraft } from './arrangement-plan'
import { planningErrorFields } from '../errors/planning-diagnostics'
import { ARRANGEMENT_PLANNER_RULES } from './arrangement-planner-prompts'

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
  const marker = '以下示例仅用于说明结构，具体内容必须根据本轮数据生成，不得复制占位符：\n\n'
  const start = prompt.indexOf(marker)
  const end = prompt.indexOf('\n\nunresolvedSteps 中每项结构：', start)
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

    it(`uses stage data separately from system rules for ${source} employees`, () => {
      const prompt = buildArrangementPlannerPrompt(draft, [candidate], source)
      assert.match(prompt, source === 'enterprise' ? /第二阶段：企业待授权员工推荐/ : /第三阶段：平台待授权员工推荐/)
      assert.match(prompt, new RegExp(`"planningStage": "${source}"`))
      assert.match(prompt, /"allowedModels": \[\]/)
      assert.ok(!prompt.includes(ARRANGEMENT_PLANNER_RULES))
      assert.match(ARRANGEMENT_PLANNER_RULES, /nodes 必须返回 \[\]/)
      assert.match(ARRANGEMENT_PLANNER_RULES, /推荐成功不代表获得授权/)
      assert.match(ARRANGEMENT_PLANNER_RULES, /原样保留意图摘要、步骤 ID、能力需求和步骤依赖/)
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
    assert.match(prompt, /第一阶段：已授权员工匹配/)
    assert.match(ARRANGEMENT_PLANNER_RULES, /同一个员工可以承担多个步骤/)
    assert.match(ARRANGEMENT_PLANNER_RULES, /不同员工总数最多 6 名/)
    assert.match(ARRANGEMENT_PLANNER_RULES, /不默认增加项目经理、协调员、审核员或汇总员/)
    const example = outputExample(ARRANGEMENT_PLANNER_RULES)
    assert.ok(Array.isArray(example.nodes) && example.nodes.length > 0)
    assert.ok(JSON.stringify(example).includes('modelId'))
  })

  it('includes confirmed input materials and constraints in every planning phase', () => {
    const confirmedInputs = ['使用 inputs/customer-brief.docx 中的要求', '预算不超过 10000 元']
    for (const employee of [authorized, { ...authorized, source: 'platform' as const, canExecute: false, allowedModels: [] }]) {
      const prompt = buildArrangementPlannerPrompt({ ...draft, confirmedInputs }, [employee])
      assert.match(prompt, /inputs\/customer-brief.docx/)
      assert.match(prompt, /预算不超过 10000 元/)
    }
  })

  it('passes existing executable nodes as stage data to recommendations', () => {
    const existingNode = { id: 'existing-node', subscriptionId: 'subscription-existing', modelId: 'model-a',
      title: '整理客户材料', instruction: '整理材料', expectedOutput: '客户材料', dependsOn: [], skillIds: [], requiresUserConfirmation: false }
    const prompt = buildArrangementPlannerPrompt({ ...draft, nodes: [existingNode] }, [{ ...authorized, source: 'platform', canExecute: false, allowedModels: [] }], 'platform')
    assert.match(prompt, /existing-node/)
    assert.match(prompt, /"existingNodes": \[/)
    assert.ok(!prompt.includes('以下示例'))
  })

  it('uses the approved system rules and readable node contract example', () => {
    const prompt = ARRANGEMENT_PLANNER_RULES
    const sections = ['核心规划原则', '工作拆分与员工选择', '节点执行要求', '交付物与依赖', '已有规划与阶段处理', 'JSON 输出协议', '校验失败后的修正']
    assert.deepEqual([...prompt.matchAll(/# [一二三四五六七]、([^\n]+)/g)].map(match => match[1]), sections)
    assert.match(prompt, /只输出符合协议的严格 JSON/)
    assert.match(prompt, /不执行用户任务、不调用工具、不创建文件/)
    assert.match(prompt, /所有工作必须共同覆盖用户要求的最终成果/)
    assert.ok(!prompt.includes('requiresUserConfirmation'))
    const example = outputExample(prompt)
    assert.deepEqual(Object.keys(example), ['title', 'intentAnalysis', 'nodes', 'unresolvedSteps', 'candidateMatches'])
    const node = (example.nodes as Array<Record<string, unknown>>)[0]!
    assert.equal(typeof node.knowledgeQuery, 'string')
    assert.equal(typeof node.objective, 'string')
    assert.deepEqual(Object.keys((node.deliverables as Array<Record<string, unknown>>)[0]!), ['id', 'name', 'format', 'path', 'contentOutline', 'acceptanceCriteria'])
    assert.ok(prompt.includes('\n  "intentAnalysis": {\n'))
    assert.match(prompt, /mediaRequirements/)
    assert.match(prompt, /inputFrom\.nodeId 必须同时出现在 dependsOn/)
    assert.match(prompt, /不得猜测供应商型号或 manifest 能力范围/)
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

  it('preserves media requirements and typed image/video deliverables from planner output', () => {
    const result = parseArrangementPlannerOutput(JSON.stringify({
      title: 'Create an image and video',
      nodes: [
        { ...node, id: 'image', title: 'Create image', dependsOn: [], objective: 'Create image', deliverables: [{
          ...deliverable, id: 'poster', format: 'png', path: 'deliverables/poster.png',
          artifact: { kind: 'image', source: 'media-output', operation: 'generate' },
        }] },
        { ...node, id: 'video', title: 'Animate image', dependsOn: ['image'], objective: 'Animate image', deliverables: [{
          ...deliverable, id: 'video', format: 'mp4', path: 'deliverables/video.mp4',
          artifact: { kind: 'video', source: 'media-output', operation: 'image-to-video' },
        }], mediaRequirements: [{
          id: 'source-poster', kind: 'video', operation: 'image-to-video',
          inputFrom: { nodeId: 'image', deliverableId: 'poster' },
        }] },
      ],
    }), draft, [authorized])
    assert.deepEqual(result.nodes[1]?.mediaRequirements, [{
      id: 'source-poster', kind: 'video', operation: 'image-to-video', inputFrom: { nodeId: 'image', deliverableId: 'poster' },
    }])
    assert.deepEqual(result.nodes[0]?.deliverables?.[0]?.artifact, { kind: 'image', source: 'media-output', operation: 'generate' })
  })

  const imageFile = { ...deliverable, id: 'poster', format: 'png', path: 'deliverables/poster.png' }
  const videoFile = { ...deliverable, id: 'video', format: 'mp4', path: 'deliverables/video.mp4' }
  const source = { nodeId: 'image', deliverableId: 'poster' }
  function parseMediaPair(imageRequirement: unknown, videoRequirement: unknown, withArtifacts = false) {
    return parseArrangementPlannerOutput(JSON.stringify({ title: 'Product media', nodes: [
      { ...node, id: 'image', mediaRequirements: [imageRequirement], deliverables: [{ ...imageFile,
        ...(withArtifacts ? { artifact: { kind: 'image', source: 'media-output', operation: 'text-to-image' } } : {}) }], requiresUserConfirmation: true },
      { ...node, id: 'video', dependsOn: ['image'], mediaRequirements: [videoRequirement], deliverables: [{ ...videoFile,
        ...(withArtifacts ? { artifact: { kind: 'video', source: 'media-output', operation: 'image-to-video' } } : {}) }] },
    ] }), draft, [authorized])
  }

  it('recovers the 14:43 planner response shape without losing references or preferences', () => {
    const result = parseMediaPair(
      { kind: 'image', operation: 'text-to-image', required: true, inputSelection: 'none', preferred: { aspectRatio: '16:9', orientation: 'landscape', subject: 'Product', scene: 'Window light', style: 'Photography' } },
      { kind: 'video', operation: 'image-to-video', required: true, inputSelection: 'specified', inputFrom: [source], preferred: { durationSeconds: 5, cameraMotion: 'Slow push', atmosphere: 'Steam', consistency: 'Keep appearance' } },
      true,
    )
    assert.equal(result.nodes.length, 2)
    assert.equal(result.nodes[0]!.requiresUserConfirmation, undefined)
    assert.equal(result.nodes[0]!.mediaRequirements![0]!.id, 'media-1')
    assert.equal(result.nodes[0]!.mediaRequirements![0]!.operation, 'generate')
    assert.equal(result.nodes[0]!.mediaRequirements![0]!.preferred!.style, 'Photography')
    assert.equal(result.nodes[0]!.deliverables![0]!.artifact!.operation, 'generate')
    assert.deepEqual(result.nodes[1]!.mediaRequirements![0]!.inputFrom, source)
    assert.equal(result.nodes[1]!.mediaRequirements![0]!.inputSelection, 'single')
    assert.equal(result.nodes[1]!.mediaRequirements![0]!.preferred!.cameraMotion, 'Slow push')
  })

  it('recovers the 14:50 response shape and fills the omitted media delivery mappings', () => {
    const result = parseMediaPair(
      { kind: 'image', operation: 'text-to-image', inputSelection: {}, preferred: { style: 'Photo', prompt: 'Product on table' } },
      { kind: 'video', operation: 'image-to-video', inputSelection: { inputFrom: [source] }, preferred: { prompt: 'Slow motion', durationSeconds: 5 } },
    )
    assert.equal(result.nodes[0]!.mediaRequirements![0]!.inputSelection, undefined)
    assert.deepEqual(result.nodes[0]!.deliverables![0]!.artifact, { kind: 'image', source: 'media-output', operation: 'generate' })
    assert.deepEqual(result.nodes[1]!.deliverables![0]!.artifact, { kind: 'video', source: 'media-output', operation: 'image-to-video' })
    assert.deepEqual(result.nodes[1]!.mediaRequirements![0]!.inputFrom, source)
  })

  it('avoids generated ID collisions and keeps explicit workspace delivery intent', () => {
    const result = parse({ deliverables: [{ ...imageFile, artifact: { kind: 'image', source: 'workspace' } }], mediaRequirements: [
      { id: 'media-1', kind: 'image', operation: 'generate' }, { operation: 'text-to-image' },
    ] })
    assert.deepEqual(result.nodes[0]!.mediaRequirements!.map(requirement => requirement.id), ['media-1', 'media-2'])
    assert.deepEqual(result.nodes[0]!.deliverables![0]!.artifact, { kind: 'image', source: 'workspace' })
  })

  it('requires explicit delivery metadata when multiple media operations make inference ambiguous', () => {
    const mediaRequirements = [
      { id: 'generate', kind: 'image', operation: 'generate' },
      { id: 'edit', kind: 'image', operation: 'edit', inputFrom: { artifactId: 'asset-selected' } },
    ]
    assert.throws(() => parse({ deliverables: [imageFile], mediaRequirements }), /deliverables.0.artifact/)
    const result = parse({ deliverables: [{ ...imageFile, artifact: { kind: 'image', source: 'media-output', operation: 'edit' } }], mediaRequirements })
    assert.equal(result.nodes[0]!.deliverables![0]!.artifact!.operation, 'edit')
  })

  it('rejects missing required image inputs and unsupported direct-media formats before execution', () => {
    for (const operation of ['edit', 'image-to-video']) {
      assert.throws(() => parse({ mediaRequirements: [{ id: 'input', kind: operation === 'edit' ? 'image' : 'video', operation }] }), /mediaRequirements.0.inputFrom/)
    }
    for (const format of ['mov', 'gif', 'avif']) {
      assert.throws(() => parse({ deliverables: [{ ...videoFile, format, path: `deliverables/file.${format}`, artifact: { kind: 'video', source: 'media-output' } }] }), /deliverables.0.format/)
    }
    assert.throws(() => parse({ deliverables: [{ ...imageFile, artifact: { kind: 'video', source: 'media-output' } }] }), /deliverables.0.format/)
    const converted = { ...videoFile, format: 'mov', path: 'deliverables/file.mov', artifact: { kind: 'video', source: 'workspace' } }
    assert.deepEqual(parse({ deliverables: [converted] }).nodes[0]!.deliverables, [converted])
  })

  it('rejects multiple, conflicting, undeclared and malformed media sources instead of guessing', () => {
    for (const extra of [
      { inputFrom: [source, { nodeId: 'other' }] },
      { inputFrom: source, inputSelection: { inputFrom: [{ nodeId: 'other' }] } },
      { inputFrom: { nodeId: 'outside' } },
      { inputFrom: { ...source, deliverableId: 'missing' } },
      { inputFrom: { deliverableId: 'poster' } },
      { inputFrom: { ...source, arbitrary: true } },
      { inputFrom: source, kind: 'image' },
    ]) assert.throws(() => parseMediaPair({ kind: 'image', operation: 'generate' }, { kind: 'video', operation: 'image-to-video', ...extra }))
  })

  it('reports the node and safe field path when an unrecognized value still fails validation', () => {
    assert.throws(() => parse({ mediaRequirements: [{ id: 'image', kind: 'image', operation: 'generate', inputSelection: 'private-selection' }] }), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /第 1 个节点/)
      const fields = planningErrorFields(error)
      assert.deepEqual(fields.validationIssues, [{ path: 'mediaRequirements.0.inputSelection', code: 'invalid_value' }])
      assert.doesNotMatch(JSON.stringify(fields), /private-selection/)
      return true
    })
  })

  it('publishes schema-valid examples for every supported media operation', () => {
    const prompt = ARRANGEMENT_PLANNER_RULES
    const start = prompt.indexOf('媒体结构示例（四项是独立场景，按用户实际需求选用，不要全部添加）：\n')
    const exampleStart = prompt.indexOf('[', start)
    const exampleEnd = prompt.indexOf('\n以上为节点中的媒体字段', exampleStart)
    const examples = JSON.parse(prompt.slice(exampleStart, exampleEnd)) as Array<Record<string, unknown>>
    assert.equal(examples.length, 4)
    for (const example of examples) assert.equal(arrangementNodeWorkContractSchema.safeParse(example).success, true)
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
