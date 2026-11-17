import * as assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLibraryService } from './skill-library-service'
import { SkillVersionStore } from '../data/skill-version-store'
import { SkillSubmissionStore } from '../data/skill-submission-store'
import { AuthApiError, type SkillVersion } from '../common/platform/platform-api'
import { AppError } from '../errors/app-error'

const scope = { enterpriseId: 'enterprise', memberId: 'member' }

test('concurrent library reads share one catalog load and failed loads remain retryable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-library-loading-'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  let fail = true
  const failure = new Error('offline')
  const service = new SkillLibraryService({
    scope: { currentScope: () => scope }, token: async () => 'access',
    subscriptions: async () => [{ subscriptionId: 'sub', employeeId: 'employee' }],
    versions: new SkillVersionStore(join(root, 'versions')), submissions: new SkillSubmissionStore(root),
    platform: {
      skills: async () => { calls++; await gate; if (fail) throw failure; return { subscriptionId: 'sub', skills: [] } },
      list: async () => [], preview: async () => ({ content: '' }), create: async () => { throw new Error('unused') },
    },
  })
  try {
    const first = service.listWithDiagnostics()
    const second = service.listWithDiagnostics()
    release()
    const results = await Promise.allSettled([first, second])
    assert.equal(calls, 1)
    assert.ok(results.every(result => result.status === 'rejected' && result.reason === failure))
    fail = false
    assert.deepEqual(await service.list(), [])
    assert.equal(calls, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('large libraries reuse catalog versions without per-skill queries and keep item order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-library-loading-'))
  const active = { catalogs: 0, versions: 0 }
  const peak = { catalogs: 0, versions: 0 }
  const subscriptions = Array.from({ length: 42 }, (_, index) => ({ subscriptionId: 'sub-' + index, employeeId: String(index) }))
  async function record<T>(phase: keyof typeof active, value: T): Promise<T> {
    active[phase]++
    peak[phase] = Math.max(peak[phase], active[phase])
    await new Promise(resolve => setTimeout(resolve, 1))
    active[phase]--
    return value
  }
  const version = (id: string) => ({ id: 'v-' + id, capabilityId: id, scope: 'PLATFORM', version: '1', status: 'PLATFORM_APPROVED' })
  const service = new SkillLibraryService({
    scope: { currentScope: () => scope }, token: async () => 'access', subscriptions: async () => subscriptions,
    versions: new SkillVersionStore(join(root, 'versions')), submissions: new SkillSubmissionStore(root),
    platform: {
      skills: async employeeId => record('catalogs', { subscriptionId: 'sub-' + employeeId, skills: [{
        capability: { id: employeeId, name: employeeId, description: '', type: 'SKILL' },
        currentVersion: version(employeeId), versions: [version(employeeId)],
      }] }),
      list: async input => record('versions', [version(input.capabilityId)]),
      preview: async () => ({ content: '' }), create: async () => { throw new Error('unused') },
    },
  })
  try {
    const items = await service.list()
    assert.deepEqual(items.map(item => item.capability.id), subscriptions.map(item => item.employeeId))
    assert.ok(peak.catalogs <= 4, 'catalog peak was ' + peak.catalogs)
    assert.equal(peak.versions, 0)
    assert.deepEqual(items.flatMap(item => item.usableVersionIds), subscriptions.map(item => 'v-' + item.employeeId))
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function refreshFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sep-library-refresh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = 1_000_000
  let member = scope
  let beforeCatalog: (id: string) => Promise<void> = async () => undefined
  let subscriptions = Array.from({ length: 8 }, (_, index) => ({ subscriptionId: 'sub-' + index, employeeId: String(index) }))
  const calls = { catalogs: [] as string[], versions: [] as string[], previews: [] as string[], subscriptions: 0 }
  const version = (id: string): SkillVersion => ({ id: 'v-' + id, capabilityId: id, scope: 'PLATFORM', version: '1', status: 'PLATFORM_APPROVED' })
  const personal = { ...version('cap'), id: 'personal', scope: 'PERSONAL', ownerId: scope.memberId, status: 'PENDING_ENTERPRISE_REVIEW' }
  const service = new SkillLibraryService({
    scope: { currentScope: () => member }, token: async () => 'access', now: () => now,
    subscriptions: async () => { calls.subscriptions++; return subscriptions },
    versions: new SkillVersionStore(join(root, 'versions')), submissions: new SkillSubmissionStore(root),
    platform: {
      skills: async employeeId => {
        calls.catalogs.push(employeeId)
        await beforeCatalog(employeeId)
        const id = Number(employeeId) < 2 ? 'cap' : 'cap-' + employeeId
        return { subscriptionId: 'sub-' + employeeId, skills: [{
          capability: { id, name: id, description: '', type: 'SKILL' },
          currentVersion: version(id), versions: id === 'cap' ? [version(id), personal] : [version(id)],
        }] }
      },
      list: async input => { calls.versions.push(input.capabilityId); return [version(input.capabilityId)] },
      preview: async id => { calls.previews.push(id); return { content: '# Source' } },
      create: async () => { throw new Error('unused') },
    },
  })
  return { service, calls, advance: (ms: number) => { now += ms }, time: () => now,
    before: (fn: typeof beforeCatalog) => { beforeCatalog = fn },
    unsubscribe: (id: string) => { subscriptions = subscriptions.filter(item => item.subscriptionId !== id) },
    switchUser: () => { member = { ...scope, memberId: 'other' } },
  }
}

test('main-process cache honors freshness, merges refreshes and throttles repeated manual reads', async t => {
  const f = await refreshFixture(t)
  assert.equal((await f.service.listWithDiagnostics({ mode: 'cache' })).updatedAt, undefined)
  const [first, second] = await Promise.all([f.service.listWithDiagnostics({ mode: 'auto' }), f.service.listWithDiagnostics({ mode: 'manual' })])
  assert.deepEqual(first, second)
  assert.equal(f.calls.catalogs.length, 8)
  assert.equal(first.items[0].versions.find(item => item.id === 'personal')?.status, 'PENDING_ENTERPRISE_REVIEW')
  assert.equal(first.items[0].usableVersionIds.includes('personal'), false)
  await f.service.listWithDiagnostics({ mode: 'auto' })
  assert.equal(f.calls.catalogs.length, 8)
  await f.service.listWithDiagnostics({ mode: 'manual' })
  await f.service.listWithDiagnostics({ mode: 'manual' })
  assert.equal(f.calls.catalogs.length, 16)
  f.advance(5_000)
  await f.service.listWithDiagnostics({ mode: 'manual' })
  assert.equal(f.calls.catalogs.length, 24)
  f.advance(120_000)
  assert.equal((await f.service.listWithDiagnostics({ mode: 'cache' })).items.length, 7)
  assert.equal(f.calls.catalogs.length, 24)
  await f.service.listWithDiagnostics({ mode: 'auto' })
  assert.equal(f.calls.catalogs.length, 32)
})

test('429 gates every skill read and resumes unfinished catalogs without replaying successes', async t => {
  const f = await refreshFixture(t)
  let fail = true
  f.before(async id => { if (id === '0' && fail) throw new AuthApiError({ statusCode: 429, message: 'limited', retryAfterMs: 65_000 }, 'skills') })
  await assert.rejects(f.service.listWithDiagnostics({ mode: 'manual' }), { statusCode: 429 })
  assert.equal(f.calls.catalogs.length, 4)
  assert.equal(f.service.cached().retryAt, f.time() + 65_000)
  assert.ok(f.service.cached().items.length > 0)
  const started = f.calls.subscriptions
  await assert.rejects(f.service.listWithDiagnostics({ mode: 'auto' }), { statusCode: 429 })
  await assert.rejects(f.service.listWithDiagnostics({ mode: 'manual', capabilityId: 'cap' }), { statusCode: 429 })
  assert.equal(f.calls.subscriptions, started)
  f.advance(64_999)
  await assert.rejects(f.service.listWithDiagnostics({ mode: 'manual' }), { statusCode: 429 })
  fail = false
  f.advance(1)
  const recovered = await f.service.listWithDiagnostics({ mode: 'manual' })
  assert.equal(recovered.items.length, 7)
  assert.equal(f.calls.catalogs.length, 9)
  for (const id of ['1', '2', '3']) assert.equal(f.calls.catalogs.filter(value => value === id).length, 1)
  assert.equal(f.service.cached().retryAt, undefined)
})

test('targeted selection checks live bindings, shares source reads and returns actual selections', async t => {
  const f = await refreshFixture(t)
  await f.service.list()
  f.calls.catalogs.length = 0
  const selected = await f.service.select({ capabilityId: 'cap', versionId: 'follow-platform' })
  assert.deepEqual(f.calls.catalogs.sort(), ['0', '1'])
  assert.deepEqual(f.calls.previews, ['v-cap'])
  assert.deepEqual(f.calls.versions, [])
  assert.ok(selected.bindings.every(binding => binding.selectionMode === 'follow-platform' && binding.selectedVersionId === 'v-cap'))
  f.calls.catalogs.length = 0
  await f.service.listWithDiagnostics({ mode: 'manual', capabilityId: 'cap' })
  assert.deepEqual(f.calls.catalogs.sort(), ['0', '1'])
  f.unsubscribe('sub-0')
  f.unsubscribe('sub-1')
  await assert.rejects(f.service.select({ capabilityId: 'cap', versionId: 'follow-platform' }), { code: 'PERMISSION_DENIED' })
  assert.equal(f.service.cached().items.some(item => item.capability.id === 'cap'), false)
})

test('authorization failures clear display caches and are never replaced with stale grants', async t => {
  const f = await refreshFixture(t)
  await f.service.list()
  f.before(async () => { throw new AuthApiError({ statusCode: 403, message: 'Forbidden' }, 'skills') })
  await assert.rejects(f.service.listWithDiagnostics({ mode: 'manual' }), { statusCode: 403 })
  assert.deepEqual(f.service.cached().items, [])
  await assert.rejects(f.service.select({ capabilityId: 'cap', versionId: 'follow-platform' }), { statusCode: 403 })
  assert.deepEqual(f.calls.previews, [])
})

test('operation authorization never joins a display refresh that can return cached grants', async t => {
  const f = await refreshFixture(t)
  await f.service.list()
  await f.service.listWithDiagnostics({ mode: 'manual', capabilityId: 'cap' })
  f.before(async () => { throw new AuthApiError({ statusCode: 403, message: 'Revoked' }, 'skills') })
  const display = f.service.listWithDiagnostics({ mode: 'manual', capabilityId: 'cap' })
  const selection = f.service.select({ capabilityId: 'cap', versionId: 'follow-platform' })
  assert.equal((await display).items.length, 7)
  await assert.rejects(selection, { statusCode: 403 })
  assert.deepEqual(f.calls.previews, [])
  assert.deepEqual(f.service.cached().items, [])
})

test('logout discards in-flight catalogs even when the same identity signs in again', async t => {
  const f = await refreshFixture(t)
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.before(async () => { entered(); await gate })
  const pending = f.service.listWithDiagnostics({ mode: 'manual' })
  const rejected = assert.rejects(pending, error => error instanceof AppError && error.code === 'INVALID_STATE')
  await started
  f.service.cancelAllRewrites()
  assert.deepEqual(f.service.cached().items, [])
  release()
  await rejected
  assert.deepEqual(f.service.cached().items, [])
  f.before(async () => undefined)
  await f.service.listWithDiagnostics({ mode: 'auto' })
  assert.equal(f.service.cached().items.length, 7)
  f.switchUser()
  assert.deepEqual(f.service.cached().items, [])
})
