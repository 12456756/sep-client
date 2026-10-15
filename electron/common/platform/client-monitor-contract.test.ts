import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { clientTaskEventSchema, contentManifestSchema, normalizeMonitorStatus, normalizeMonitorParticipation } from './client-monitor-contract'

const occurredAt = '2026-10-10T00:00:00.000Z'
const manifest = { version: 1, messageId: 'stable_message-1', type: 'model_output', chunks: 2147483647, source: 'canonical', completeness: 'unverified', legacySequences: [2147483647] }

it('enforces bounded version 1 metadata and explicit run identity', () => {
  assert.equal(contentManifestSchema.safeParse(manifest).success, true)
  for (const patch of [{ version: 2 }, { chunks: 2147483648 }, { legacySequences: [2147483648] }, { legacySequences: [1, 1] }, { messageId: 'bad:id' }, { messageId: 'x'.repeat(101) }, { unknown: true }]) {
    assert.equal(contentManifestSchema.safeParse({ ...manifest, ...patch }).success, false)
  }
  const event = { clientRunId: 'run', sequence: 2147483647, type: 'content_manifest', occurredAt, message: JSON.stringify(manifest) }
  assert.equal(clientTaskEventSchema.safeParse(event).success, true)
  for (const patch of [{ clientRunId: undefined }, { sequence: 2147483648 }, { message: 'x'.repeat(1001) }, { message: '{broken' }]) {
    assert.equal(clientTaskEventSchema.safeParse({ ...event, ...patch }).success, false)
  }
  assert.equal(clientTaskEventSchema.safeParse({ ...event, type: 'toString', message: 'ordinary legacy event' }).success, true)
})

it('keeps INTERRUPTED distinct and clears completion timestamps only for nonterminal states', () => {
  for (const status of ['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'INTERRUPTED'] as const) {
    assert.deepEqual(normalizeMonitorStatus({ status, completedAt: occurredAt }), { status, completedAt: null })
    assert.deepEqual(normalizeMonitorParticipation({ executionId: 'run', subscriptionId: 'sub', status, completedAt: occurredAt }), { executionId: 'run', subscriptionId: 'sub', status })
  }
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) assert.equal(normalizeMonitorStatus({ status, completedAt: occurredAt }).completedAt, occurredAt)
})
