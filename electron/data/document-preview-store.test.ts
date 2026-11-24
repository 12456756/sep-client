import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DocumentPreviewStore } from './document-preview-store'
import { WorkPlanStore } from './work-plan-store'
import { ArrangementCheckpointStore, type ArrangementCheckpoint } from './arrangement-checkpoint-store'
import type { WorkPlan } from '../domain/arrangement-plan'
import type { TaskReadView } from '../../src/shared/types'

test('preview joins owner-local planned deliveries with node completion, independent of the parent task status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-preview-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const plans = new WorkPlanStore(root), checkpoints = new ArrangementCheckpointStore(root)
  const store = new DocumentPreviewStore(root, plans, checkpoints)
  const plan: WorkPlan = { id: 'task', schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1,
    owner, mode: 'auto', title: 'Report', goal: 'Report', conversation: null,
    nodes: [{ id: 'node', subscriptionId: 'sub', modelId: 'model', title: 'Report', instruction: 'Write', expectedOutput: 'Report',
      dependsOn: [], skillIds: [], requiresUserConfirmation: false,
      deliverables: [{ id: 'report', name: 'Report', path: 'report.md', format: 'md', contentOutline: ['Report'], acceptanceCriteria: ['Report'] }] }],
    workspace: { mode: 'shared', path: root }, permissions: { preset: 'workspace-edit', allowedTools: [], allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled' },
    confirmedInputs: [], planHash: 'hash', createdAt: 1 }
  const checkpoint: ArrangementCheckpoint = { version: 1, taskId: 'task', owner, planHash: 'hash', activeRunId: 'run', updatedAt: 1,
    state: { status: 'running', failureNodeIds: [], interruptionReason: null,
      nodes: [{ nodeId: 'node', status: 'completed', attempt: 1, error: null, output: null,
        delivery: { validationAttempts: 1, issues: [], finalFiles: [{ id: 'report', path: 'report.md', format: 'md', size: 5, sha256: 'a'.repeat(64), nodeRunId: 'node-run', validatedAt: 1 }] } },
      { nodeId: 'peer', status: 'running', attempt: 1, error: null, output: null }] } }
  await plans.save(owner, plan); await checkpoints.save(owner, checkpoint)
  await writeFile(join(root, 'report.md'), 'hello')
  assert.equal((await store.getDelivery(owner, 'task', 'node', 'report'))?.status, 'completed')
  assert.equal(await store.getDeliveryPath(owner, 'task', 'node', 'report'), await realpath(join(root, 'report.md')))
  assert.equal(await store.getDeliveryPath({ ...owner, memberId: 'other' }, 'task', 'node', 'report'), null)
  const node = checkpoint.state.nodes[0]
  const file = node.delivery!.finalFiles[0]
  await checkpoints.save(owner, { ...checkpoint, state: { ...checkpoint.state, nodes: [
    { ...node, delivery: { ...node.delivery!, finalFiles: [{ ...file, sourceArtifact: { kind: 'image', artifactId: 'asset', sha256: file.sha256 } }] } },
  ] } })
  assert.equal(await store.getDeliveryPath(owner, 'task', 'node', 'report'), await realpath(join(root, 'report.md')))
  await checkpoints.save(owner, checkpoint)
  assert.equal(await store.getDelivery({ ...owner, memberId: 'other' }, 'task', 'node', 'report'), null)
  assert.equal(await store.getDelivery(owner, 'task', 'peer', 'report'), null)
  assert.equal(await store.getDelivery(owner, 'task', 'node', 'forged'), null)
  await checkpoints.save(owner, { ...checkpoint, planHash: 'different-plan' })
  assert.equal(await store.getDelivery(owner, 'task', 'node', 'report'), null)
})

async function conversationFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sep-conv-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const path = join(workspace, 'report.MD')
  await writeFile(path, '# conversation report')
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const task: TaskReadView = { id: 'task', title: 'Report', prompt: 'Report', workDir: workspace,
    status: 'running', createdAt: 1, startedAt: 1, completedAt: null, error: null, logs: [],
    files: [path], ownerId: owner.memberId, ownerEnterpriseId: owner.enterpriseId,
    subscriptionId: 'sub', activeRunId: 'run', workType: { state: 'resolved', kind: 'conversation' } }
  const store = new DocumentPreviewStore(root, new WorkPlanStore(root), new ArrangementCheckpointStore(root))
  return { root, workspace, path, owner, task, store }
}

test('conversation previews read registered task files without requiring a DAG or completed task', async t => {
  const f = await conversationFixture(t)
  const first = await f.store.readConversation(f.owner, f.task, 'task-file-0')
  assert.ok(first)
  assert.equal(await f.store.getConversationPath(f.owner, f.task, 'task-file-0'), await realpath(f.path))
  assert.equal(first.name, 'report.MD')
  assert.equal(first.format, 'md')
  assert.equal(Buffer.from(first.bytes).toString(), '# conversation report')
  await writeFile(f.path, '# updated report')
  const second = await f.store.readConversation(f.owner, f.task, 'task-file-0')
  assert.notEqual(second?.version, first.version)
  const relative = await f.store.readConversation(f.owner, { ...f.task, files: ['report.MD'] }, 'task-file-0')
  assert.equal(relative?.version, second?.version)
})

test('external conversation preview verifies the receipt, not the name or directory alone', async t => {
  const { root, owner, store, task } = await conversationFixture(t)
  const folder = await realpath(root)
  const path = join(folder, 'external.txt')
  const bytes = Buffer.from('approved text')
  await writeFile(path, bytes)
  const info = await lstat(path, { bigint: true })
  const receipt = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), identity: `${info.dev}:${info.ino}:${info.birthtimeNs}` }
  const registered = { ...task, files: [path], externalFileReceipts: { [path]: receipt } }
  const id = 'task-file-0'
  assert.deepEqual((await store.readConversation(owner, registered, id))?.bytes, bytes)
  assert.equal(await store.getConversationPath(owner, registered, id), path)
  assert.equal(await store.readConversation({ ...owner, memberId: 'foreign' }, registered, id), null)
  await assert.rejects(store.readConversation(owner, { ...registered, externalFileReceipts: {} }, id), { reason: 'outside' })
  await writeFile(path, 'different txt')
  await assert.rejects(store.readConversation(owner, registered, id), { reason: 'changed' })
  await writeFile(path, bytes)
  await rename(path, join(folder, 'moved.txt'))
  await writeFile(path, bytes)
  await assert.rejects(store.getConversationPath(owner, registered, id), { reason: 'changed' })
})

test('conversation previews reject foreign owners, non-conversations, forged identities and workspace escapes', async t => {
  const f = await conversationFixture(t)
  for (const task of [
    { ...f.task, ownerId: 'other' }, { ...f.task, ownerEnterpriseId: 'other' },
    { ...f.task, workType: { state: 'resolved', kind: 'arrangement' } as const },
    { ...f.task, workType: { state: 'unavailable' } as const }, { ...f.task, workDir: null },
  ]) assert.equal(await f.store.readConversation(f.owner, task, 'task-file-0'), null)
  for (const id of ['task-file-1', 'other-file-0', 'task-file-00', f.path]) {
    assert.equal(await f.store.readConversation(f.owner, f.task, id), null)
  }
  const outside = join(f.root, 'private.md')
  await writeFile(outside, 'private')
  for (const path of [outside, '../private.md']) {
    await assert.rejects(f.store.readConversation(f.owner, { ...f.task, files: [path] }, 'task-file-0'))
  }
  const linked = join(f.workspace, 'linked')
  await symlink(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.store.readConversation(f.owner, { ...f.task, files: [join(linked, 'private.md')] }, 'task-file-0'))
})

test('preview and output location accept absolute paths through a workspace alias and its real path', async t => {
  const f = await conversationFixture(t)
  const alias = join(f.root, 'workspace-alias')
  await symlink(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const canonical = await realpath(f.path)
  for (const file of [join(alias, 'report.MD'), canonical, 'report.MD']) {
    const task = { ...f.task, workDir: alias, files: [file] }
    assert.equal(await f.store.getConversationPath(f.owner, task, 'task-file-0'), canonical)
    assert.equal((await f.store.readConversation(f.owner, task, 'task-file-0'))?.name, 'report.MD')
  }
})

test('preview and output location both reject a directory link even when its target stays inside the workspace', async t => {
  const f = await conversationFixture(t)
  const internal = join(f.workspace, 'internal'), linked = join(f.workspace, 'linked')
  await mkdir(internal)
  await writeFile(join(internal, 'report.md'), '# in workspace')
  await symlink(internal, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const task = { ...f.task, files: ['linked/report.md'] }
  await assert.rejects(f.store.getConversationPath(f.owner, task, 'task-file-0'), { reason: 'link' })
  await assert.rejects(f.store.readConversation(f.owner, task, 'task-file-0'), { reason: 'link' })
})

test('conversation previews reject missing, empty and oversized files without creating snapshots', async t => {
  const f = await conversationFixture(t)
  await writeFile(f.path, '')
  await assert.rejects(f.store.readConversation(f.owner, f.task, 'task-file-0'))
  await truncate(f.path, 64 * 1024 * 1024 + 1)
  await assert.rejects(f.store.readConversation(f.owner, f.task, 'task-file-0'))
  await rm(f.path)
  await assert.rejects(f.store.readConversation(f.owner, f.task, 'task-file-0'))
  assert.equal(await f.store.getDelivery(f.owner, 'task', 'node', 'report'), null)
})

test('output locations support any format without reading bytes and reject foreign or escaped files', async t => {
  const f = await conversationFixture(t)
  const archive = join(f.workspace, 'result.zip')
  await writeFile(archive, '')
  const task = { ...f.task, files: [archive] }
  assert.equal(await f.store.getConversationPath(f.owner, task, 'task-file-0'), await realpath(archive))
  assert.equal(await f.store.getConversationPath(f.owner, { ...task, files: ['result.zip'] }, 'task-file-0'), await realpath(archive))
  assert.equal(await f.store.getConversationPath(f.owner, { ...task, ownerId: 'other' }, 'task-file-0'), null)
  assert.equal(await f.store.getConversationPath(f.owner, task, 'other-file-0'), null)
  const outside = join(f.root, 'private.zip')
  await writeFile(outside, '')
  const internal = join(f.root, 'internal')
  await mkdir(internal)
  const internalFile = join(internal, 'result.zip')
  await writeFile(internalFile, '')
  const linked = join(f.workspace, 'linked')
  await symlink(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const linkedInside = join(f.workspace, 'linked-internal')
  await symlink(internal, linkedInside, process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of [outside, '../private.zip', join(linked, 'private.zip'), join(linkedInside, 'result.zip'), f.workspace]) {
    await assert.rejects(f.store.getConversationPath(f.owner, { ...task, files: [path] }, 'task-file-0'))
  }
  await rm(archive)
  await assert.rejects(f.store.getConversationPath(f.owner, task, 'task-file-0'))
})
