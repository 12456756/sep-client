import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildDeliveryCorrection, deliveryPlanIssues, finalDeliveryFileSchema, nodeDeliveryProgressSchema, parseDeliverySubmission, parseRecordedDeliverySubmission } from './arrangement-delivery'
import type { ArrangementNode } from './arrangement-plan'

const node: ArrangementNode = {
  id: 'research', subscriptionId: 'employee', modelId: 'model', title: 'Research', objective: 'Find opportunities',
  instruction: 'Research', expectedOutput: 'Report', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
  deliverables: [{ id: 'report', name: 'Report', format: 'txt', path: 'deliverables/report.txt', contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }],
}
const submission = { nodeId: node.id, summary: 'Research complete', finalDeliverables: [{ id: 'report', path: 'deliverables/report.txt' }] }
const submissionCorrection = '当前节点尚未通过最终交付校验。请承接已有上下文和工具结果，继续完成尚未完成的任务。\n\n保留并复用已经完成的工作、有效文件和已收集的信息，不要从头重做，不要重复创建已有有效文件或重复收集已有信息；允许按需补写、修改和修复未完成的文件。\n\n以实际工具执行结果和文件状态为准，不要把此前描述的计划当作已经执行。需要操作时实际调用工具，不要只说明接下来要做什么。\n\n如果工作已经完成，只需按要求提交最终 JSON；否则先完成剩余工作，再提交。'

describe('node final delivery protocol', () => {
  it('retains validation counts beyond five without imposing a correction limit', () => {
    assert.equal(nodeDeliveryProgressSchema.parse({ validationAttempts: 20, issues: [], finalFiles: [] }).validationAttempts, 20)
    assert.doesNotMatch(buildDeliveryCorrection([{ code: 'FILE_MISSING', message: 'missing' }], node), /最多|上限|停止自动修正/)
  })
  it('preserves unrelated settlement correction prompts', () => {
    for (const code of ['MISSING_DELIVERY_CONTRACT', 'OUTPUT_TRUNCATED', 'NODE_NOT_SETTLED']) {
      assert.equal(buildDeliveryCorrection([{ code, message: 'Stored diagnostic, not prompt text' }], node), submissionCorrection, code)
    }
  })
  it('includes concrete file diagnostics and keeps model repair scoped to its own ordinary files', () => {
    for (const code of ['FILE_MISSING', 'UNSAFE_PATH', 'NOT_A_FILE', 'EMPTY_FILE', 'FILE_TOO_LARGE', 'FILE_CHANGED', 'INVALID_FORMAT', 'SNAPSHOT_CHANGED', 'SNAPSHOT_UNAVAILABLE']) {
      const prompt = buildDeliveryCorrection([{ code, message: 'Actual file diagnostic', deliverableId: 'report', path: 'deliverables/report.txt' }], node)
      for (const value of [code, 'Actual file diagnostic', 'deliverables/report.txt', 'report', '不得修改前置节点文件、内部交付快照或交付计划']) assert.ok(prompt.includes(value))
    }
  })
  it('requests mapping repair only and never asks for a new paid generation', () => {
    for (const code of ['DUPLICATE_MEDIA_DELIVERY', 'MEDIA_DELIVERY_MANIFEST_MISMATCH', 'MISSING_MEDIA_DELIVERY']) {
      const prompt = buildDeliveryCorrection([{ code, message: 'Wrong mapping: original-asset', deliverableId: 'report' }], node)
      assert.ok(prompt.includes(code))
      assert.match(prompt, /Wrong mapping: original-asset/)
      assert.match(prompt, /只修正 mediaDeliverables/)
      assert.match(prompt, /不要重新生成图片或视频/)
      assert.match(prompt, /不要猜测或任意选择多个候选/)
    }
  })
  it('classifies actual parser errors as submission failures', () => {
    for (const text of ['', JSON.stringify({ ...submission, nodeId: 'other' }), JSON.stringify({ ...submission, finalDeliverables: [{ id: 'other', path: 'other.txt' }] })]) {
      const result = parseDeliverySubmission(node, text)
      assert.ok(!result.ok)
      const prompt = buildDeliveryCorrection(result.issues, node)
      assert.match(prompt, /实际文件检查尚未执行/)
      assert.ok(prompt.includes(JSON.stringify(node.id)))
      assert.ok(prompt.includes(JSON.stringify(node.deliverables![0]!.path)))
    }
  })
  it('returns only the first failed stage and writes concrete JSON correction instructions', () => {
    const result = parseDeliverySubmission(node, '```json\n{\n```')
    assert.ok(!result.ok)
    assert.equal(result.issues.length, 1)
    assert.equal(result.issues[0]?.submissionStage, 'json')
    const prompt = buildDeliveryCorrection(result.issues, node)
    assert.match(prompt, /你的最终回复不是合法的 JSON/)
    assert.match(prompt, /字段、节点 ID、交付清单和实际文件检查尚未执行/)
    assert.match(prompt, /不在最后一个字段后添加逗号/)
    assert.match(prompt, /不要因此重复研究、生成图片或视频、下载或者修改已有有效文件/)
    assert.match(prompt, /如果实际工作尚未完成，先完成剩余工作，不得虚报完成/)
    const example = JSON.parse(prompt.split('【当前节点完整提交结构】\n')[1]!.split('\n\n')[0]!)
    assert.equal(example.nodeId, node.id)
    assert.deepEqual(example.finalDeliverables, submission.finalDeliverables)
    assert.equal(example.mediaDeliverables, undefined)
    assert.doesNotMatch(prompt, /\{实际提交值\}|\{正确值\}|\{逐条/)
  })
  it('reports missing, empty, wrong-type and extra fields without echoing response bodies', () => {
    for (const [value, field, reason] of [
      [{ ...submission, summary: '' }, 'summary', '至少'],
      [{ nodeId: node.id, finalDeliverables: submission.finalDeliverables }, 'summary', '未提供'],
      [{ ...submission, finalDeliverables: 'wrong' }, 'finalDeliverables', '数组'],
      [{ ...submission, finalDeliverables: [{ id: 'report', path: 123 }] }, 'finalDeliverables.0.path', '字符串'],
      [{ ...submission, unexpected: 'private response body' }, '根对象', 'unexpected'],
    ] as const) {
      const result = parseDeliverySubmission(node, JSON.stringify(value))
      assert.ok(!result.ok)
      assert.equal(result.issues[0]?.submissionStage, 'fields')
      const prompt = buildDeliveryCorrection(result.issues, node)
      assert.ok(prompt.includes(field), prompt)
      assert.ok(prompt.includes(reason), prompt)
      assert.match(prompt, /字段检查未通过/)
      assert.match(prompt, /节点 ID、交付清单匹配和实际文件检查尚未执行/)
      assert.doesNotMatch(prompt, /private response body|JSON 无法解析/)
    }
  })
  it('reports actual and expected node IDs and does not run manifest checks after a wrong node', () => {
    const result = parseDeliverySubmission(node, JSON.stringify({ ...submission, nodeId: 'wrong-node', finalDeliverables: [{ id: 'wrong', path: 'wrong' }] }))
    assert.ok(!result.ok)
    assert.equal(result.issues.length, 1)
    assert.equal(result.issues[0]?.submissionStage, 'node')
    const prompt = buildDeliveryCorrection(result.issues, node)
    assert.match(prompt, /你提交的 nodeId："wrong-node"/)
    assert.match(prompt, /当前节点要求的 nodeId："research"/)
    assert.match(prompt, /交付清单匹配和实际文件检查尚未执行/)
    assert.doesNotMatch(prompt, /计划外交付物/)
  })
  it('collects concrete missing, duplicate, extra and wrong-path manifest issues in one prompt', () => {
    const planNode = { ...node, deliverables: [...node.deliverables!, { ...node.deliverables![0]!, id: 'data', path: 'deliverables/data.txt' }] }
    const result = parseDeliverySubmission(planNode, JSON.stringify({ ...submission, finalDeliverables: [
      { id: 'report', path: 'wrong/report.txt' }, ...submission.finalDeliverables, { id: 'draft', path: 'draft.txt' },
    ] }))
    assert.ok(!result.ok)
    assert.ok(result.issues.every(issue => issue.submissionStage === 'manifest'))
    const prompt = buildDeliveryCorrection(result.issues, planNode)
    for (const expected of ['路径不符', '重复交付物', '计划外交付物', '缺少必需交付物', 'wrong/report.txt', 'deliverables/report.txt', 'draft.txt', 'deliverables/data.txt']) {
      assert.ok(prompt.includes(expected), expected)
    }
    assert.match(prompt, /实际文件检查尚未执行；清单错误不代表文件生成失败/)
  })
  it('persists failure stages while keeping older checkpoints readable', () => {
    const parsed = parseDeliverySubmission(node, JSON.stringify({ ...submission, summary: '' }))
    assert.ok(!parsed.ok)
    const restored = nodeDeliveryProgressSchema.parse(JSON.parse(JSON.stringify({ validationAttempts: 21, issues: parsed.issues, finalFiles: [] })))
    assert.equal(restored.issues[0]?.submissionStage, 'fields')
    assert.equal(buildDeliveryCorrection(restored.issues, node), buildDeliveryCorrection(parsed.issues, node))
    const legacy = nodeDeliveryProgressSchema.parse({ validationAttempts: 21, issues: [{ code: 'INVALID_SUBMISSION', message: 'Old checkpoint diagnostic' }], finalFiles: [] })
    const prompt = buildDeliveryCorrection(legacy.issues, node)
    assert.match(prompt, /Old checkpoint diagnostic/)
    assert.doesNotMatch(prompt, /字段、节点 ID、交付清单和实际文件检查尚未执行|字段检查未通过/)
  })
  it('bounds persisted diagnostics for large malformed submissions without accepting them', () => {
    const invalid = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`extra-${index}-${'x'.repeat(100)}`, 'private']))
    const result = parseDeliverySubmission(node, JSON.stringify({ ...submission, finalDeliverables: Array.from({ length: 32 }, () => invalid) }))
    assert.ok(!result.ok)
    assert.ok(result.issues.length <= 128)
    assert.ok(result.issues.every(issue => issue.message.length <= 2000))
    assert.ok(nodeDeliveryProgressSchema.safeParse({ validationAttempts: 1, issues: result.issues, finalFiles: [] }).success)
  })
  it('renders only required media mappings and does not invent or select an asset ID', () => {
    const mediaNode = { ...node, deliverables: [{ ...node.deliverables![0]!, artifact: { kind: 'video' as const, source: 'media-output' as const } }] }
    const result = parseDeliverySubmission(mediaNode, 'not JSON')
    assert.ok(!result.ok)
    const prompt = buildDeliveryCorrection(result.issues, mediaNode)
    assert.match(prompt, /"deliverableId": "report"/)
    assert.match(prompt, /MEDIA_ARTIFACT_ID/)
    assert.match(prompt, /不得照抄/)
    assert.doesNotMatch(prompt, /vout_|asset_/)
  })
  it('accepts only the complete final manifest for this node', () => {
    assert.deepEqual(parseDeliverySubmission(node, JSON.stringify(submission)), { ok: true, submission })
  })
  it('accepts a planned media asset mapping and rejects unplanned or duplicate mappings', () => {
    const mediaNode: ArrangementNode = {
      ...node,
      deliverables: [{
        ...node.deliverables![0]!, format: 'mp4', path: 'deliverables/video.mp4',
        artifact: { kind: 'video', source: 'media-output', operation: 'text-to-video' },
      }],
    }
    const mediaSubmission = {
      ...submission,
      finalDeliverables: [{ id: 'report', path: 'deliverables/video.mp4' }],
      mediaDeliverables: [{ deliverableId: 'report', artifactId: 'vout_0123456789abcdef' }],
    }
    assert.deepEqual(parseDeliverySubmission(mediaNode, JSON.stringify(mediaSubmission)), { ok: true, submission: mediaSubmission })
    assert.equal(parseDeliverySubmission(mediaNode, JSON.stringify({
      ...mediaSubmission, mediaDeliverables: [{ deliverableId: 'unknown', artifactId: 'vout_0123456789abcdef' }],
    })).ok, false)
    assert.equal(parseDeliverySubmission(mediaNode, JSON.stringify({
      ...mediaSubmission, mediaDeliverables: [...mediaSubmission.mediaDeliverables, ...mediaSubmission.mediaDeliverables],
    })).ok, false)
    assert.equal(parseDeliverySubmission(mediaNode, JSON.stringify({
      ...mediaSubmission, mediaDeliverables: [],
    })).ok, false)
  })
  it('keeps old delivery snapshots readable and accepts an optional media source reference', () => {
    const file = { id: 'poster', path: 'deliverables/poster.png', format: 'png', size: 120, sha256: 'a'.repeat(64), nodeRunId: 'run-1', validatedAt: 10 }
    assert.equal(finalDeliveryFileSchema.safeParse(file).success, true)
    assert.equal(finalDeliveryFileSchema.safeParse({
      ...file, sourceArtifact: { kind: 'image', artifactId: 'asset_abc-123', sha256: file.sha256 },
    }).success, true)
    assert.equal(finalDeliveryFileSchema.safeParse({
      ...file, sourceArtifact: { kind: 'image', artifactId: 'asset_abc-123', sha256: 'b'.repeat(64) },
    }).success, false)
    assert.equal(finalDeliveryFileSchema.safeParse({
      ...file, sourceArtifact: { kind: 'image', artifactId: 'asset_abc-123', sha256: file.sha256 },
      snapshot: { sha256: 'b'.repeat(64), size: file.size, source: 'workspace-recovery' },
    }).success, false)
  })
  it('rebuilds complete media mappings from validated delivery records when resuming', () => {
    const mediaNode: ArrangementNode = {
      ...node,
      deliverables: [{ ...node.deliverables![0]!, format: 'png', path: 'deliverables/poster.png', artifact: { kind: 'image', source: 'media-output' } }],
    }
    const file = {
      id: 'report', path: 'deliverables/poster.png', format: 'png', size: 120, sha256: 'a'.repeat(64), nodeRunId: 'run-1', validatedAt: 10,
      sourceArtifact: { kind: 'image' as const, artifactId: 'asset_abc-123', sha256: 'a'.repeat(64) },
    }
    const restored = parseRecordedDeliverySubmission(mediaNode, [file], 'Ready')
    assert.ok(restored.ok)
    assert.deepEqual(restored.submission.mediaDeliverables, [{ deliverableId: 'report', artifactId: 'asset_abc-123' }])
    assert.equal(parseRecordedDeliverySubmission(mediaNode, [{ ...file, sourceArtifact: undefined }]).ok, false)
    assert.equal(parseRecordedDeliverySubmission(mediaNode, [{ ...file, sourceArtifact: { ...file.sourceArtifact, kind: 'video' } }]).ok, false)
    assert.equal(parseRecordedDeliverySubmission(mediaNode, [{ ...file, sourceArtifact: { ...file.sourceArtifact, sha256: 'b'.repeat(64) } }]).ok, false)
    assert.equal(parseRecordedDeliverySubmission(node, [{ ...file, path: 'deliverables/report.txt', format: 'txt', sourceArtifact: undefined }]).ok, true)
  })
  it('rejects prose, fences, missing files, extra process files, duplicate ids and wrong paths', () => {
    const invalid = ['done', '', '```json\n'+JSON.stringify(submission)+'\n```',
      JSON.stringify({ ...submission, nodeId: 'other' }),
      JSON.stringify({ ...submission, finalDeliverables: [] }),
      JSON.stringify({ ...submission, finalDeliverables: [...submission.finalDeliverables, { id: 'temp', path: 'temp.txt' }] }),
      JSON.stringify({ ...submission, finalDeliverables: [...submission.finalDeliverables, ...submission.finalDeliverables] }),
      JSON.stringify({ ...submission, finalDeliverables: [{ id: 'report', path: '../report.txt' }] }),
    ]
    for (const text of invalid) assert.equal(parseDeliverySubmission(node, text).ok, false, text)
  })
  it('does not accept truncated output or old nodes without a delivery contract', () => {
    assert.equal(parseDeliverySubmission(node, JSON.stringify(submission), 'length').ok, false)
    assert.equal(parseDeliverySubmission({ ...node, deliverables: undefined }, JSON.stringify(submission)).ok, false)
  })
  it('rejects canonically equivalent final paths across nodes', () => {
    const first = { ...node, deliverables: [{ ...node.deliverables![0]!, path: 'deliverables/Café.txt' }] }
    const second = { ...node, id: 'second', deliverables: [{ ...node.deliverables![0]!, path: 'deliverables/Cafe\u0301.txt' }] }
    assert.ok(deliveryPlanIssues([first, second]).some(issue => issue.code === 'DUPLICATE_DELIVERY'))
  })
  it('rejects Windows path aliases, duplicate final paths and missing required files', () => {
    for (const path of ['deliverables./report.txt', 'deliverables /report.txt', 'CON/report.txt']) {
      assert.ok(deliveryPlanIssues([{ ...node, deliverables: [{ ...node.deliverables![0]!, path }] }]).length > 0, path)
    }
    assert.ok(deliveryPlanIssues([node, { ...node, id: 'second', deliverables: [{ ...node.deliverables![0]!, path: 'DELIVERABLES\\REPORT.txt' }] }]).length > 0)
    const missing = parseDeliverySubmission({ ...node, deliverables: [...node.deliverables!, { ...node.deliverables![0]!, id: 'data', path: 'deliverables/data.txt' }] }, JSON.stringify(submission))
    assert.ok(!missing.ok)
    assert.equal(missing.issues[0]?.code, 'MISSING_DELIVERY')
    assert.equal(parseDeliverySubmission(node, JSON.stringify(submission), 'toolUse').ok, false)
    assert.equal(parseDeliverySubmission(node, ' '.repeat(128_001)).ok, false)
  })
  it('reports unsupported media delivery choices before execution', () => {
    const workspaceMedia = { ...node, deliverables: [{ ...node.deliverables![0]!, format: 'png', path: 'deliverables/poster.png', artifact: { kind: 'image' as const, source: 'workspace' as const } }] }
    assert.equal(deliveryPlanIssues([workspaceMedia]).find(issue => issue.code === 'WORKSPACE_MEDIA_UNSUPPORTED')?.deliverableId, 'report')
    const jpgMedia = { ...node, deliverables: [{ ...node.deliverables![0]!, format: 'jpg', path: 'deliverables/poster.jpg', artifact: { kind: 'image' as const, source: 'media-output' as const } }] }
    assert.equal(deliveryPlanIssues([jpgMedia]).find(issue => issue.code === 'MEDIA_FORMAT_UNSUPPORTED')?.deliverableId, 'report')
    const eitherPng = { ...node, deliverables: [{ ...node.deliverables![0]!, format: 'png', path: 'deliverables/poster.png', artifact: { kind: 'image' as const, source: 'either' as const } }] }
    assert.equal(deliveryPlanIssues([eitherPng]).some(issue => issue.code === 'MEDIA_FORMAT_UNSUPPORTED'), false)
  })
})
