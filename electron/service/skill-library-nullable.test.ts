import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLibraryService } from './skill-library-service'
import { SkillVersionStore } from '../data/skill-version-store'
import { SkillSubmissionStore } from '../data/skill-submission-store'
import { AuthApiError, type SkillVersion } from '../common/platform/platform-api'
import { setLogSink, type LogRecord } from '../common/logger'

const scope = { enterpriseId: 'ent', memberId: 'member' }
const published: SkillVersion = { id: 'v1', capabilityId: 'normal', scope: 'PLATFORM', version: '1.0', status: 'PLATFORM_APPROVED' }
const roots: string[] = []
let restore: (() => void) | undefined
afterEach(async () => {
  restore?.()
  restore = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function skill(id: string, currentVersion: unknown = { ...published, capabilityId: id }, versions: unknown[] = []) {
  return { capability: { id, name: id, description: '', type: 'SKILL' }, currentVersion, versions }
}
async function fixture(skills: unknown[], listError?: Error, listedVersions = [published]) {
  const root = await mkdtemp(join(tmpdir(), 'sep-nullable-skills-'))
  roots.push(root)
  const versions = new SkillVersionStore(join(root, 'versions'))
  const logs: LogRecord[] = []
  restore = setLogSink(record => logs.push(record))
  const service = new SkillLibraryService({
    scope: { currentScope: () => scope }, token: async () => 'private-token',
    subscriptions: async () => [{ subscriptionId: 'sub', employeeId: 'employee' }],
    versions, submissions: new SkillSubmissionStore(root),
    platform: {
      // Deliberately include invalid platform payloads to exercise the runtime boundary.
      skills: async () => ({ subscriptionId: 'sub', skills }),
      list: async input => {
        if (listError) throw listError
        return listedVersions.filter(version => version.capabilityId === input.capabilityId)
      },
      preview: async () => ({ content: '# Skill source' }),
      create: async () => published,
    },
  })
  return { service, versions, logs }
}

describe('nullable skill library metadata', () => {
  it('keeps two normal skills and a bound skill with no current version', async () => {
    const { service } = await fixture([skill('normal'), skill('second'), skill('empty', null)])
    const items = await service.list()
    assert.equal(items.length, 3)
    assert.equal(items[0].bindings[0].selectedVersionId, 'v1')
    assert.equal(items[2].bindings[0].currentVersion, null)
    assert.equal(items[2].bindings[0].selectedVersionId, null)
    assert.deepEqual(items[2].versions, [])
    assert.deepEqual(items[2].usableVersionIds, [])
  })

  it('skips malformed entries, reports partial data and logs only diagnostic fields', async () => {
    const invalid = { ...skill('bad'), capability: null, content: 'private-skill-source', token: 'private-token' }
    const { service, logs } = await fixture([skill('normal'), invalid, null, skill('')])
    const result = await service.listWithDiagnostics()
    assert.deepEqual(result.items.map(item => item.capability.id), ['normal'])
    assert.equal(result.skippedCount, 3)
    const failures = logs.filter(record => record.message === 'skill library entry skipped')
    assert.equal(failures.length, 3)
    assert.equal(failures[0].fields.employeeId, 'employee')
    assert.equal(failures[0].fields.subscriptionId, 'sub')
    assert.match(JSON.stringify(failures[0].fields.issuePaths), /capability/)
    assert.doesNotMatch(JSON.stringify(logs), /private-skill-source|private-token/)
  })

  it('preserves a selected local source even when the public version is absent', async () => {
    const { service, versions } = await fixture([skill('empty', null)])
    const saved = await versions.save(scope, {
      subscriptionId: 'sub', employeeId: 'employee', capabilityId: 'empty',
      baseSkillVersionId: 'base', localSubmissionId: 'local-request', versionId: 'local-v1',
      version: 'personal', content: '# Local source',
    })
    await versions.select(scope, 'sub', 'empty', saved.versionId)
    assert.equal((await service.list())[0].bindings[0].selectedVersionId, 'local-request')
  })

  it('allows an explicit approved selection without inventing a default version', async () => {
    const approved = { ...published, capabilityId: 'empty' }
    const { service, versions } = await fixture([skill('empty', null, [approved])], undefined, [approved])
    assert.equal((await service.list())[0].bindings[0].selectedVersionId, null)
    await service.select({ capabilityId: 'empty', versionId: approved.id })
    assert.equal((await service.list())[0].bindings[0].selectedVersionId, approved.id)
    assert.ok(await versions.selected(scope, 'sub', 'empty'))
  })

  it('isolates missing version IDs and versions linked to another capability', async () => {
    const { service } = await fixture([
      skill('normal'), skill('bad-id', { ...published, id: null }),
      skill('wrong-capability', published), skill('bad-history', null, [null]),
    ])
    const result = await service.listWithDiagnostics()
    assert.deepEqual(result.items.map(item => item.capability.id), ['normal'])
    assert.equal(result.skippedCount, 3)
  })

  it('does not select or authorize an unapproved version as a null-version fallback', async () => {
    const pending = { ...published, capabilityId: 'empty', scope: 'PERSONAL', ownerId: 'member', status: 'PENDING_ENTERPRISE_REVIEW' }
    const { service, versions } = await fixture([skill('empty', null, [pending])], undefined, [pending])
    const [item] = await service.list()
    assert.equal(item.bindings[0].selectedVersionId, null)
    assert.deepEqual(item.versions, [pending])
    assert.deepEqual(item.usableVersionIds, [])
    await assert.rejects(service.select({ capabilityId: 'empty', versionId: pending.id }))
    assert.equal(await versions.selected(scope, 'sub', 'empty'), null)
  })

  it('does not swallow real platform failures as partial success', async () => {
    const error = new AuthApiError({ statusCode: 503, message: 'Unavailable' }, 'skills')
    const { service } = await fixture([skill('normal')], error)
    await assert.rejects(service.list(), failure => failure === error)
  })
})
