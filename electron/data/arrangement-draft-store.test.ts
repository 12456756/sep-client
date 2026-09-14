import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArrangementDraftStore } from './arrangement-draft-store'
import type { ArrangementDraft } from '../domain/arrangement-plan'

const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const roots: string[] = []

after(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function draftInput(): Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    schemaVersion: 1,
    mode: 'manual',
    status: 'editing',
    title: 'Report',
    goal: 'Build a report',
    confirmedInputs: [],
    sharedSkillIds: [],
    conversation: null,
    nodes: [{
      id: 'node-a', subscriptionId: 'sub-a', modelId: 'model-a', title: 'Collect',
      instruction: 'Collect data', expectedOutput: 'Data', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
    }],
    workspace: { mode: 'shared', path: null },
    permissions: { preset: 'read-only' },
    lastPlanning: null,
  }
}

describe('ArrangementDraftStore', () => {
  it('persists drafts by authenticated scope and keeps them after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-drafts-'))
    roots.push(root)
    const store = new ArrangementDraftStore(root)
    const created = await store.create(scope, draftInput())
    const reopened = new ArrangementDraftStore(root)
    const loaded = await reopened.get(scope, created.id)
    assert.equal(loaded?.title, 'Report')
    assert.equal((await reopened.list(scope)).length, 1)
    assert.equal(await reopened.get({ memberId: 'other', enterpriseId: scope.enterpriseId }, created.id), null)
  })

  it('increments revisions and rejects stale updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-revision-'))
    roots.push(root)
    const store = new ArrangementDraftStore(root)
    const created = await store.create(scope, draftInput())
    const updated = await store.update(scope, created.id, 1, { ...draftInput(), title: 'Updated' })
    assert.equal(updated.revision, 2)
    await assert.rejects(() => store.update(scope, created.id, 1, { ...draftInput(), title: 'Stale' }))
  })

  it('deletes only when explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-delete-'))
    roots.push(root)
    const store = new ArrangementDraftStore(root)
    const created = await store.create(scope, draftInput())
    assert.equal(await store.delete(scope, created.id), true)
    assert.equal(await store.delete(scope, created.id), false)
  })
})

