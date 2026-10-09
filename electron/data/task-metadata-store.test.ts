import { afterEach, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskMetadataStore } from './task-metadata-store'
import { ScopePath } from './scope-path'

const roots: string[] = []
const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('diagnoses metadata with backup and scope isolation without changing load semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-metadata-diagnostic-'))
  roots.push(root)
  const store = new TaskMetadataStore(root)
  const value = { version: 1 as const, taskId: 'task-a', kind: 'arrangement' as const, participantSubscriptionIds: [], currentSubscriptionId: null, createdAt: 1 }
  await store.save(scope, value)
  await store.save(scope, { ...value, kind: 'conversation' })
  const file = new ScopePath(root).metadataFile(scope, value.taskId)
  await writeFile(file, 'broken')
  assert.deepEqual(await store.diagnose(scope, value.taskId), { state: 'found', value })
  assert.deepEqual(await store.diagnose({ ...scope, memberId: 'other' }, value.taskId), { state: 'missing' })
  assert.equal((await store.load(scope, value.taskId))?.kind, 'arrangement')
  await rm(`${file}.bak`)
  await writeFile(file, JSON.stringify({ ...value, taskId: 'wrong' }))
  assert.deepEqual(await store.diagnose(scope, value.taskId), { state: 'unavailable' })
  assert.deepEqual(await store.diagnose(scope, value.taskId), { state: 'unavailable' })
})
