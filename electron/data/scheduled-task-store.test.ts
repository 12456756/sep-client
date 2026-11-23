import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduledTaskStore } from './scheduled-task-store'
import { createScheduledEmptyText } from './arrangement-delivery-files'
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
    await assert.rejects(store.prepareWorkspace(join(dir, 'missing'), 'run'), { code: 'ENOENT' })
    assert.equal(await store.prepareWorkspace(dir, 'run'), await realpath(join(dir, 'scheduled-run')))
    await assert.rejects(store.prepareWorkspace(dir, '../escape'))
    const other = join(dir, 'other')
    await mkdir(other)
    await symlink(other, join(dir, 'scheduled-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(store.prepareWorkspace(dir, 'link'), { code: 'WORKSPACE_INVALID' })
    await writeFile(join(dir, 'scheduled-file'), '')
    await assert.rejects(store.prepareWorkspace(dir, 'file'), { code: 'WORKSPACE_INVALID' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('uses the real spelling of a Windows execution directory for empty-text runs', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sep-scheduled-case-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const actual = join(dir, 'Scheduled-Run')
  await mkdir(actual)
  const workspace = await new ScheduledTaskStore(dir).prepareWorkspace(dir, 'run')
  assert.equal(workspace, await realpath(actual))
  await createScheduledEmptyText(workspace, 'run', 'empty.txt', () => undefined)
  assert.equal((await readFile(join(actual, 'empty.txt'))).length, 0)
  await assert.rejects(createScheduledEmptyText(workspace, 'other', 'empty.txt', () => undefined), { code: 'WORKSPACE_INVALID' })
})
