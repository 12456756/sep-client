import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduledTaskStore } from './scheduled-task-store'
import type { ScheduledDefinition } from '../../src/shared/scheduled-tasks'

test('pause metadata survives persistence while legacy definitions remain readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sep-scheduled-pause-'))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const store = new ScheduledTaskStore(dir)
  const definition: ScheduledDefinition = { id: 'schedule', revision: 1, enabled: false, deleted: false, nextRunAt: null, plan: null, planInputKey: null, createdAt: 1, updatedAt: 1,
    input: { name: 'Report', goal: 'Produce report', subscriptionId: 'sub', modelId: 'model', workDir: dir, timezone: 'UTC', scheduledAt: 2000, permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } } }
  try {
    await store.update(scope, data => { data.definitions.push(definition) })
    assert.equal((await store.read(scope)).definitions[0].pausedAt, undefined)
    await store.update(scope, data => { data.definitions[0].pausedAt = 1000 })
    assert.equal((await store.read(scope)).definitions[0].pausedAt, 1000)
    assert.equal((await store.read(scope)).definitions.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('scheduled store serializes mutations and does not hide a corrupt primary behind a backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sep-scheduled-'))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const store = new ScheduledTaskStore(dir)
  try {
    assert.deepEqual(await store.read(scope), { definitions: [], occurrences: [] })
    await store.update(scope, () => undefined)
    await store.update(scope, () => undefined)
    await writeFile(store.file(scope), 'broken')
    await assert.rejects(store.read(scope), /定时任务记录无法读取/)
    await assert.rejects(store.update(scope, () => undefined))
    await rm(store.file(scope))
    await assert.rejects(store.read(scope), /定时任务记录无法读取/)
    assert.deepEqual(await store.read({ ...scope, memberId: 'other' }), { definitions: [], occurrences: [] })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('workspace must already exist, be writable and never follow a replaced execution directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sep-scheduled-dir-'))
  try {
    const store = new ScheduledTaskStore(dir)
    await assert.rejects(store.prepareWorkspace('relative-directory', 'run'))
    await assert.rejects(store.prepareWorkspace(join(dir, 'missing'), 'run'))
    assert.equal(await store.prepareWorkspace(dir, 'run'), join(dir, 'scheduled-run'))
    await assert.rejects(store.prepareWorkspace(dir, '../escape'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
