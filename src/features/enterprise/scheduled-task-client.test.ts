import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { creationAccepted, ScheduledTaskClient, scheduledDefinitionSchema } from './scheduled-task-client'
import type { ScheduledDefinition, ScheduledSnapshot } from '../../shared/scheduled-tasks'
import type { ScheduledCreation, ScheduledCreationRequest } from '../../shared/scheduled-creation'

const request: ScheduledCreationRequest = { requestId: '11111111-1111-4111-8111-111111111111', message: 'Every day make a report', modelId: 'model', workDir: 'D:/reports', timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
const creation = (revision = 1, stage: ScheduledCreation['stage'] = 'parsing'): ScheduledCreation => ({
  id: request.requestId, revision, stage, request: { message: request.message, modelId: request.modelId, workDir: request.workDir, timezone: request.timezone, permissions: request.permissions },
  submissionKey: 'key', parsedSubmissionKey: null, definitionSubmissionKey: null, referenceNow: 1, messages: [{ role: 'user', content: request.message }], interpretation: null, definitionId: null, definitionInput: null, error: null, createdAt: 1, updatedAt: revision,
})

const snapshot: ScheduledSnapshot = { definitions: [], occurrences: [], schedulerState: 'running' }
test('automatic arrangement snapshots retain their kind and node dependencies at the renderer boundary', () => {
  const definition = { id: 'auto', revision: 1, enabled: false, deleted: false, nextRunAt: null, planInputKey: 'key', createdAt: 1, updatedAt: 1,
    input: { mode: 'auto', name: 'Report', goal: 'Research', subscriptionId: 'sub', modelId: 'model', workDir: 'D:/reports', scheduledAt: 2000, timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } },
    plan: { status: 'ready', kind: 'arrangement', title: 'Research', intentAnalysis: null, nodes: [{ id: 'research', subscriptionId: 'sub', modelId: 'model', title: 'Research', instruction: 'Produce file', expectedOutput: 'File', dependsOn: [], skillIds: [], requiresUserConfirmation: false, deliverables: [{ id: 'file', name: 'File', format: 'md', path: 'file.md', contentOutline: ['Summary'], acceptanceCriteria: ['Sources'] }] }] } }
  assert.deepEqual(scheduledDefinitionSchema.parse(definition).plan, definition.plan)
  assert.equal(scheduledDefinitionSchema.parse({ ...definition, pausedAt: 12 }).pausedAt, 12)
})
test('command success survives a subsequent refresh failure and keeps the created ID', async () => {
  const client = new ScheduledTaskClient(async () => { throw new Error('private transport error') })
  const result = await client.command(async () => ({ success: true, data: { id: 'saved-id' } }))
  assert.equal(result?.data?.id, 'saved-id')
  assert.equal(client.getSnapshot().error, '无法刷新定时任务，请重新加载。')
  assert.equal(client.getSnapshot().busy, false)
})
test('late pre-command list responses cannot overwrite newer state', async () => {
  let finish!: (value: { success: true; data: ScheduledSnapshot }) => void
  let reads = 0
  const client = new ScheduledTaskClient(() => ++reads === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ success: true, data: snapshot }))
  const old = client.refresh()
  await client.command(async () => ({ success: true }))
  finish({ success: true, data: { ...snapshot, schedulerState: 'stopped' } })
  await old
  assert.equal(client.getSnapshot().data?.schedulerState, 'running')
})
test('commands are serialized and malformed list snapshots fail closed', async () => {
  let finish!: () => void
  const client = new ScheduledTaskClient(async () => ({ success: true, data: { definitions: 'invalid' } as unknown as ScheduledSnapshot }))
  let calls = 0
  const first = client.command(async () => { calls++; await new Promise<void>(resolve => { finish = resolve }); return { success: true } })
  assert.equal(await client.command(async () => { calls++; return { success: true } }), null)
  finish(); await first
  assert.equal(calls, 1)
  assert.equal(client.getSnapshot().data, null)
  assert.ok(client.getSnapshot().error)
})
test('disposing a client ignores outstanding reads and never notifies subscribers', async () => {
  let finish!: (value: { success: true; data: ScheduledSnapshot }) => void
  const client = new ScheduledTaskClient(() => new Promise(resolve => { finish = resolve }))
  let notifications = 0
  client.subscribe(() => notifications++)
  const read = client.refresh()
  client.dispose()
  const before = notifications
  finish({ success: true, data: snapshot }); await read
  assert.equal(notifications, before)
  assert.equal(client.getSnapshot().data, null)
})

test('a persisted definition stays visible if its follow-up read fails', async () => {
  let reads = 0
  const client = new ScheduledTaskClient(async () => { if (++reads > 1) throw Error('offline'); return { success: true, data: snapshot } })
  await client.refresh()
  const saved = { id: 'persisted', revision: 1 } as ScheduledDefinition
  await client.command(async () => { client.acceptDefinition(saved); return { success: true, data: saved } })
  assert.equal(client.getSnapshot().data?.definitions[0].id, 'persisted')
  assert.ok(client.getSnapshot().error)
})

test('polling does not hide command failures, and unexpected transport messages stay private', async () => {
  const client = new ScheduledTaskClient(async () => ({ success: true, data: snapshot }))
  await client.command(async () => ({ success: false, error: { message: '配置已变化，请刷新。' } }))
  await client.refresh()
  assert.equal(client.getSnapshot().error, '配置已变化，请刷新。')
  await client.refresh(true)
  assert.equal(client.getSnapshot().error, null)
  await client.command(async () => { throw Error('private credentials') })
  assert.ok(client.getSnapshot().error)
  assert.doesNotMatch(client.getSnapshot().error!, /private credentials/)
})

test('creation progress polls while a command is waiting and ignores a late lower revision reply', async () => {
  let finish!: (value: { success: true; data: ScheduledCreation }) => void
  const client = new ScheduledTaskClient(async () => ({ success: true, data: { ...snapshot, creations: [creation(3, 'cancelled')] } }))
  const sending = client.submitCreation(request, () => new Promise(resolve => { finish = resolve }))
  await client.refresh()
  assert.equal(client.getSnapshot().data?.creations?.[0].stage, 'cancelled')
  finish({ success: true, data: creation(1) }); await sending
  assert.equal(client.getSnapshot().data?.creations?.[0].revision, 3)
  assert.equal(client.getSnapshot().data?.creations?.[0].stage, 'cancelled')
})

test('ordinary commands do not suppress progress polling', async () => {
  let finish!: () => void
  let reads = 0
  const client = new ScheduledTaskClient(async () => { reads++; return { success: true, data: snapshot } })
  const command = client.command(async () => { await new Promise<void>(resolve => { finish = resolve }); return { success: true } })
  await client.refresh()
  assert.equal(reads, 1)
  finish(); await command
})

test('lost submission responses retain the exact request for retry without leaking transport errors', async () => {
  const client = new ScheduledTaskClient(async () => ({ success: true, data: snapshot }))
  await client.submitCreation(request, async () => { throw Error('secret') })
  assert.deepEqual(client.getSnapshot().pendingCreations[0].request, request)
  assert.doesNotMatch(client.getSnapshot().pendingCreations[0].error!, /secret/)
  let received: ScheduledCreationRequest | undefined
  await client.submitCreation(request, async value => { received = value; return { success: true, data: creation(2, 'needs_input') } })
  assert.deepEqual(received, request)
  assert.equal(client.getSnapshot().pendingCreations.length, 0)
})

test('polling resolves an accepted request after its response is lost, but not an older clarification', async () => {
  let current = creation(2, 'needs_input')
  const client = new ScheduledTaskClient(async () => ({ success: true, data: { ...snapshot, creations: [current] } }))
  const reply = { ...request, expectedRevision: 2, message: 'At nine in the morning' }
  await client.submitCreation(reply, async () => { throw Error('lost') })
  await client.refresh()
  assert.equal(client.getSnapshot().pendingCreations.length, 1)
  current = { ...creation(3, 'planning'), messages: [...current.messages, { role: 'user', content: reply.message }] }
  await client.refresh()
  assert.equal(client.getSnapshot().pendingCreations.length, 0)
})

test('creation acceptance survives stale list snapshots and invalid creation payloads fail closed', async () => {
  const client = new ScheduledTaskClient(async () => ({ success: true, data: snapshot }))
  client.acceptCreation(creation(4, 'completed'))
  await client.refresh()
  assert.equal(client.getSnapshot().data?.creations?.[0].stage, 'completed')
  await client.submitCreation({ ...request, requestId: '22222222-2222-4222-8222-222222222222' }, async () => ({ success: true, data: { id: request.requestId } as ScheduledCreation }))
  assert.ok(client.getSnapshot().pendingCreations[0].error)
  assert.equal(client.getSnapshot().data?.creations?.[0].revision, 4)
})

test('a matching message cannot resolve a settings-only change against an old record', () => {
  const current = creation(3, 'failed')
  assert.equal(creationAccepted(current, request), true)
  for (const changed of [
    { ...request, modelId: 'other' }, { ...request, workDir: 'D:/private' }, { ...request, timezone: 'Asia/Shanghai' },
    { ...request, permissions: { ...request.permissions, preset: 'full-local' as const } },
    { ...request, permissions: { ...request.permissions, approvalMode: 'auto-approve' as const } },
  ]) assert.equal(creationAccepted(current, changed), false)
})

test('persisted cancellation wins over a late submit reply and a late submit failure', async () => {
  for (const failure of [true, false]) {
    let finish!: (value: { success: boolean; data?: ScheduledCreation; error?: { message: string } }) => void
    const client = new ScheduledTaskClient(async () => ({ success: true, data: snapshot }))
    const sending = client.submitCreation(request, () => new Promise(resolve => { finish = resolve }))
    client.acceptCreation(creation(1))
    await client.cancelCreation(creation(1), async () => ({ success: true, data: creation(2, 'cancelled') }))
    finish(failure ? { success: false, error: { message: 'late failure' } } : { success: true, data: creation(1) })
    await sending
    assert.equal(client.getSnapshot().data?.creations?.[0].stage, 'cancelled')
    assert.equal(client.getSnapshot().pendingCreations.length, 0)
  }
})

test('an accepted failed creation clears transient retry state and remains durably visible', async () => {
  const retained = new Map()
  const client = new ScheduledTaskClient(async () => ({ success: true, data: { ...snapshot, creations: [creation(2, 'failed')] } }), retained)
  await client.submitCreation(request, async () => { throw Error('lost') })
  await client.refresh()
  assert.equal(client.getSnapshot().pendingCreations.length, 0)
  assert.equal(retained.size, 0)
  assert.equal(client.getSnapshot().data?.creations?.[0].stage, 'failed')
})
