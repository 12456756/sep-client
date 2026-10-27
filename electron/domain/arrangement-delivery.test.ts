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
const fileCorrection = '你的提交格式已通过校验，但实际交付文件未通过校验，当前节点尚未完成。请检查规定的交付文件是否已经保存、能够正常读取、内容非空，并且符合要求的文件格式和保存位置。\n\n修复存在问题的文件，保留其他有效成果，不要重复已完成的工作。完成保存后，按照当前节点要求重新提交完整结果，包含全部规定交付文件，不要只提交修复的部分，也不要只回复“已修复”。'

describe('node final delivery protocol', () => {
  it('retains validation counts beyond five without imposing a correction limit', () => {
    assert.equal(nodeDeliveryProgressSchema.parse({ validationAttempts: 20, issues: [], finalFiles: [] }).validationAttempts, 20)
    assert.doesNotMatch(buildDeliveryCorrection([{ code: 'FILE_MISSING', message: 'missing' }]), /最多|上限|停止自动修正/)
  })
  it('uses the exact submission correction for every existing submission validation failure', () => {
    for (const code of ['MISSING_DELIVERY_CONTRACT', 'OUTPUT_TRUNCATED', 'NODE_NOT_SETTLED', 'INVALID_SUBMISSION', 'WRONG_NODE', 'DELIVERY_MANIFEST_MISMATCH', 'MISSING_DELIVERY', 'DUPLICATE_MEDIA_DELIVERY', 'MEDIA_DELIVERY_MANIFEST_MISMATCH', 'MISSING_MEDIA_DELIVERY']) {
      assert.equal(buildDeliveryCorrection([{ code, message: 'Stored diagnostic, not prompt text' }]), submissionCorrection, code)
    }
  })
  it('uses the exact file correction for existing file validation failures without appending diagnostics', () => {
    for (const code of ['FILE_MISSING', 'UNSAFE_PATH', 'NOT_A_FILE', 'EMPTY_FILE', 'FILE_TOO_LARGE', 'FILE_CHANGED', 'INVALID_FORMAT', 'SNAPSHOT_CHANGED', 'SNAPSHOT_UNAVAILABLE']) {
      assert.equal(buildDeliveryCorrection([{ code, message: 'Stored diagnostic, not prompt text', deliverableId: 'report', path: 'deliverables/report.txt' }]), fileCorrection, code)
    }
  })
  it('classifies actual parser errors as submission failures', () => {
    for (const text of ['', JSON.stringify({ ...submission, nodeId: 'other' }), JSON.stringify({ ...submission, finalDeliverables: [{ id: 'other', path: 'other.txt' }] })]) {
      const result = parseDeliverySubmission(node, text)
      assert.ok(!result.ok)
      assert.equal(buildDeliveryCorrection(result.issues), submissionCorrection)
    }
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
