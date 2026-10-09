import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLibraryService } from './skill-library-service'
import { SkillVersionStore } from '../data/skill-version-store'
import { SkillSubmissionStore } from '../data/skill-submission-store'
import { AuthApiError, SkillSubmissionResponseError, type SkillVersion } from '../common/platform/platform-api'
import { AppError } from '../errors/app-error'
import { setLogSink, type LogRecord } from '../common/logger'

let restoreLogSink: (() => void) | undefined
afterEach(() => { restoreLogSink?.(); restoreLogSink = undefined })

const scope = { enterpriseId: 'ent', memberId: 'user' }
const published: SkillVersion = { id: 'v1', capabilityId: 'cap', scope: 'PLATFORM', version: '1.0', status: 'PLATFORM_APPROVED' }
const content = '---\r\nname: example\r\n---\r\n# Raw  \r\n'
async function fixture(uploadStatus = 'PENDING_ENTERPRISE_REVIEW') {
  const root = await mkdtemp(join(tmpdir(), 'sep-library-'))
  const versions = new SkillVersionStore(join(root, 'versions'))
  const submissions = new SkillSubmissionStore(root)
  let personal: SkillVersion | null = null
  let failUpload = false
  let uploadError: unknown = null
  let offline = false
  let currentScope = scope
  let verificationError: unknown = null
  let hideSubmission = false
  const queries: { capabilityId: string }[] = []
  const uploads: string[] = []
  const service = new SkillLibraryService({
    scope: { currentScope: () => currentScope }, token: async () => { if (offline) throw new Error('offline'); return 'test-token' }, versions, submissions,
    subscriptions: async () => [{ subscriptionId: 'sub-a', employeeId: 'emp-a' }, { subscriptionId: 'sub-b', employeeId: 'emp-b' }],
    platform: {
      skills: async (id: string) => ({ subscriptionId: id === 'emp-a' ? 'sub-a' : 'sub-b', canManage: false, skills: [{ capability: { id: 'cap', name: 'Analysis', description: 'Raw skill', type: 'SKILL' }, currentVersion: published, versions: personal ? [published, personal] : [published], upgradeAvailable: false }] }),
      list: async input => {
        queries.push(input)
        if (personal && verificationError) throw verificationError
        if (personal) assert.equal((await submissions.list(scope, 'cap'))[0]?.uploadedVersion?.id, personal.id)
        return personal && !hideSubmission ? [published, personal] : [published]
      },
      preview: async () => ({ content }),
      create: async (request, key) => {
        assert.equal(request.content, content)
        uploads.push(key)
        if (failUpload) throw new Error('offline')
        if (uploadError) throw uploadError
        personal = { ...published, id: 'personal-v1', scope: 'PERSONAL', ownerId: 'user', status: uploadStatus, content: request.content }
        return personal
      },
    },
  })
  return { service, versions, submissions, uploads, queries, setVerificationError: (error: unknown) => { verificationError = error }, hideSubmission: () => { hideSubmission = true }, setUploadError: (error: unknown) => { uploadError = error }, switchUser: () => { currentScope = { ...scope, memberId: "other" } }, offline: () => { offline = true }, fail: (value: boolean) => { failUpload = value }, reject: () => { personal = { ...personal!, status: 'ENTERPRISE_REJECTED' } }, approve: () => { personal = { ...personal!, status: 'ENTERPRISE_APPROVED' } } }
}

describe('SkillLibraryService', () => {
  it('queries the submitted capability after persisting its successful receipt and logs confirmation', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    const f = await fixture()
    const result = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'confirm-upload-key-01' })
    assert.equal(result.uploaded, true)
    assert.deepEqual(f.queries.at(-1), { capabilityId: 'cap' })
    const record = logs.find(record => record.message === 'personal skill upload verification completed')
    assert.equal(record?.fields.found, true)
    assert.equal(record?.fields.versionId, 'personal-v1')
    assert.equal(record?.fields.reviewStatus, 'PENDING_ENTERPRISE_REVIEW')
    assert.equal(record?.fields.idempotencyKey, result.idempotencyKey)
    assert.doesNotMatch(JSON.stringify(logs), /name: example|test-token/)
  })

  it('keeps upload success and the saved receipt when the confirmation list omits it', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    const f = await fixture()
    f.hideSubmission()
    const result = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'missing-receipt-key-01' })
    assert.equal(result.uploaded, true)
    assert.equal((await f.submissions.list(scope, 'cap'))[0]?.uploadedVersion?.id, result.version?.id)
    const record = logs.find(record => record.message === 'personal skill upload verification completed')
    assert.equal(record?.level, 'warn')
    assert.equal(record?.fields.found, false)
    assert.equal(f.uploads.length, 1)
  })

  it('logs a confirmation HTTP failure without resubmitting or losing the successful receipt', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    const f = await fixture()
    f.setVerificationError(new AuthApiError({ statusCode: 503, message: 'private-platform-error' }, 'skills'))
    const result = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'query-failed-key-01' })
    assert.equal(result.uploaded, true)
    assert.equal((await f.submissions.list(scope, 'cap'))[0]?.uploadedVersion?.id, 'personal-v1')
    const record = logs.find(record => record.message === 'personal skill upload verification failed')
    assert.equal(record?.fields.statusCode, 503)
    assert.equal(f.uploads.length, 1)
    assert.doesNotMatch(JSON.stringify(logs), /private-platform-error|name: example|test-token/)
  })

  it('reports an invalid submission receipt as a generic error, not an offline upload', async () => {
    const f = await fixture()
    f.setUploadError(new SkillSubmissionResponseError())
    await assert.rejects(() => f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'invalid-receipt-key-01' }), error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'INTERNAL_ERROR')
      assert.doesNotMatch(error.message, /response|validation|SkillSubmission/)
      return true
    })
    const saved = await f.submissions.list(scope, 'cap')
    assert.equal(saved[0]?.request.content, content)
    assert.equal(saved[0]?.uploadedVersion, undefined)
  })
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
  for (const status of [403, 409]) {
    it(`surfaces platform ${status} errors instead of treating them as retryable upload failures`, async () => {
      const f = await fixture()
      const input = { request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: `test-platform-error-${status}` }
      f.setUploadError(new AuthApiError({ statusCode: status, message: 'platform rejection' }, 'skills'))

      await assert.rejects(() => f.service.save(input), error => {
        assert.ok(error instanceof AuthApiError)
        assert.equal(error.statusCode, status)
        return true
      })
      const saved = await f.submissions.list(scope, 'cap')
      assert.equal(saved.length, 1)
      assert.equal(saved[0]?.request.content, content)
    })
  }
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
