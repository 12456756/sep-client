import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArrangementProgressStore } from './arrangement-progress-store'
import type { PlanningProgressSnapshot } from '../../src/shared/auto-planning'

const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const snapshot = (sequence: number): PlanningProgressSnapshot => ({
  owner, draftId: 'draft-a', planningId: 'planning-a', modelId: 'model', sequence, events: [{
    owner, draftId: 'draft-a', planningId: 'planning-a', draftRevision: 2, sequence, occurredAt: sequence,
    type: 'arrangement_plan_ready', data: { planSummary: 'Latest plan', planSteps: [{ id: 'step-a', title: 'Research' }] },
  }],
})

test('planning progress survives reopening, stays scoped, and cannot be restored after deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-planning-progress-'))
  try {
    const store = new ArrangementProgressStore(root)
    await Promise.all([store.save(owner, snapshot(1)), store.save(owner, snapshot(2))])
    assert.deepEqual(await new ArrangementProgressStore(root).get(owner, 'draft-a'), snapshot(2))
    const other = { ...owner, memberId: 'other' }
    assert.equal(await store.get(other, 'draft-a'), null)
    await assert.rejects(store.save(other, snapshot(3)), /owner mismatch/)
    await Promise.all([store.save(owner, snapshot(3)), store.delete(owner, 'draft-a')])
    assert.equal(await store.get(owner, 'draft-a'), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
