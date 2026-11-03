import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ARRANGEMENT_PLANNER_RULES, ARRANGEMENT_PLANNER_OUTPUT_EXAMPLE, buildArrangementPlannerInput, buildArrangementPlannerRepairPrompt } from './arrangement-planner-prompts'
import { parseArrangementPlannerOutput, type ArrangementPlannerEmployee, type ArrangementPlannerDraft } from './arrangement-planner'
import { planningErrorFields } from '../errors/planning-diagnostics'

const attachment = { attachmentId: 'photo', sha256: 'a'.repeat(64) }
const employee: ArrangementPlannerEmployee = { subscriptionId: 'sub', employeeId: 'employee', name: 'Creator', status: 'ACTIVE', canExecute: true, source: 'authorized', allowedModels: ['model'] }
const draft: ArrangementPlannerDraft = {
  id: 'draft', schemaVersion: 1, revision: 1, owner: { memberId: 'member', enterpriseId: 'enterprise' },
  mode: 'auto', status: 'planning', title: '', goal: 'Create a promotional video', confirmedInputs: [],
  sharedSkillIds: [], conversation: null, nodes: [], workspace: { mode: 'shared', path: null }, permissions: { preset: 'read-only' },
  createdAt: 1, updatedAt: 1, lastPlanning: null, attachmentCandidates: [{ attachment, mustUse: true }],
  plannerAttachmentMaterials: [{ attachment, displayName: 'photo.png', mediaType: 'image/png', byteLength: 100, summary: 'Product photo', warnings: [], mustUse: true }],
}
const node = { id: 'node', subscriptionId: 'sub', modelId: 'model', title: 'Video', instruction: 'Create video', dependsOn: [],
  inputRefs: [{ kind: 'attachment', attachment, required: true, purpose: 'media-source' }],
  mediaRequirements: [{ id: 'animate', kind: 'video', operation: 'image-to-video', inputSelection: 'single' }],
}
const parse = (value: unknown, source = draft) => parseArrangementPlannerOutput(JSON.stringify({ title: 'Video', nodes: [value] }), source, [employee])

describe('planning contract and actionable correction', () => {
  it('accepts a verified bound image attachment without inventing a media artifact ID', () => {
    const result = parse(node)
    assert.deepEqual(result.nodes[0]!.inputRefs, node.inputRefs)
    assert.equal(result.nodes[0]!.mediaRequirements![0]!.inputFrom, undefined)
  })

  it('does not treat a document or an unverified attachment as an image source', () => {
    assert.throws(() => parse(node, { ...draft, plannerAttachmentMaterials: draft.plannerAttachmentMaterials!.map(item => ({ ...item, mediaType: 'application/pdf' })) }))
    assert.throws(() => parse(node, { ...draft, plannerAttachmentMaterials: [] }))
    assert.throws(() => parse({ ...node, inputRefs: [{ ...node.inputRefs[0], attachment: { ...attachment, sha256: 'b'.repeat(64) } }] }))
  })

  it('rejects ambiguous multiple attachment inputs until the source is selected', () => {
    const second = { attachmentId: 'second', sha256: 'b'.repeat(64) }
    const source = { ...draft, attachmentCandidates: [...draft.attachmentCandidates!, { attachment: second, mustUse: false }],
      plannerAttachmentMaterials: [...draft.plannerAttachmentMaterials!, { ...draft.plannerAttachmentMaterials![0]!, attachment: second }] }
    assert.throws(() => parse({ ...node, inputRefs: [...node.inputRefs, { ...node.inputRefs[0], attachment: second }] }, source))
  })

  it('reports the exact failed attachment field and expected nested structure', () => {
    let failure: unknown
    try { parse({ ...node, inputRefs: [{ type: 'attachment', ...attachment, required: true, purpose: 'media-source' }] }) } catch (error) { failure = error }
    assert.ok(failure)
    assert.equal((planningErrorFields(failure).validationIssues as Array<{ path: string }>)[0]!.path, 'inputRefs.0.kind')
    const prompt = buildArrangementPlannerRepairPrompt('output-validation', buildArrangementPlannerInput(draft, [employee], 'authorized'), failure)
    assert.match(prompt, /nodes\[0\].inputRefs\[0\].kind/)
    assert.match(prompt, /"kind": "attachment"/)
    assert.match(prompt, /"attachment": \{/)
    assert.match(prompt, /尚未执行/)
    assert.match(prompt, /保留/)
    assert.doesNotMatch(prompt, /调用工具|实际生成文件|最多修正|修正次数上限/)
  })

  it('explains structural constraints in the system prompt instead of relying on repair', () => {
    for (const field of ['inputRefs', 'attachment', 'requiredSpec', 'proposedSpec', 'parameterSources', 'decisionRef', 'specRevision', 'generationMethod', 'inputSelection']) assert.ok(ARRANGEMENT_PLANNER_RULES.includes(field), field)
    assert.match(ARRANGEMENT_PLANNER_RULES, /durationSeconds.*正整数/)
    assert.match(ARRANGEMENT_PLANNER_RULES, /media-source/)
    assert.match(ARRANGEMENT_PLANNER_RULES, /inputRefs.*仅.*attachment/)
    assert.match(ARRANGEMENT_PLANNER_RULES, /不执行用户任务、不调用工具、不创建文件/)
  })

  it('does not expose raw exceptions in repair messages', () => {
    const prompt = buildArrangementPlannerRepairPrompt('json-parse', buildArrangementPlannerInput(draft, [employee], 'authorized'), new SyntaxError('PRIVATE_TOKEN PRIVATE_MODEL_OUTPUT'))
    assert.doesNotMatch(prompt, /PRIVATE_TOKEN|PRIVATE_MODEL_OUTPUT|stack|causeFingerprint/)
    assert.match(prompt, /JSON/)
  })

  it('identifies the failed dependency instead of asking to rewrite an otherwise valid plan', () => {
    let failure: unknown
    try { parse({ ...node, dependsOn: ['missing'] }) } catch (error) { failure = error }
    const prompt = buildArrangementPlannerRepairPrompt('dag-validation', buildArrangementPlannerInput(draft, [employee], 'authorized'), failure)
    assert.match(prompt, /nodes\[0\].dependsOn\[0\]/)
    assert.match(prompt, /不存在|有效节点/)
  })

  it('shows and parses the complete attachment-to-image-to-video contract in the main JSON example', () => {
    const example = JSON.parse(JSON.stringify(ARRANGEMENT_PLANNER_OUTPUT_EXAMPLE))
    assert.equal(example.nodes.length, 2)
    for (const candidate of example.nodes) {
      candidate.subscriptionId = employee.subscriptionId
      candidate.modelId = employee.allowedModels[0]!
      for (const ref of candidate.inputRefs) ref.attachment = attachment
    }
    const result = parseArrangementPlannerOutput(JSON.stringify(example), draft, [employee])
    const image = result.nodes[0]!
    const video = result.nodes[1]!
    assert.equal(image.inputRefs![0]!.kind, 'attachment')
    assert.equal(image.mediaRequirements![0]!.operation, 'edit')
    assert.equal(image.deliverables![0]!.artifact!.source, 'media-output')
    assert.equal(video.mediaRequirements![0]!.operation, 'image-to-video')
    assert.deepEqual(video.mediaRequirements![0]!.inputFrom, { nodeId: image.id, deliverableId: image.deliverables![0]!.id })
    assert.deepEqual(video.dependsOn, [image.id])
    assert.deepEqual(video.mediaRequirements![0]!.requiredSpec, { durationSeconds: 10 })
    assert.ok(video.mediaRequirements![0]!.proposedSpec)
    assert.ok(video.mediaRequirements![0]!.parameterSources)
    assert.match(ARRANGEMENT_PLANNER_RULES, /普通文档.*省略.*mediaRequirements/)

    const generatedImage = structuredClone(example)
    generatedImage.nodes[0].mediaRequirements[0].operation = 'generate'
    generatedImage.nodes[0].deliverables[0].artifact.operation = 'generate'
    generatedImage.nodes[0].inputRefs = []
    delete generatedImage.nodes[0].mediaRequirements[0].inputSelection
    assert.equal(parseArrangementPlannerOutput(JSON.stringify(generatedImage), { ...draft, attachmentCandidates: [], plannerAttachmentMaterials: [] }, [employee]).nodes.length, 2)

    const textVideo = structuredClone(example)
    textVideo.nodes[1].mediaRequirements[0].operation = 'text-to-video'
    textVideo.nodes[1].deliverables[0].artifact.operation = 'text-to-video'
    delete textVideo.nodes[1].mediaRequirements[0].inputFrom
    delete textVideo.nodes[1].mediaRequirements[0].inputSelection
    textVideo.nodes[1].dependsOn = []
    assert.equal(parseArrangementPlannerOutput(JSON.stringify(textVideo), draft, [employee]).nodes.length, 2)
  })

  it('keeps media structures visible in every authorized correction without forcing them onto document tasks', () => {
    const input = buildArrangementPlannerInput(draft, [employee], 'authorized')
    for (const phase of ['response-assembly', 'json-extraction', 'json-parse', 'output-validation', 'employee-validation', 'model-validation', 'dag-validation'] as const) {
      const prompt = buildArrangementPlannerRepairPrompt(phase, input)
      const marker = '【当前阶段完整输出结构】\n'
      const start = prompt.indexOf(marker) + marker.length
      const shape = JSON.parse(prompt.slice(start, prompt.indexOf('\n\n', start)))
      const video = shape.nodes.find((candidate: { mediaRequirements?: Array<{ kind: string }> }) => candidate.mediaRequirements?.some(requirement => requirement.kind === 'video'))
      assert.ok(video)
      assert.ok(video.mediaRequirements[0].requiredSpec)
      assert.ok(video.deliverables[0].artifact)
      assert.match(prompt, /普通文档.*省略.*mediaRequirements/)
    }
  })

  for (const stage of ['enterprise', 'platform'] as const) it(`keeps ${stage} repair examples inside recommendation boundaries`, () => {
    const input = buildArrangementPlannerInput({ ...draft, intentAnalysis: ARRANGEMENT_PLANNER_OUTPUT_EXAMPLE.intentAnalysis,
      unresolvedSteps: [{ stepId: 'step-1', reason: 'Awaiting authorization', requiredCapabilities: ['Video'] }] }, [employee], stage)
    const prompt = buildArrangementPlannerRepairPrompt('output-validation', input)
    const start = prompt.indexOf('【当前阶段完整输出结构】\n') + '【当前阶段完整输出结构】\n'.length
    const shape = JSON.parse(prompt.slice(start, prompt.indexOf('\n\n', start))) as Record<string, unknown>
    assert.deepEqual(shape.nodes, [])
    assert.deepEqual(shape.intentAnalysis, input.intentSnapshot)
    assert.deepEqual(shape.unresolvedSteps, input.unresolvedSteps)
  })
})
