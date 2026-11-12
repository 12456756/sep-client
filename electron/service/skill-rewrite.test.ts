import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLibraryService } from './skill-library-service'
import { SkillVersionStore } from '../data/skill-version-store'
import { SkillSubmissionStore } from '../data/skill-submission-store'
import type { TaskOwnerScope } from '../data/scope-path'
import type { SkillRewritePort } from '../domain/skill-rewrite'
import type { SkillRewriteInput, SkillRewriteOutput } from '../../src/shared/skill-rewrite'

const owner = { enterpriseId: 'ent', memberId: 'member' }
const metadata = '---\r\nname: report\r\ncustom: keep\r\nallowed-tools: read\r\n---\r\n'
const input: SkillRewriteInput = { requestId: '00000000-0000-4000-8000-000000000001', capabilityId: 'cap', versionId: 'v1',
  modelId: 'model', content: metadata + '# Original\r\n', prompt: 'Add sources', history: [] }
const output: SkillRewriteOutput = { body: '# Original\n\nSources required.\n', summary: 'Add sources', changes: [{ kind: 'add', title: 'Sources', detail: 'Require sources.' }] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(rewrite: SkillRewritePort['rewrite'] = async () => output) {
  const root = await mkdtemp(join(tmpdir(), 'sep-rewrite-'))
  const submissions = new SkillSubmissionStore(root)
  const versions = new SkillVersionStore(join(root, 'versions'))
  let scope: TaskOwnerScope | null = owner
  let allowed = true
  let generated = 0
  let uploaded = 0
  const version = { id: 'v1', capabilityId: 'cap', scope: 'PLATFORM', version: '1', status: 'PLATFORM_APPROVED' }
  const service = new SkillLibraryService({
    scope: { currentScope: () => scope }, token: async () => 'test', versions, submissions,
    subscriptions: async () => [{ employeeId: 'employee', subscriptionId: 'sub' }],
    authorizeRewriteModel: async () => allowed ? { subscriptionId: 'sub' } : null,
    rewriter: { rewrite: async (request, signal) => { generated++; return rewrite(request, signal) } },
    platform: {
      skills: async () => ({ subscriptionId: 'sub', skills: [{ capability: { id: 'cap', name: 'Report', description: '', type: 'SKILL' }, currentVersion: version, versions: [version] }] }),
      list: async () => [version], preview: async () => ({ content: input.content }),
      create: async () => { uploaded++; throw new Error('offline') },
    },
  })
  return { service, submissions, versions, generated: () => generated, uploaded: () => uploaded,
    switchScope: (value: TaskOwnerScope | null) => { scope = value }, denyModel: () => { allowed = false } }
}

test('rewriting preserves all metadata, only saving creates a version, and saving does not select it', async () => {
  const f = await fixture(async request => {
    assert.equal(request.subscriptionId, 'sub')
    assert.equal(request.skillName, 'Report')
    return output
  })
  const result = await f.service.rewrite(input)
  assert.equal(result.requestId, input.requestId)
  assert.equal(result.content, metadata + output.body.replace(/\n/g, '\r\n'))
  assert.deepEqual(await f.submissions.list(owner, 'cap'), [])
  assert.equal(f.uploaded(), 0)
  const saved = await f.service.save({ idempotencyKey: 'rewrite-save-00000001', request: { capabilityId: 'cap', parentVersionId: 'v1', content: result.content, changeSummary: 'Sources' } })
  assert.equal(saved.uploaded, false)
  assert.equal((await f.submissions.list(owner, 'cap'))[0].request.content, result.content)
  assert.equal(await f.versions.selected(owner, 'sub', 'cap'), null)
})

test('unauthorized capability, version and model never reach generation', async () => {
  const f = await fixture()
  await assert.rejects(f.service.rewrite({ ...input, capabilityId: 'other' }))
  await assert.rejects(f.service.rewrite({ ...input, versionId: 'other' }), { code: 'NOT_FOUND' })
  f.denyModel()
  await assert.rejects(f.service.rewrite(input), { code: 'MODEL_NOT_ALLOWED' })
  assert.equal(f.generated(), 0)
})

test('cancellation, concurrent request limits and late model responses cannot write a version', async () => {
  const started = deferred<AbortSignal>()
  const response = deferred<SkillRewriteOutput>()
  const f = await fixture(async (_request, signal) => { started.resolve(signal); return response.promise })
  const first = f.service.rewrite(input)
  const signal = await started.promise
  await assert.rejects(f.service.rewrite(input), { code: 'INVALID_STATE' })
  const second = f.service.rewrite({ ...input, requestId: '00000000-0000-4000-8000-000000000002' })
  await assert.rejects(f.service.rewrite({ ...input, requestId: '00000000-0000-4000-8000-000000000003' }), { code: 'RATE_LIMITED' })
  f.service.cancelRewrite({ requestId: input.requestId })
  assert.equal(signal.aborted, true)
  response.resolve(output)
  await assert.rejects(first, { code: 'SKILL_REWRITE_CANCELLED' })
  await second
  assert.deepEqual(await f.submissions.list(owner, 'cap'), [])
})

test('another identity cannot cancel a request or receive the previous identity response', async () => {
  const started = deferred<AbortSignal>()
  const response = deferred<SkillRewriteOutput>()
  const f = await fixture(async (_request, signal) => { started.resolve(signal); return response.promise })
  const pending = f.service.rewrite(input)
  const signal = await started.promise
  f.switchScope({ ...owner, memberId: 'other' })
  f.service.cancelRewrite({ requestId: input.requestId })
  assert.equal(signal.aborted, false)
  response.resolve(output)
  await assert.rejects(pending, /登录身份已变化/)
})

test('logout invalidates in-flight responses even when the same identity signs in again', async () => {
  const started = deferred<void>()
  const response = deferred<SkillRewriteOutput>()
  const f = await fixture(async () => { started.resolve(); return response.promise })
  const pending = f.service.rewrite(input)
  await started.promise
  f.service.cancelAllRewrites()
  f.switchScope(owner)
  response.resolve(output)
  await assert.rejects(pending, { code: 'SKILL_REWRITE_CANCELLED' })
})

test('model output cannot replace frontmatter or smuggle extra execution fields', async () => {
  for (const value of [{ ...output, body: '---\nname: hijacked\n---\n# Changed' }, { ...output, tools: ['exec'] }]) {
    const f = await fixture(async () => value)
    await assert.rejects(f.service.rewrite(input))
    assert.deepEqual(await f.submissions.list(owner, 'cap'), [])
  }
})
