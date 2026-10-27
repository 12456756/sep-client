import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLibraryService } from './skill-library-service'
import { SkillVersionStore } from '../data/skill-version-store'
import { SkillSubmissionStore } from '../data/skill-submission-store'

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

test('large libraries bound catalog and version requests while keeping item order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-library-loading-'))
  const active = { catalogs: 0, versions: 0 }
  const peak = { catalogs: 0, versions: 0 }
  const subscriptions = Array.from({ length: 27 }, (_, index) => ({ subscriptionId: 'sub-' + index, employeeId: String(index) }))
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
    assert.ok(peak.versions <= 4, 'version peak was ' + peak.versions)
  } finally { await rm(root, { recursive: true, force: true }) }
})
