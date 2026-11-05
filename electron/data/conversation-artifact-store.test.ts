import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationArtifactStore } from './conversation-artifact-store'

test('prepares a task-scoped artifact directory and scans ordinary files recursively', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-conversation-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ConversationArtifactStore()

  const prepared = await store.prepare(workspace, 'task-123')
  assert.deepEqual(prepared, { status: 'ready', relativePath: '成果/task-123' })
  assert.deepEqual(await store.prepare(workspace, 'task-123'), prepared)
  assert.ok((await lstat(join(workspace, '成果', 'task-123'))).isDirectory())

  await writeFile(join(workspace, '成果', 'task-123', 'report.md'), '# Report')
  await mkdir(join(workspace, '成果', 'task-123', 'appendix'))
  await writeFile(join(workspace, '成果', 'task-123', 'appendix', 'table.csv'), 'a,b')
  await writeFile(join(workspace, '成果', 'task-123', 'unfinished.tmp'), 'partial')
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'private.md'), 'private')
  await symlink(outside, join(workspace, '成果', 'task-123', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await store.scan(workspace, 'task-123'), [
    '成果/task-123/appendix/table.csv',
    '成果/task-123/report.md',
  ])
})

test('refuses a成果 directory symlink and never scans files outside the workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-conversation-artifacts-link-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(workspace), mkdir(outside)])
  await writeFile(join(outside, 'private.md'), 'private')
  await symlink(outside, join(workspace, '成果'), process.platform === 'win32' ? 'junction' : 'dir')
  const store = new ConversationArtifactStore()

  assert.deepEqual(await store.prepare(workspace, 'task-123'), { status: 'unsafe', relativePath: '成果/task-123' })
  await assert.rejects(store.scan(workspace, 'task-123'), /UNSAFE_PATH/)
  assert.equal(await readFile(join(outside, 'private.md'), 'utf8'), 'private')
})
