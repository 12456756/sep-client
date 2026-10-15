import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { deliveryPlanIssues, parseDeliverySubmission } from './arrangement-delivery'
import type { ArrangementNode } from './arrangement-plan'

const node: ArrangementNode = {
  id: 'research', subscriptionId: 'employee', modelId: 'model', title: 'Research', objective: 'Find opportunities',
  instruction: 'Research', expectedOutput: 'Report', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
  deliverables: [{ id: 'report', name: 'Report', format: 'txt', path: 'deliverables/report.txt', contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }],
}
const submission = { nodeId: node.id, summary: 'Research complete', finalDeliverables: [{ id: 'report', path: 'deliverables/report.txt' }] }

describe('node final delivery protocol', () => {
  it('accepts only the complete final manifest for this node', () => {
    assert.deepEqual(parseDeliverySubmission(node, JSON.stringify(submission)), { ok: true, submission })
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
