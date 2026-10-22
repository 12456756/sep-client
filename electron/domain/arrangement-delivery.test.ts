import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildDeliveryCorrection, deliveryPlanIssues, finalDeliveryFileSchema, parseDeliverySubmission, parseRecordedDeliverySubmission } from './arrangement-delivery'
import type { ArrangementNode } from './arrangement-plan'

const node: ArrangementNode = {
  id: 'research', subscriptionId: 'employee', modelId: 'model', title: 'Research', objective: 'Find opportunities',
  instruction: 'Research', expectedOutput: 'Report', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
  deliverables: [{ id: 'report', name: 'Report', format: 'txt', path: 'deliverables/report.txt', contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }],
}
const submission = { nodeId: node.id, summary: 'Research complete', finalDeliverables: [{ id: 'report', path: 'deliverables/report.txt' }] }

describe('node final delivery protocol', () => {
  it('carries prior validation issues into a new manual retry without reporting a zeroth failure', () => {
    const issues = [{ code: 'INVALID_SUBMISSION', message: 'invalid JSON' }]
    const prompt = buildDeliveryCorrection(0, issues)
    assert.match(prompt, /上次执行/)
    assert.match(prompt, /INVALID_SUBMISSION/)
    assert.doesNotMatch(prompt, /第 0 次/)
    assert.match(buildDeliveryCorrection(1, issues), /第 1 次交付校验失败/)
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
})
