import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLibraryService } from './skill-library-service'
import { localSkillVersionId, SkillVersionStore } from '../data/skill-version-store'
import { ScopePath } from '../data/scope-path'
import { SkillSubmissionStore } from '../data/skill-submission-store'
import { AuthApiError, SkillSubmissionResponseError, type SkillVersion } from '../common/platform/platform-api'
import { AppError } from '../errors/app-error'
import { toEnvelope } from '../errors/error-mapper'
import { setLogSink, type LogRecord } from '../common/logger'

let restoreLogSink: (() => void) | undefined
afterEach(() => { restoreLogSink?.(); restoreLogSink = undefined })

const scope = { enterpriseId: 'ent', memberId: 'user' }
const published: SkillVersion = { id: 'v1', capabilityId: 'cap', scope: 'PLATFORM', version: '1.0', status: 'PLATFORM_APPROVED' }
const content = '---\r\nname: example\r\n---\r\n# Raw  \r\n'
function confirmationLogs() {
  const logs: LogRecord[] = []
  let complete!: () => void
  const done = new Promise<void>(resolve => { complete = resolve })
  restoreLogSink = setLogSink(record => {
    logs.push(record)
    if (record.message === 'personal skill upload verification completed' || record.message === 'personal skill upload verification failed') complete()
  })
  return { logs, done }
}
async function fixture(uploadStatus = 'PENDING_ENTERPRISE_REVIEW', publicVersions = [published]) {
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
  let confirmation: ((signal?: AbortSignal) => Promise<SkillVersion[]>) | null = null
  const queries: { capabilityId: string }[] = []
  const uploads: string[] = []
  const service = new SkillLibraryService({
    scope: { currentScope: () => currentScope }, token: async () => { if (offline) throw new Error('offline'); return 'test-token' }, versions, submissions,
    subscriptions: async () => [{ subscriptionId: 'sub-a', employeeId: 'emp-a' }, { subscriptionId: 'sub-b', employeeId: 'emp-b' }],
    platform: {
      skills: async (id: string) => ({ subscriptionId: id === 'emp-a' ? 'sub-a' : 'sub-b', canManage: false, skills: [{ capability: { id: 'cap', name: 'Analysis', description: 'Raw skill', type: 'SKILL' }, currentVersion: publicVersions[0], versions: personal ? [...publicVersions, personal] : publicVersions, upgradeAvailable: false }] }),
      list: async (input, _token, signal) => {
        queries.push(input)
        if (personal && confirmation) return confirmation(signal)
        if (personal && verificationError) throw verificationError
        if (personal) assert.equal((await submissions.list(scope, 'cap'))[0]?.uploadedVersion?.id, personal.id)
        return personal && !hideSubmission ? [...publicVersions, personal] : publicVersions
      },
      preview: async () => ({ content }),
      create: async (request, key) => {
        assert.equal(request.content, content)
        uploads.push(key)
        if (failUpload) throw new Error('offline')
        if (uploadError) throw uploadError
        personal = { ...published, id: 'personal-v1', scope: 'PERSONAL', ownerId: 'user', status: uploadStatus, content: request.content, changeSummary: request.changeSummary }
        return personal
      },
    },
  })
  return { root, service, versions, submissions, uploads, queries, setConfirmation: (query: (signal?: AbortSignal) => Promise<SkillVersion[]>) => { confirmation = query }, setVerificationError: (error: unknown) => { verificationError = error }, hideSubmission: () => { hideSubmission = true }, setUploadError: (error: unknown) => { uploadError = error }, switchUser: () => { currentScope = { ...scope, memberId: "other" } }, offline: () => { offline = true }, online: () => { offline = false }, fail: (value: boolean) => { failUpload = value }, reject: () => { personal = { ...personal!, status: 'ENTERPRISE_REJECTED' } }, approve: () => { personal = { ...personal!, status: 'ENTERPRISE_APPROVED' } } }
}

describe('SkillLibraryService', () => {
  it('removes only the local copy offline, even before the catalog sees the receipt', async () => {
    const f = await fixture()
    const idempotencyKey = 'delete-uploaded-key'
    const request = { capabilityId: 'cap', parentVersionId: 'v1', content, changeSummary: 'My version' }
    await f.service.save({ request, idempotencyKey })
    const copyId = localSkillVersionId(idempotencyKey)
    await f.service.select({ capabilityId: 'cap', versionId: idempotencyKey })
    const other = await f.versions.savePlatform(scope, { subscriptionId: 'sub-b', employeeId: 'emp-b', capabilityId: 'cap',
      version: 'Cloud copy', content, baseSkillVersionId: 'personal-v1', sourceScope: 'PERSONAL' })
    await f.versions.select(scope, 'sub-b', 'cap', other.versionId)
    const inactive = await f.versions.save(scope, { subscriptionId: 'sub-old', employeeId: 'emp-old', capabilityId: 'cap',
      version: 'My version', content, baseSkillVersionId: 'v1', localSubmissionId: idempotencyKey, versionId: copyId })
    await f.versions.select(scope, 'sub-old', 'cap', inactive.versionId)
    f.offline()
    const updated = await f.service.deleteLocalCopy({ capabilityId: 'cap', idempotencyKey })
    const cloud = updated.versions.find(version => version.id === 'personal-v1')
    assert.equal(cloud?.status, 'PENDING_ENTERPRISE_REVIEW')
    assert.equal(cloud?.changeSummary, 'My version')
    assert.equal(cloud?.content, undefined)
    assert.deepEqual(updated.localVersions, [])
    assert.deepEqual(updated.bindings.map(binding => binding.selectedVersionId), ['v1', 'personal-v1'])
    assert.deepEqual(await f.submissions.list(scope, 'cap'), [])
    const outbox = join(new ScopePath(f.root).ownerRoot(scope), 'skill-submissions.json')
    assert.deepEqual(JSON.parse(await readFile(outbox + '.bak', 'utf8')), [])
    for (const subscriptionId of ['sub-a', 'sub-b', 'sub-old']) {
      assert.equal(await f.versions.load(scope, subscriptionId, 'cap', copyId), null)
      const selectionBackup = join(f.root, 'versions', scope.enterpriseId, scope.memberId, subscriptionId, 'selection.json.bak')
      assert.ok(!(await readFile(selectionBackup, 'utf8')).includes(copyId))
    }
    assert.equal(await f.versions.selected(scope, 'sub-a', 'cap'), null)
    assert.equal(await f.versions.selected(scope, 'sub-b', 'cap'), other.versionId)
    assert.equal(await f.versions.selected(scope, 'sub-old', 'cap'), null)
    await assert.rejects(f.service.deleteLocalCopy({ capabilityId: 'cap', idempotencyKey: 'personal-v1' }), { code: 'NOT_FOUND' })
    f.online()
    f.approve()
    assert.equal((await f.service.list())[0].versions.find(version => version.id === 'personal-v1')?.status, 'ENTERPRISE_APPROVED')
  })

  it('cannot delete another member’s local copy', async () => {
    const f = await fixture()
    const idempotencyKey = 'delete-local-key-1'
    f.fail(true)
    await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey })
    f.switchUser()
    f.offline()
    await assert.rejects(f.service.deleteLocalCopy({ capabilityId: 'cap', idempotencyKey }), { code: 'NOT_FOUND' })
    assert.equal((await f.submissions.list(scope, 'cap'))[0]?.idempotencyKey, idempotencyKey)
    assert.equal(await f.versions.selected(scope, 'sub-a', 'cap'), localSkillVersionId(idempotencyKey))
  })

  it('drops only the targeted local outbox record and disables retry offline', async () => {
    const f = await fixture()
    const idempotencyKey = 'delete-local-key-2'
    const keep = 'keep-local-key-02'
    const request = { capabilityId: 'cap', parentVersionId: 'v1', content }
    f.fail(true)
    await f.service.save({ request: { ...request, changeSummary: 'Keep' }, idempotencyKey: keep })
    await f.service.save({ request: { ...request, changeSummary: 'Delete' }, idempotencyKey })
    f.offline()
    const updated = await f.service.deleteLocalCopy({ capabilityId: 'cap', idempotencyKey })
    assert.deepEqual(updated.localVersions.map(record => record.idempotencyKey), [keep])
    assert.ok(updated.bindings.every(binding => binding.selectedVersionId === 'v1'))
    assert.deepEqual(updated.versions.map(version => version.id), ['v1'])
    await assert.rejects(f.service.retry({ capabilityId: 'cap', idempotencyKey }), { code: 'NOT_FOUND' })
  })
  it('preserves specific business failures through the IPC error mapping', async () => {
    const f = await fixture()
    for (const [work, code, message] of [
      [() => f.service.preview({ capabilityId: 'other', versionId: 'v1' }), 'PERMISSION_DENIED', '没有此技能的有效员工授权。'],
      [() => f.service.preview({ capabilityId: 'cap', versionId: 'missing' }), 'NOT_FOUND', '技能版本不可见或已被移除。'],
      [() => f.service.retry({ capabilityId: 'cap', idempotencyKey: 'missing' }), 'NOT_FOUND', '本地保存记录不存在。'],
      [() => f.service.select({ capabilityId: 'cap', versionId: 'missing' }), 'PERMISSION_DENIED', '该技能版本尚未审核通过或不允许使用。'],
      [() => f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'missing', content }, idempotencyKey: 'invalid-source-key-01' }), 'INVALID_ARGUMENT', '来源版本不可见或不属于该技能。'],
    ] as const) {
      await assert.rejects(work(), error => {
        assert.equal(toEnvelope(error).code, code)
        assert.equal(toEnvelope(error).message, message)
        return true
      })
    }
  })
  it('uses follow mode when returning from personal content or selecting a public history entry', async () => {
    const latest = { ...published, id: 'v2', scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', version: '2.0' }
    const f = await fixture('ENTERPRISE_APPROVED', [latest, published])
    const saved = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'follow-platform-local-01' })
    await f.service.select({ capabilityId: 'cap', versionId: saved.idempotencyKey })
    await f.service.select({ capabilityId: 'cap', versionId: 'follow-platform' })
    for (const subscription of ['sub-a', 'sub-b']) {
      assert.deepEqual((await f.versions.selections(scope, subscription)).cap, { versionId: 'platform-v2', automatic: true })
    }
    await f.service.select({ capabilityId: 'cap', versionId: 'v1' })
    assert.deepEqual((await f.versions.selections(scope, 'sub-a')).cap, { versionId: 'platform-v2', automatic: true })
    assert.equal((await f.service.list())[0].bindings[0].selectedVersionId, 'v2')
  })

  it('displays the current public version instead of a legacy pinned version', async () => {
    const f = await fixture()
    const old = await f.versions.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'emp-a', capabilityId: 'cap', baseSkillVersionId: 'old-public', version: '0.1', content: '# Old' })
    await f.versions.select(scope, 'sub-a', 'cap', old.versionId)
    const item = (await f.service.list())[0]
    assert.equal(item.bindings[0].selectedVersionId, 'v1')
  })
  it('keeps a known personal selection visible when remote history no longer contains it', async () => {
    const f = await fixture()
    const saved = await f.versions.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'emp-a', capabilityId: 'cap',
      baseSkillVersionId: 'personal-removed', sourceScope: 'PERSONAL', version: 'mine', content: '# Mine' })
    await f.versions.select(scope, 'sub-a', 'cap', saved.versionId)
    const binding = (await f.service.list())[0].bindings[0]
    assert.equal(binding.selectedVersionId, 'personal-removed')
    assert.equal(binding.selectionMode, 'personal')
  })
  it('queries the submitted capability after persisting its successful receipt and logs confirmation', async () => {
    const { logs, done } = confirmationLogs()
    const f = await fixture()
    const result = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'confirm-upload-key-01' })
    assert.equal(result.uploaded, true)
    await done
    assert.deepEqual(f.queries.at(-1), { capabilityId: 'cap' })
    const record = logs.find(record => record.message === 'personal skill upload verification completed')
    assert.equal(record?.fields.found, true)
    assert.equal(record?.fields.versionId, 'personal-v1')
    assert.equal(record?.fields.reviewStatus, 'PENDING_ENTERPRISE_REVIEW')
    assert.equal(record?.fields.idempotencyKey, result.idempotencyKey)
    assert.doesNotMatch(JSON.stringify(logs), /name: example|test-token/)
  })

  it('keeps upload success and the saved receipt when the confirmation list omits it', async () => {
    const { logs, done } = confirmationLogs()
    const f = await fixture()
    f.hideSubmission()
    const result = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'missing-receipt-key-01' })
    assert.equal(result.uploaded, true)
    await done
    assert.equal((await f.submissions.list(scope, 'cap'))[0]?.uploadedVersion?.id, result.version?.id)
    const record = logs.find(record => record.message === 'personal skill upload verification completed')
    assert.equal(record?.level, 'warn')
    assert.equal(record?.fields.found, false)
    assert.equal(f.uploads.length, 1)
  })

  it('logs a confirmation HTTP failure without resubmitting or losing the successful receipt', async () => {
    const { logs, done } = confirmationLogs()
    const f = await fixture()
    f.setVerificationError(new AuthApiError({ statusCode: 503, message: 'private-platform-error' }, 'skills'))
    const result = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'query-failed-key-01' })
    assert.equal(result.uploaded, true)
    await done
    assert.equal((await f.submissions.list(scope, 'cap'))[0]?.uploadedVersion?.id, 'personal-v1')
    const record = logs.find(record => record.message === 'personal skill upload verification failed')
    assert.equal(record?.fields.statusCode, 503)
    assert.equal(f.uploads.length, 1)
    assert.doesNotMatch(JSON.stringify(logs), /private-platform-error|name: example|test-token/)
  })

  it('returns the persisted upload result while confirmation is stalled and logs its timeout', { timeout: 2_000 }, async t => {
    const { logs, done } = confirmationLogs()
    const controller = new AbortController()
    const timeouts: number[] = []
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      timeouts.push(milliseconds)
      return controller.signal
    })
    const f = await fixture()
    let querySignal: AbortSignal | undefined
    f.setConfirmation(signal => {
      querySignal = signal
      return new Promise<SkillVersion[]>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    try {
      const saved = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'stalled-query-key-01' })
      assert.equal(saved.uploaded, true)
      assert.equal((await f.submissions.list(scope, 'cap'))[0]?.uploadedVersion?.id, saved.version?.id)
      assert.equal(querySignal, controller.signal)
      assert.deepEqual(timeouts, [15_000])
      assert.equal(logs.some(record => record.message.startsWith('personal skill upload verification')), false)
    } finally {
      controller.abort(new DOMException('Confirmation timed out', 'TimeoutError'))
    }
    await done
    assert.equal(logs.find(record => record.message === 'personal skill upload verification failed')?.fields.errorType, 'TimeoutError')
    assert.equal(f.uploads.length, 1)
  })

  it('handles an account switch during background confirmation without rejecting the saved upload', { timeout: 2_000 }, async () => {
    const { logs, done } = confirmationLogs()
    const f = await fixture()
    let release!: (versions: SkillVersion[]) => void
    const pending = new Promise<SkillVersion[]>(resolve => { release = resolve })
    f.setConfirmation(() => pending)
    try {
      const saved = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'switched-query-key-01' })
      assert.equal(saved.uploaded, true)
      f.switchUser()
    } finally {
      release([published])
    }
    await done
    assert.equal(logs.some(record => record.message === 'personal skill upload verification completed'), false)
    assert.equal(logs.find(record => record.message === 'personal skill upload verification failed')?.fields.errorType, 'AppError')
    assert.equal((await f.submissions.list(scope, 'cap'))[0]?.uploadedVersion?.id, 'personal-v1')
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
    assert.equal(await f.versions.selected(scope, 'sub-a', 'cap'), null)
  })
  it('groups a capability across employees without losing subscription selections', async () => {
    const { service } = await fixture()
    const items = await service.list()
    assert.equal(items.length, 1)
    assert.equal(items[0].bindings.length, 2)
    assert.equal(items[0].bindings[0].selectedVersionId, 'v1')
  })
  it('saves and automatically uses exact local source for every employee before upload and review', async () => {
    const f = await fixture()
    f.fail(true)
    const request = { capabilityId: 'cap', parentVersionId: 'v1', content, changeSummary: 'My version' }
    const saved = await f.service.save({ request, idempotencyKey: 'test-idempotency-key-01' })
    assert.equal(saved.uploaded, false)
    assert.equal((await f.submissions.list(scope, 'cap'))[0].request.content, content)
    assert.equal((await f.service.list())[0].localVersions.length, 1)
    assert.equal(saved.item?.bindings.length, 2)
    for (const binding of saved.item!.bindings) {
      assert.equal(binding.selectedVersionId, saved.idempotencyKey)
      assert.equal(binding.selectionMode, 'personal')
      const selected = await f.versions.selected(scope, binding.subscriptionId, 'cap')
      assert.ok(selected)
      assert.equal((await f.versions.load(scope, binding.subscriptionId, 'cap', selected))?.content, content)
    }
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
  it('automatically selects the new local source after upload regardless of review status', async () => {
    for (const status of ['PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED']) {
      const f = await fixture(status)
      const saved = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'test-upload-auto-use-01' })
      assert.equal(saved.uploaded, true)
      for (const binding of saved.item!.bindings) {
        assert.equal(binding.selectedVersionId, saved.idempotencyKey)
        assert.equal(binding.selectionMode, 'personal')
        const selected = await f.versions.selected(scope, binding.subscriptionId, 'cap')
        assert.ok(selected)
        assert.equal((await f.versions.load(scope, binding.subscriptionId, 'cap', selected))?.content, content)
        assert.deepEqual((await f.versions.selections(scope, binding.subscriptionId)).cap, { versionId: selected })
      }
    }
  })
  it('replaces the previous personal selection when another new version is saved', async () => {
    const f = await fixture('ENTERPRISE_APPROVED')
    f.fail(true)
    const request = { capabilityId: 'cap', parentVersionId: 'v1', content }
    await f.service.save({ request, idempotencyKey: 'test-first-local-01' })
    const saved = await f.service.save({ request, idempotencyKey: 'test-second-local-01' })
    const item = (await f.service.list())[0]
    assert.equal(item.localVersions.length, 2)
    assert.ok(item.bindings.every(binding => binding.selectedVersionId === saved.idempotencyKey && binding.selectionMode === 'personal'))
    assert.ok(item.usableVersionIds.includes(saved.idempotencyKey))
  })
  it('does not reactivate a saved version on upload retry after the user switches back to platform', async () => {
    const f = await fixture()
    f.fail(true)
    const saved = await f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'test-retry-selection-01' })
    await f.service.select({ capabilityId: 'cap', versionId: 'follow-platform' })
    f.fail(false)
    const retried = await f.service.retry({ capabilityId: 'cap', idempotencyKey: saved.idempotencyKey })
    assert.equal(retried.uploaded, true)
    assert.ok(retried.item?.bindings.every(binding => binding.selectedVersionId === 'v1' && binding.selectionMode === 'follow-platform'))
    for (const subscription of ['sub-a', 'sub-b']) {
      assert.deepEqual((await f.versions.selections(scope, subscription)).cap, { versionId: 'platform-v1', automatic: true })
    }
  })
  it('keeps the saved source recoverable and retries activation when a selection write fails', async t => {
    const f = await fixture()
    f.fail(true)
    const input = { request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'test-activation-retry-01' }
    const select = f.versions.select.bind(f.versions)
    let fail = true
    t.mock.method(f.versions, 'select', async (...args: Parameters<typeof select>) => {
      if (args[1] === 'sub-b' && fail) { fail = false; throw new Error('selection write failed') }
      return select(...args)
    })
    await assert.rejects(f.service.save(input), /selection write failed/)
    assert.equal((await f.submissions.list(scope, 'cap'))[0].request.content, content)
    const saved = await f.service.save(input)
    assert.equal(saved.item?.localVersions.length, 1)
    assert.ok(saved.item?.bindings.every(binding => binding.selectedVersionId === input.idempotencyKey))
    for (const subscription of ['sub-a', 'sub-b']) assert.ok(await f.versions.selected(scope, subscription, 'cap'))
  })
  it('does not activate the saved source for a new identity if the account changes during selection', async t => {
    const f = await fixture()
    f.fail(true)
    const save = f.versions.save.bind(f.versions)
    t.mock.method(f.versions, 'save', async (...args: Parameters<typeof save>) => {
      const saved = await save(...args)
      f.switchUser()
      return saved
    })
    await assert.rejects(f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'test-activation-scope-01' }), { code: 'INVALID_STATE' })
    for (const subscription of ['sub-a', 'sub-b']) {
      assert.equal(await f.versions.selected(scope, subscription, 'cap'), null)
      assert.equal(await f.versions.selected({ ...scope, memberId: 'other' }, subscription, 'cap'), null)
    }
  })
  it('rejects changed content with the same key and unauthorized capability', async () => {
    const f = await fixture()
    const input = { request: { capabilityId: 'cap', parentVersionId: 'v1', content }, idempotencyKey: 'test-idempotency-key-02' }
    await f.service.save(input)
    await assert.rejects(() => f.service.save({ ...input, request: { ...input.request, content: 'changed' } }))
    await assert.rejects(() => f.service.preview({ capabilityId: 'other', versionId: 'v1' }))
    assert.equal((await f.submissions.list({ ...scope, memberId: 'other' }, 'cap')).length, 0)
  })
  it('rejects duplicate personal names before upload while allowing the same save to be retried', async () => {
    const f = await fixture()
    const request = { capabilityId: 'cap', parentVersionId: 'v1', content, changeSummary: '版本1' }
    const input = { request, idempotencyKey: 'unique-personal-name-01' }
    const saved = await f.service.save(input)
    await assert.rejects(f.service.save({ request: { ...request, changeSummary: ' 版本1 ' }, idempotencyKey: 'unique-personal-name-02' }), error => {
      assert.equal(toEnvelope(error).code, 'INVALID_ARGUMENT')
      assert.equal(toEnvelope(error).message, '已有同名个人版本，请使用其他版本名称。')
      return true
    })
    assert.equal(f.uploads.length, 1)
    assert.equal((await f.submissions.list(scope, 'cap')).length, 1)
    assert.ok((await f.service.list())[0].bindings.every(binding => binding.selectedVersionId === saved.idempotencyKey))
    const retried = await f.service.save(input)
    assert.equal(retried.idempotencyKey, saved.idempotencyKey)
    assert.equal((await f.submissions.list(scope, 'cap')).length, 1)
  })
  it('rejects a personal name already visible only in platform history', async () => {
    const remote = { ...published, id: 'remote-personal', scope: 'PERSONAL', status: 'ENTERPRISE_APPROVED', ownerId: scope.memberId, changeSummary: '版本1' }
    const f = await fixture('PENDING_ENTERPRISE_REVIEW', [published, remote])
    await assert.rejects(f.service.save({ request: { capabilityId: 'cap', parentVersionId: 'v1', content, changeSummary: '版本1' }, idempotencyKey: 'remote-name-conflict-01' }), { code: 'INVALID_ARGUMENT' })
    assert.equal(f.uploads.length, 0)
    assert.equal((await f.submissions.list(scope, 'cap')).length, 0)
  })
  it('serializes duplicate-name checks for concurrent local saves without blocking names on other skills', async () => {
    const f = await fixture()
    f.fail(true)
    const request = { capabilityId: 'cap', parentVersionId: 'v1', content, changeSummary: '版本1' }
    const results = await Promise.allSettled([
      f.service.save({ request, idempotencyKey: 'concurrent-name-key-01' }),
      f.service.save({ request, idempotencyKey: 'concurrent-name-key-02' }),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.equal(toEnvelope(failed.reason).code, 'INVALID_ARGUMENT')
    assert.equal((await f.submissions.list(scope, 'cap')).length, 1)
    assert.equal(f.uploads.length, 1)
    await f.submissions.save(scope, { request: { ...request, capabilityId: 'another-cap' }, idempotencyKey: 'other-skill-name-key-01', createdAt: new Date().toISOString() })
    assert.equal((await f.submissions.list(scope, 'another-cap')).length, 1)
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
      assert.equal(await f.versions.selected(scope, 'sub-a', 'cap'), null)
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
    assert.ok(saved.item?.bindings.every(binding => binding.selectedVersionId === input.idempotencyKey && binding.selectionMode === 'personal'))
    await assert.rejects(f.service.save({ ...input, request: { ...input.request, capabilityId: 'unauthorized' } }))
  })

})
