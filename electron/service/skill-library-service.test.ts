import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLibraryService } from './skill-library-service'
import { SkillVersionStore } from '../data/skill-version-store'
import { SkillSubmissionStore } from '../data/skill-submission-store'
import type { SkillVersion } from '../common/platform/platform-api'

const scope = { enterpriseId: 'ent', memberId: 'user' }
const published: SkillVersion = { id: 'v1', capabilityId: 'cap', scope: 'PLATFORM', version: '1.0', status: 'PLATFORM_APPROVED' }
const content = '---\r\nname: example\r\n---\r\n# Raw  \r\n'
async function fixture(uploadStatus = 'PENDING_ENTERPRISE_REVIEW') {
  const root = await mkdtemp(join(tmpdir(), 'sep-library-'))
  const versions = new SkillVersionStore(join(root, 'versions'))
  const submissions = new SkillSubmissionStore(root)
  let personal: SkillVersion | null = null
  let failUpload = false
  let offline = false
  let currentScope = scope
  const uploads: string[] = []
  const service = new SkillLibraryService({
    scope: { currentScope: () => currentScope }, token: async () => { if (offline) throw new Error('offline'); return 'test-token' }, versions, submissions,
    subscriptions: async () => [{ subscriptionId: 'sub-a', employeeId: 'emp-a' }, { subscriptionId: 'sub-b', employeeId: 'emp-b' }],
    platform: {
      skills: async (id: string) => ({ subscriptionId: id === 'emp-a' ? 'sub-a' : 'sub-b', canManage: false, skills: [{ capability: { id: 'cap', name: 'Analysis', description: 'Raw skill', type: 'SKILL' }, currentVersion: published, versions: personal ? [published, personal] : [published], upgradeAvailable: false }] }),
      list: async () => personal ? [published, personal] : [published],
      preview: async () => ({ content }),
      create: async (request, key) => {
        assert.equal(request.content, content)
        uploads.push(key)
        if (failUpload) throw new Error('offline')
        personal = { ...published, id: 'personal-v1', scope: 'PERSONAL', ownerId: 'user', status: uploadStatus, content: request.content }
        return personal
      },
    },
  })
  return { service, versions, submissions, uploads, switchUser: () => { currentScope = { ...scope, memberId: "other" } }, offline: () => { offline = true }, fail: (value: boolean) => { failUpload = value }, reject: () => { personal = { ...personal!, status: 'ENTERPRISE_REJECTED' } }, approve: () => { personal = { ...personal!, status: 'ENTERPRISE_APPROVED' } } }
}

describe('SkillLibraryService', () => {
  it('groups a capability across employees without losing subscription selections', async () => {
    const { service } = await fixture()
    const items = await service.list()
    assert.equal(items.length, 1)
    assert.equal(items[0].bindings.length, 2)
    assert.equal(items[0].bindings[0].selectedVersionId, 'v1')
  })
  it('saves exact source locally before upload, persists retry keys, allows owner-local use before upload and review', async () => {
    const f = await fixture()
    f.fail(true)
    const request = { capabilityId: 'cap', parentVersionId: 'v1', content, changeSummary: 'My version' }
    const saved = await f.service.save({ request, idempotencyKey: 'test-idempotency-key-01' })
    assert.equal(saved.uploaded, false)
    assert.equal((await f.submissions.list(scope, 'cap'))[0].request.content, content)
    assert.equal((await f.service.list())[0].localVersions.length, 1)
    await f.service.select({ capabilityId: 'cap', versionId: saved.idempotencyKey })
    const localId = await f.versions.selected(scope, 'sub-a', 'cap')
    assert.ok(localId)
    assert.ok(localId.startsWith('local-'))
    assert.equal((await f.versions.load(scope, 'sub-a', 'cap', localId))?.content, content)
    assert.equal((await f.service.list())[0].bindings[0].selectedVersionId, saved.idempotencyKey)
    f.fail(false)
    const retried = await f.service.retry({ capabilityId: 'cap', idempotencyKey: saved.idempotencyKey })
    assert.equal(retried.uploaded, true)
    assert.deepEqual(f.uploads, ['test-idempotency-key-01', 'test-idempotency-key-01'])
    assert.equal((await f.service.list())[0].usableVersionIds.includes('personal-v1'), false)
    await f.service.select({ capabilityId: 'cap', versionId: 'personal-v1' })
    assert.equal(await f.versions.selected(scope, 'sub-a', 'cap'), localId)
    assert.equal(await f.versions.selected(scope, 'sub-b', 'cap'), localId)
    assert.equal((await f.versions.load(scope, 'sub-a', 'cap', localId))?.content, content)
    assert.equal((await f.service.list())[0].bindings[0].selectedVersionId, saved.idempotencyKey)
    f.reject()
    assert.equal((await f.service.list())[0].usableVersionIds.includes('personal-v1'), false)
    assert.ok((await f.service.list())[0].usableVersionIds.includes(saved.idempotencyKey))
    assert.equal((await f.service.list())[0].localVersions.length, 1)
    await f.service.select({ capabilityId: 'cap', versionId: saved.idempotencyKey })
    await f.service.select({ capabilityId: 'cap', versionId: 'personal-v1' })
    assert.equal(await f.versions.selected(scope, 'sub-a', 'cap'), localId)
    f.approve()
    const approved = (await f.service.list())[0]
    assert.ok(approved.usableVersionIds.includes('personal-v1'))
    assert.equal(approved.bindings[0].selectedVersionId, saved.idempotencyKey)
    assert.equal(await f.service.preview({ capabilityId: 'cap', versionId: saved.idempotencyKey }), content)
    f.switchUser()
    assert.equal((await f.service.list())[0].localVersions.length, 0)
    await assert.rejects(f.service.preview({ capabilityId: 'cap', versionId: saved.idempotencyKey }))
    assert.equal((await f.service.list())[0].usableVersionIds.includes('personal-v1'), false)
    await assert.rejects(f.service.select({ capabilityId: 'cap', versionId: saved.idempotencyKey }))
    await assert.rejects(f.service.select({ capabilityId: 'cap', versionId: 'personal-v1' }))
    assert.equal(await f.versions.selected({ ...scope, memberId: 'other' }, 'sub-a', 'cap'), null)
  })
  it('keeps a selected local source identified as local even when upload is already approved', async () => {
    const f = await fixture('ENTERPRISE_APPROVED')
    const saved = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'test-approved-local-01' })
    await f.service.select({ capabilityId: 'cap', versionId: saved.idempotencyKey })
    const item = (await f.service.list())[0]
    assert.equal(item.bindings[0].selectedVersionId, saved.idempotencyKey)
    assert.ok(item.usableVersionIds.includes(saved.idempotencyKey))
    assert.ok(item.usableVersionIds.includes('personal-v1'))
  })
  it('rejects changed content with the same key and unauthorized capability', async () => {
    const f = await fixture()
    const input = { request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'test-idempotency-key-02' }
    await f.service.save(input)
    await assert.rejects(() => f.service.save({ ...input, request: { ...input.request, content: 'changed' } }))
    await assert.rejects(() => f.service.preview({ capabilityId: 'other', versionId: 'v1' }))
    assert.equal((await f.submissions.list({ ...scope, memberId: 'other' }, 'cap')).length, 0)
  })
  it('keeps an opened skill edit durable even when the network fails before token refresh', async () => {
    const f = await fixture()
    await f.service.list()
    f.offline()
    const input = { request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'test-idempotency-key-03' }
    const saved = await f.service.save(input)
    assert.equal(saved.uploaded, false)
    assert.equal((await f.submissions.list(scope, 'cap'))[0].request.content, content)
    await assert.rejects(f.service.save({ ...input, request: { ...input.request, capabilityId: 'unauthorized' } }))
  })

})
