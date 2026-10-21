/**
 * 员工授权的回归测试。
 *
 * 身份变化必须丢掉平台目录的 TTL 缓存。授权缓存与运行时准入共同依赖这一约束。
 * `GET /client/subscriptions` 加了 15 秒缓存，但只有"认证失效"这一条路径会丢掉它；
 * 登录与登出没丢。缓存不按身份分键，于是"登出后 15 秒内换账号登录"会读到
 * 上一个账号的订阅列表。
 *
 * 这里用**真实的** EmployeeDirectory 加一个计数的 fetcher，断言的是行为
 * （clear() 之后必须重新发请求），不是"invalidate 被调过"。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Subscription } from '../../src/shared/types'
import { EmployeeDirectory } from './employee-directory'
import {
  EmployeeAuthorizer,
  resolveEmployeeRuntime,
  type SkillProvisioner,
  type RuntimeProvider,
} from './employee-authorizer'
import { employeeRuntimeSnapshotSchema, type PreparedEmployeeSkill } from '../common/platform/employee-runtime-contract'
import type { SkillArtifactAvailable } from '../common/platform/skill-artifact-contract'
import * as videoFixture from '../../src/shared/fixtures/media-video-v1.json'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VideoStore } from '../data/video-store'
import { MockVideoMediaGateway } from '../data/mock-video-media-gateway'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'
import { VideoService } from './video-service'
import { videoRequestSchema } from '../../src/shared/video-media'
import { AppError } from '../errors/app-error'

const GATEWAY = 'http://gateway.test'

function subscription(id: string, modelId = 'sep-employee'): Subscription {
  return {
    id,
    subscriptionId: id,
    employeeId: `template-`, 
    name: `employee-${id}`,
    status: 'ACTIVE',
    templateVersion: '1.0.0',
    template: { id: `template-${id}`, name: `template-${id}`, avatar: null },
    allowedModels: [modelId],
    department: null,
    upgradeAvailable: false,
  }
}

const session = {
  async getValidAccessToken() { return 'access-token' },
  getMeta() { return { enterpriseId: 'enterprise-1' } },
}

/** 记下 prepare / invalidate 被调了几次，并给出固定的技能路径。 */
function fakeSkills(): SkillProvisioner & { prepared: () => number; invalidations: () => number } {
  let prepared = 0
  let invalidations = 0
  return {
    prepared: () => prepared,
    invalidations: () => invalidations,
    async prepare() { prepared += 1; return { skillPaths: ['/skills/a'] } },
    invalidate() { invalidations += 1 },
  }
}

describe('resolveEmployeeRuntime（纯函数）', () => {
  it('maps an active subscription to its first allowed model', () => {
    const result = resolveEmployeeRuntime([subscription('sub-a', 'model-x')], 'sub-a', GATEWAY)
    assert.deepEqual(result, {
      subscriptionId: 'sub-a', modelId: 'model-x', gatewayUrl: GATEWAY,
      employeeProfile: {
        name: 'employee-sub-a', position: undefined, functionalCategory: undefined, description: undefined,
      },
    })
  })

  it('copies only the selected employee identity fields for responsibility judgment', () => {
    const selected = {
      ...subscription('sub-b'), position: 'Frontend Developer',
      functionalCategory: 'Engineering', description: 'Build web interfaces',
    }
    const result = resolveEmployeeRuntime([subscription('sub-a'), selected], 'sub-b', GATEWAY)
    assert.deepEqual(result?.employeeProfile, {
      name: selected.name, position: selected.position,
      functionalCategory: selected.functionalCategory, description: selected.description,
    })
    assert.notEqual(result?.employeeProfile, selected)
  })

  it('returns null for an unknown subscription or one with no allowed model', () => {
    assert.equal(resolveEmployeeRuntime([subscription('sub-a')], 'sub-b', GATEWAY), null)
    const noModel = { ...subscription('sub-a'), allowedModels: [] }
    assert.equal(resolveEmployeeRuntime([noModel], 'sub-a', GATEWAY), null)
  })

  it('never touches anything outside its arguments', () => {
    // 同样的入参两次调用必须得到相等的结果——调度循环依赖这一点（C4）。
    const instances = [subscription('sub-a')]
    assert.deepEqual(
      resolveEmployeeRuntime(instances, 'sub-a', GATEWAY),
      resolveEmployeeRuntime(instances, 'sub-a', GATEWAY),
    )
  })
})

describe('C10 — 身份变化丢弃平台目录缓存', () => {
  it('re-fetches the directory after clear(), even inside the TTL window', async () => {
    let fetches = 0
    let served = [subscription('sub-a')]
    // TTL 保持默认 15s，时钟固定：任何重新请求都只能是 invalidate 的结果，不是 TTL 过期。
    const directory = new EmployeeDirectory(async () => { fetches += 1; return served }, 15_000, () => 1_000)
    const skills = fakeSkills()
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)

    await authorizer.refresh()
    assert.equal(fetches, 1)
    assert.ok(authorizer.resolve('sub-a'), '刷新后应能从快照解析出运行配置')

    // 换账号：目录里已经是另一个人的订阅了。
    authorizer.clear()
    served = [subscription('sub-b')]

    assert.equal(authorizer.resolve('sub-a'), null, '清空后不能再解析出上一个身份的员工')
    assert.equal(await authorizer.authorize('sub-b') !== null, true)
    assert.equal(fetches, 2, 'TTL 窗口内也必须重新请求——这正是 C10')
    assert.equal(skills.invalidations(), 1, '技能缓存也要跟着丢')
  })

  it('authorize carries the skill paths, not just the resolved config', async () => {
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const skills = fakeSkills()
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)

    const authorized = await authorizer.authorize('sub-a')

    // 换成 resolve() 的结果会让排队过的 run 静默丢掉技能路径（C4 的注意事项）。
    assert.deepEqual(authorized?.additionalSkillPaths, ['/skills/a'])
    assert.equal(skills.prepared(), 1)
  })

  it('prepares skills using the selected employee identity and subscription', async () => {
    const selectedEmployees = [
      { ...subscription('sub-a'), employeeId: 'employee-a' },
      { ...subscription('sub-b'), employeeId: 'employee-b' },
    ]
    const directory = new EmployeeDirectory(async () => selectedEmployees)
    const requests: Array<Parameters<SkillProvisioner['prepare']>[0]> = []
    const skills: SkillProvisioner = {
      async prepare(input) {
        requests.push(input)
        return { skillPaths: [`/skills/${input.subscriptionId}/${input.employeeId}`] }
      },
      invalidate() {},
    }
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)

    assert.deepEqual((await authorizer.authorize('sub-a'))?.additionalSkillPaths, ['/skills/sub-a/employee-a'])
    assert.deepEqual((await authorizer.authorize('sub-b'))?.additionalSkillPaths, ['/skills/sub-b/employee-b'])
    assert.deepEqual(requests.map(request => ({ subscriptionId: request.subscriptionId, employeeId: request.employeeId })), [
      { subscriptionId: 'sub-a', employeeId: 'employee-a' },
      { subscriptionId: 'sub-b', employeeId: 'employee-b' },
    ])
  })

  it('returns null without preparing skills when the subscription is unknown', async () => {
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const skills = fakeSkills()
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)

    assert.equal(await authorizer.authorize('sub-missing'), null)
    assert.equal(skills.prepared(), 0, '未授权的订阅不该触发技能下载')
  })
})





describe('explicit model selection', () => {
  it('uses only a selected model that the subscription allows', () => {
    const employee = { ...subscription('sub-a'), allowedModels: ['first', 'selected'] }
    assert.equal(resolveEmployeeRuntime([employee], 'sub-a', GATEWAY, 'selected')?.modelId, 'selected')
    assert.equal(resolveEmployeeRuntime([employee], 'sub-a', GATEWAY, 'forbidden'), null)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function runtimeManifest() {
  return {
    manifestVersion: 1, subscriptionId: 'sub-a', templateVersion: 'locked-template',
    employee: { id: 'template-', name: 'Employee', version: 'actual-employee', maxSteps: 10 },
    runtime: { systemPrompt: 'Actual employee prompt', modelId: 'preferred', allowedModels: ['first', 'preferred'],
      skills: [{ capabilityId: 'cap-a', name: 'Orders', description: null as string | null, versionId: 'approved-v1', version: '1.0', content: '# Approved source' }] },
  }
}

function preparedSkill(): PreparedEmployeeSkill {
  const content = '---\nname: cap-a\ndescription: Orders\n---\n# Actual owner source'
  return {
    capabilityId: 'cap-a', versionId: 'local-personal', baseSkillVersionId: 'approved-v1', version: 'personal', source: 'owner-local',
    name: 'cap-a', description: 'Orders', content, sha256: digest(content), path: '/skills/immutable/cap-a',
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('media runtime authorization without skill preparation', () => {
  it('reads current media capabilities without downloading skills or selecting a chat model', async () => {
    const manifest = runtimeManifest()
    const media = { profileId: 'image-profile' }
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: [] }])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, {
      getRuntime: async () => ({ ...manifest, runtime: { ...manifest.runtime, media, video: videoFixture.runtime } }),
    })
    const runtime = await authorizer.authorizeRuntime('sub-a')
    assert.deepEqual(runtime?.media, media)
    assert.deepEqual(runtime?.video, videoFixture.runtime)
    assert.equal(skills.prepared(), 0)
    assert.equal(await authorizer.authorize('sub-a'), null)
  })

  it('refreshes capabilities and invalidates a changed video grant without preparing skills', async () => {
    let video = structuredClone(videoFixture.runtime)
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, {
      getRuntime: async () => ({ ...runtimeManifest(), runtime: { ...runtimeManifest().runtime, video } }),
    })
    await authorizer.authorizeRuntime('sub-a')
    const revision = authorizer.getAuthorizationRevision()
    video = { ...video, executionAvailable: false, tools: [] }
    assert.equal((await authorizer.authorizeRuntime('sub-a'))?.video?.executionAvailable, false)
    assert.ok(authorizer.getAuthorizationRevision() > revision)
    assert.equal(skills.prepared(), 0)
  })

  it('rejects stale runtime results and inactive subscriptions', async () => {
    const runtime = deferred<unknown>(), started = deferred<void>()
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, {
      getRuntime: () => { started.resolve(); return runtime.promise },
    })
    const pending = authorizer.authorizeRuntime('sub-a')
    await started.promise
    authorizer.clear()
    runtime.resolve(runtimeManifest())
    assert.equal(await pending, null)
    const inactive = new EmployeeAuthorizer(session, new EmployeeDirectory(async () => [{ ...subscription('sub-a'), status: 'PAUSED' }]), skills, GATEWAY)
    assert.equal(await inactive.authorizeRuntime('sub-a'), null)
    assert.equal(skills.prepared(), 0)
  })
})

function artifactManifest() {
  const manifest = runtimeManifest()
  const content = '---\nname: cap-a\ndescription: Orders\n---\n# Approved source\n'
  const artifact: SkillArtifactAvailable = {
    protocolVersion: 1, status: 'AVAILABLE', capabilityId: 'cap-a', versionId: 'approved-v1',
    approvedContentSha256: digest(content), format: 'single-file', installationDirectory: 'cap-a',
    entryPath: 'SKILL.md', entrySha256: digest(content), artifactSha256: digest(content),
    byteLength: Buffer.byteLength(content), fileCount: 1,
    downloadPath: '/client/subscriptions/sub-a/skills/cap-a/versions/approved-v1/artifact',
  }
  return { ...manifest, runtime: { ...manifest.runtime, skillArtifactProtocolVersion: 1 as const,
    skills: [{ ...manifest.runtime.skills[0]!, content, artifact }] } }
}

function approvedPreparedSkill(manifest = artifactManifest()): PreparedEmployeeSkill & { artifact: SkillArtifactAvailable } {
  const runtime = manifest.runtime.skills[0]!
  return { ...preparedSkill(), source: 'approved', versionId: `platform-${runtime.versionId}`,
    baseSkillVersionId: runtime.versionId, version: runtime.version, content: runtime.content,
    sha256: digest(runtime.content), artifact: { ...runtime.artifact } }
}

function artifactAuthorizer(
  manifest: unknown,
  prepare: SkillProvisioner['prepare'],
  currentSession = session,
) {
  const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
  return new EmployeeAuthorizer(currentSession, directory, { prepare, invalidate() {} }, GATEWAY, {
    async getRuntime() { return manifest },
  })
}

function videoAuthorizer() {
  const base = artifactManifest()
  const manifest = { ...base, runtime: { ...base.runtime, video: structuredClone(videoFixture.runtime) as unknown } }
  const actual = approvedPreparedSkill(manifest)
  const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths: [actual.path], skills: [actual] }))
  return { manifest, authorizer }
}

async function videoAuthorizationHost(authorizer: EmployeeAuthorizer, overrides: Partial<MockVideoHostOptions> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-authorization-'))
  const gateway = new MockVideoMediaGateway()
  const effects = { imports: 0, exports: 0 }
  const store = new VideoStore(root)
  const archive = new VideoService({ scope: { enterpriseId: 'enterprise-1', memberId: 'member-1', subscriptionId: 'sub-a' },
    store, gateway: new MockVideoMediaGateway() })
  let saved = await archive.generate('task-a', videoRequestSchema.parse(videoFixture.quoteRequest))
  saved = await archive.resume('task-a', saved.jobId)
  saved = await archive.resume('task-a', saved.jobId)
  archive.close()
  const host = new MockVideoHostService({
    mock: true, scope: { currentScope: () => ({ enterpriseId: 'enterprise-1', memberId: 'member-1' }) },
    store, getTask: async () => ({ subscriptionId: 'sub-a' }),
    authorize: async id => (await authorizer.authorize(id))?.video,
    authorizationRevision: () => authorizer.getAuthorizationRevision(),
    localAuthorizationRevision: () => authorizer.getLocalAuthorizationRevision(),
    recoveryAuthorizationRevision: () => authorizer.getRecoveryAuthorizationRevision(),
    localRuntime: id => authorizer.resolveVideo(id),
    authorizeRecovery: async id => { if (!await authorizer.authorizeRecovery(id)) throw new AppError('PERMISSION_DENIED') },
    gateway: () => ({
      quote: gateway.quote.bind(gateway), submit: gateway.submit.bind(gateway),
      findReceipt: gateway.findReceipt.bind(gateway), getReceipt: gateway.getReceipt.bind(gateway), content: gateway.content.bind(gateway),
      uploadReference: async () => { throw new Error('Unexpected reference upload') },
    }),
    readReference: async () => { throw new Error('Unexpected reference read') },
    references: { list: async () => [], import: async () => { effects.imports++; return [] } },
    exportOutput: async () => { effects.exports++ }, requestApproval: async () => true,
    ...overrides,
  })
  return { host, gateway, effects, store, saved, async dispose() { await host.stopAll(); await rm(root, { recursive: true, force: true }) } }
}

describe('observed video authorization revision', () => {
  it('keeps catalog edits outside the local ownership fence while retaining the execution fence', async () => {
    const { manifest, authorizer } = videoAuthorizer()
    assert.ok(await authorizer.authorize('sub-a'))
    const local = authorizer.getLocalAuthorizationRevision()
    const execution = authorizer.getAuthorizationRevision()
    for (const video of [
      { ...videoFixture.runtime, profiles: [{ ...videoFixture.runtime.profiles[0], configVersion: 'updated-version' }] },
      { ...videoFixture.runtime, defaultProfileId: null },
      { ...videoFixture.runtime, executionAvailable: false, profiles: [], tools: [], defaultProfileId: null },
      undefined,
    ]) {
      manifest.runtime.video = video
      assert.ok(await authorizer.authorize('sub-a'))
      assert.equal(authorizer.getLocalAuthorizationRevision(), local)
    }
    assert.ok(authorizer.getAuthorizationRevision() > execution)
    assert.equal(authorizer.resolveVideo('sub-a'), undefined)
    authorizer.clear()
    assert.equal(authorizer.getLocalAuthorizationRevision(), local + 1)
  })

  it('observes directory grant removal and employee replacement but ignores model and display edits', async () => {
    let served = [subscription('sub-a')]
    const directory = new EmployeeDirectory(async () => served)
    const authorizer = new EmployeeAuthorizer(session, directory, fakeSkills(), GATEWAY)
    assert.equal(await authorizer.authorizeRecovery('sub-a'), true)
    assert.equal(authorizer.getLocalAuthorizationRevision(), 0)
    served = [{ ...served[0]!, name: 'Renamed', allowedModels: [] }]
    await authorizer.refresh()
    assert.equal(await authorizer.authorizeRecovery('sub-a'), true, 'Original receipts do not select a current chat model')
    assert.equal(authorizer.getLocalAuthorizationRevision(), 0)
    served = [{ ...served[0]!, employeeId: 'replacement-employee' }]
    await authorizer.refresh()
    assert.equal(authorizer.getLocalAuthorizationRevision(), 0)
    assert.equal(authorizer.getRecoveryAuthorizationRevision(), 1)
    served = []
    await authorizer.refresh()
    assert.equal(await authorizer.authorizeRecovery('sub-a'), false)
    assert.equal(authorizer.getLocalAuthorizationRevision(), 0)
    assert.equal(authorizer.getRecoveryAuthorizationRevision(), 2)
    await authorizer.refresh()
    assert.equal(authorizer.getRecoveryAuthorizationRevision(), 2, 'Repeated missing grants do not churn the fence')
  })

  it('preserves local ownership on directory denial and advances only the network recovery fence', async () => {
    let failure: AppError | undefined
    const directory = new EmployeeDirectory(async () => { if (failure) throw failure; return [subscription('sub-a')] })
    const authorizer = new EmployeeAuthorizer(session, directory, fakeSkills(), GATEWAY)
    await authorizer.refresh()
    failure = new AppError('NETWORK_ERROR')
    await assert.rejects(authorizer.refresh(), { code: 'NETWORK_ERROR' })
    assert.equal(authorizer.getLocalAuthorizationRevision(), 0)
    failure = new AppError('PERMISSION_DENIED')
    await assert.rejects(authorizer.refresh(), { code: 'PERMISSION_DENIED' })
    assert.equal(authorizer.getLocalAuthorizationRevision(), 0)
    assert.equal(authorizer.getRecoveryAuthorizationRevision(), 1)
    await assert.rejects(authorizer.refresh(), { code: 'PERMISSION_DENIED' })
    assert.equal(authorizer.getRecoveryAuthorizationRevision(), 1)
  })

  it('continues original tracking across an observed capability edit without resubmitting', async t => {
    const { manifest, authorizer } = videoAuthorizer()
    await authorizer.authorize('sub-a')
    const f = await videoAuthorizationHost(authorizer, { tracker: { floorMs: 1 } })
    t.after(f.dispose)
    const scope = f.saved.scope
    const original = new VideoService({ scope, store: f.store, gateway: f.gateway })
    const pending = await original.generate('task-a', videoRequestSchema.parse(videoFixture.quoteRequest))
    original.close()
    const getReceipt = f.gateway.getReceipt.bind(f.gateway)
    let changed = false
    t.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof getReceipt>) => {
      if (!changed) {
        changed = true
        manifest.runtime.video = { ...videoFixture.runtime, executionAvailable: false, profiles: [], tools: [], defaultProfileId: null }
        await authorizer.authorize('sub-a')
      }
      return getReceipt(...args)
    })
    await f.host.track('task-a')
    const restored = await f.store.getJob(scope, 'task-a', pending.jobId)
    assert.equal(restored?.saveStatus, 'SAVED')
    assert.deepEqual(restored?.request, pending.request)
    assert.equal(f.gateway.calls.submit, 1); assert.equal(f.gateway.calls.quote, 1)
    assert.equal(authorizer.getLocalAuthorizationRevision(), 0)
    assert.equal(authorizer.getAuthorizationRevision(), 1)
  })

  it('persists observed employee revocation, preserves local bytes, and requires explicit recovery after restoration', async t => {
    const base = artifactManifest()
    const manifest = { ...base, runtime: { ...base.runtime, skills: [], video: videoFixture.runtime } }
    let served = [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }]
    const directory = new EmployeeDirectory(async () => served)
    const authorizer = new EmployeeAuthorizer(session, directory, { async prepare() { return { skillPaths: [], skills: [] } }, invalidate() {} }, GATEWAY,
      { async getRuntime() { return manifest } })
    await authorizer.authorize('sub-a')
    const f = await videoAuthorizationHost(authorizer, { tracker: { floorMs: 1 } })
    t.after(f.dispose)
    const original = new VideoService({ scope: f.saved.scope, store: f.store, gateway: f.gateway })
    const pending = await original.generate('task-a', videoRequestSchema.parse(videoFixture.quoteRequest))
    original.close()
    served = []
    await authorizer.refresh()
    await f.host.track('task-a')
    assert.equal((await f.store.getJob(f.saved.scope, 'task-a', pending.jobId))?.trackingStatus, 'AUTH_REQUIRED')
    assert.equal(f.gateway.calls.getReceipt, 0)
    const selection = await f.host.nativeSelection('task-a')
    await selection.export(f.saved.jobId, f.saved.receipt!.outputs[0].outputId, '/native/saved.mp4')
    served = [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }]
    await authorizer.refresh()
    await f.host.track('task-a')
    assert.equal(f.gateway.calls.getReceipt, 0, 'Restoration must not automatically resume a persisted grant failure')
    await f.host.resume('task-a', pending.jobId)
    await f.host.track('task-a')
    assert.equal((await f.store.getJob(f.saved.scope, 'task-a', pending.jobId))?.saveStatus, 'SAVED')
    assert.equal(f.gateway.calls.submit, 1)
  })

  it('normalizes video sets, response object order and shared-schema defaults without invalidating leases', async () => {
    const { manifest, authorizer } = videoAuthorizer()
    const video = structuredClone(videoFixture.runtime)
    video.profiles.push({ ...structuredClone(video.profiles[0]!), profileId: 'second-video-profile' })
    video.profiles[0]!.capabilities.durationsSeconds = [5, 10]
    manifest.runtime.video = video
    assert.ok(await authorizer.authorize('sub-a'))
    const revision = authorizer.getAuthorizationRevision()
    function reorder(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reorder).reverse()
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)]))
      return value
    }
    const equivalent = structuredClone(video)
    equivalent.tools.push('video_get_job')
    equivalent.profiles[0]!.capabilities.durationsSeconds.push(5)
    // The shared validator restores this default before computing the fingerprint.
    const { supportsTextToVideo: _default, ...capabilities } = equivalent.profiles[0]!.capabilities
    manifest.runtime.video = reorder({ ...equivalent, profiles: [{ ...equivalent.profiles[0], capabilities }, equivalent.profiles[1]] })
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), revision)
  })

  it('advances once per observed policy or profile change, including disabled and missing video', async () => {
    for (const video of [
      { ...videoFixture.runtime, tools: [] },
      { ...videoFixture.runtime, executionAvailable: false, tools: [] },
      undefined,
      { ...videoFixture.runtime, protocolVersion: 2 },
      { ...videoFixture.runtime, profiles: [{ ...videoFixture.runtime.profiles[0], configVersion: 'changed-config' }] },
      { ...videoFixture.runtime, profiles: [{ ...videoFixture.runtime.profiles[0], capabilities: {
        ...videoFixture.runtime.profiles[0]!.capabilities, maxInputBytes: 1024,
      } }] },
    ]) {
      const { manifest, authorizer } = videoAuthorizer()
      assert.ok(await authorizer.authorize('sub-a'))
      assert.equal(authorizer.getAuthorizationRevision(), 0, 'First observation must not invalidate its own lease')
      manifest.runtime.video = video
      assert.ok(await authorizer.authorize('sub-a'))
      assert.equal(authorizer.getAuthorizationRevision(), 1)
      assert.ok(await authorizer.authorize('sub-a'))
      assert.equal(authorizer.getAuthorizationRevision(), 1, 'Identical rechecks must not self-invalidate')
      manifest.runtime.video = videoFixture.runtime
      assert.ok(await authorizer.authorize('sub-a'))
      assert.equal(authorizer.getAuthorizationRevision(), 2)
    }
  })

  it('keeps absent/invalid video and ordinary chat, image media, model and skill changes outside the video fence', async () => {
    const { manifest, authorizer } = videoAuthorizer()
    manifest.runtime.video = undefined
    assert.ok(await authorizer.authorize('sub-a'))
    manifest.runtime.video = { protocolVersion: 2, apiKey: 'private' }
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), 0)
    manifest.runtime.video = videoFixture.runtime
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), 1)
    manifest.runtime.systemPrompt = 'Changed chat instructions'
    manifest.runtime.modelId = 'first'
    manifest.runtime.allowedModels.reverse()
    manifest.templateVersion = 'changed-template'
    manifest.employee.version = 'changed-employee'
    manifest.employee.maxSteps++
    manifest.runtime.skills[0]!.description = 'Changed skill description'
    Object.assign(manifest.runtime, { media: { protocolVersion: 2 } })
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), 1)
    authorizer.clear()
    manifest.runtime.video = undefined
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), 2, 'clear must discard the previous fingerprint')
  })

  it('tracks first observations separately per subscription', async () => {
    const videos = new Map<string, unknown>([['sub-a', videoFixture.runtime], ['sub-b', undefined]])
    const directory = new EmployeeDirectory(async () => ['sub-a', 'sub-b'].map(id => ({ ...subscription(id), allowedModels: ['first', 'preferred'] })))
    const authorizer = new EmployeeAuthorizer(session, directory, { async prepare() { return { skillPaths: [], skills: [] } }, invalidate() {} }, GATEWAY, {
      async getRuntime(id) {
        const base = runtimeManifest()
        return { ...base, subscriptionId: id, runtime: { ...base.runtime, skills: [], video: videos.get(id) } }
      },
    })
    assert.ok(await authorizer.authorize('sub-a'))
    assert.ok(await authorizer.authorize('sub-b'))
    assert.equal(authorizer.getAuthorizationRevision(), 0)
    videos.set('sub-b', videoFixture.runtime)
    assert.ok(await authorizer.authorize('sub-b'))
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), 1)
    videos.set('sub-a', undefined)
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), 2)
  })

  it('observes revocation before failing skill preparation without altering in-flight captureScope generation', async () => {
    const base = artifactManifest()
    const manifest = { ...base, runtime: { ...base.runtime, video: videoFixture.runtime as unknown } }
    const actual = approvedPreparedSkill(manifest)
    const started = deferred<void>(), gate = deferred<void>()
    let preparations = 0, guard: (() => boolean) | undefined
    const authorizer = artifactAuthorizer(manifest, async input => {
      if (++preparations === 1) {
        guard = input.isCurrent
        started.resolve()
        await gate.promise
      } else throw new Error('Skill preparation unavailable')
      return { skillPaths: [actual.path], skills: [actual] }
    })
    const original = authorizer.authorize('sub-a')
    await started.promise
    manifest.runtime.video = undefined
    await assert.rejects(authorizer.authorize('sub-a'), /Skill preparation unavailable/)
    assert.equal(authorizer.getAuthorizationRevision(), 1)
    assert.equal(guard?.(), true, 'Video changes must not invalidate chat/skill scope generation')
    gate.resolve()
    assert.ok((await original)?.video)
    assert.equal(authorizer.getAuthorizationRevision(), 1, 'Completing old skill IO must not restore an old fingerprint')
  })

  it('ignores mismatched and malformed runtime responses when observing video policy', async () => {
    const { manifest, authorizer } = videoAuthorizer()
    assert.ok(await authorizer.authorize('sub-a'))
    manifest.runtime.video = undefined
    manifest.employee.id = 'wrong-employee'
    await assert.rejects(authorizer.authorize('sub-a'), /identity mismatch/)
    manifest.employee.id = 'template-'
    manifest.employee.maxSteps = 0
    await assert.rejects(authorizer.authorize('sub-a'), /Invalid employee runtime manifest/)
    assert.equal(authorizer.getAuthorizationRevision(), 0)
    manifest.employee.maxSteps = 10
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), 1)
  })

  for (const operation of ['import', 'export'] as const) {
    it(`rejects an old native ${operation} lease after identity invalidation during the dialog wait`, async t => {
      const { authorizer } = videoAuthorizer()
      const f = await videoAuthorizationHost(authorizer)
      t.after(f.dispose)
      const selection = await f.host.nativeSelection('task-a')
      const dialog = deferred<void>(), waiting = deferred<void>()
      const pending = (async () => {
        waiting.resolve()
        await dialog.promise
        if (operation === 'import') return selection.import(['/native/reference.png'])
        return selection.export(f.saved.jobId, f.saved.receipt!.outputs[0].outputId, '/native/output.mp4')
      })()
      const rejected = assert.rejects(pending, { code: 'AUTH_REQUIRED' })
      await waiting.promise
      authorizer.clear()
      assert.ok(await authorizer.authorize('sub-a'))
      dialog.resolve()
      await rejected
      assert.deepEqual(f.effects, { imports: 0, exports: 0 })
      assert.equal(f.gateway.calls.submit, 0)
    })
  }

  it('rejects a pending approval when another authorize observes disabled video before reference upload', async t => {
    const { manifest, authorizer } = videoAuthorizer()
    const approval = deferred<void>(), waiting = deferred<void>()
    const f = await videoAuthorizationHost(authorizer, {
      requestApproval: async () => { waiting.resolve(); await approval.promise; return true },
    })
    t.after(f.dispose)
    const { profileId, operation, creativeBrief, parameters } = videoFixture.quoteRequest
    const pending = f.host.generate('task-a', {
      profileId, operation: operation as 'image-to-video', creativeBrief,
      parameters: { ...parameters, resolution: '720p', outputFormat: 'video/mp4' }, localAssetIds: ['asset-a'],
    })
    const rejected = assert.rejects(pending, { code: 'AUTH_REQUIRED' })
    await waiting.promise
    manifest.runtime.video = { ...videoFixture.runtime, executionAvailable: false, tools: [] }
    assert.ok(await authorizer.authorize('sub-a'))
    approval.resolve()
    await rejected
    assert.equal(f.gateway.calls.quote, 0)
    assert.equal(f.gateway.calls.submit, 0)
  })

  it('preserves an export commit after another authorize observes a profile configuration change', async t => {
    const { manifest, authorizer } = videoAuthorizer()
    const exporting = deferred<void>(), waiting = deferred<void>()
    let commits = 0
    const f = await videoAuthorizationHost(authorizer, {
      exportOutput: async (_scope, _task, _job, _output, _path, _signal, validate) => {
        waiting.resolve()
        await exporting.promise
        validate()
        commits++
      },
    })
    t.after(f.dispose)
    const selection = await f.host.nativeSelection('task-a')
    const pending = selection.export(f.saved.jobId, f.saved.receipt!.outputs[0].outputId, '/native/output.mp4')
    await waiting.promise
    manifest.runtime.video = { ...videoFixture.runtime, profiles: [{ ...videoFixture.runtime.profiles[0], configVersion: 'new-config' }] }
    assert.ok(await authorizer.authorize('sub-a'))
    exporting.resolve()
    await pending
    assert.equal(commits, 1)
  })

  it('keeps a native lease usable when another authorize observes only chat changes', async t => {
    const { manifest, authorizer } = videoAuthorizer()
    const f = await videoAuthorizationHost(authorizer)
    t.after(f.dispose)
    const selection = await f.host.nativeSelection('task-a')
    manifest.runtime.systemPrompt = 'Updated chat prompt'
    manifest.runtime.modelId = 'first'
    manifest.employee.maxSteps++
    assert.ok(await authorizer.authorize('sub-a'))
    await selection.import(['/native/reference.png'])
    await selection.export(f.saved.jobId, f.saved.receipt!.outputs[0].outputId, '/native/output.mp4')
    assert.deepEqual(f.effects, { imports: 1, exports: 1 })
    assert.equal(authorizer.getAuthorizationRevision(), 0)
  })
})

describe('approved skill artifact authorization', () => {
  it('passes the negotiated protocol and freezes the complete approved descriptor and entry', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    const authorizer = artifactAuthorizer(manifest, async input => {
      assert.equal(input.skillArtifactProtocolVersion, 1)
      assert.deepEqual(input.runtimeSkills, manifest.runtime.skills)
      return { skillPaths: [actual.path], skills: [actual] }
    })
    const result = await authorizer.authorize('sub-a')
    assert.equal(result?.runtimeSnapshot?.skillArtifactProtocolVersion, 1)
    assert.deepEqual(result?.runtimeSnapshot?.approvedSkills[0]?.artifact, manifest.runtime.skills[0]!.artifact)
    assert.deepEqual(result?.runtimeSnapshot?.skills[0]?.artifact, actual.artifact)
    assert.ok(Object.isFrozen(result?.runtimeSnapshot?.skills[0]?.artifact))
    assert.ok(Object.isFrozen(result?.runtimeSnapshot?.approvedSkills[0]?.artifact))
    actual.artifact.entrySha256 = 'b'.repeat(64)
    manifest.runtime.skills[0]!.artifact.artifactSha256 = 'c'.repeat(64)
    const frozenArtifact = result?.runtimeSnapshot?.skills[0]?.artifact
    assert.equal(frozenArtifact?.status, 'AVAILABLE')
    assert.notEqual(frozenArtifact?.status === 'AVAILABLE' ? frozenArtifact.entrySha256 : undefined, actual.artifact.entrySha256)
    assert.notEqual(result?.runtimeSnapshot?.approvedSkills[0]?.artifact?.artifactSha256, manifest.runtime.skills[0]!.artifact.artifactSha256)
  })

  it('does not let the provisioner replace the authorized version or descriptor before freezing', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    const authorizer = artifactAuthorizer(manifest, async input => {
      assert.throws(() => { input.runtimeSkills![0]!.versionId = 'substituted-version' }, TypeError)
      const artifact = input.runtimeSkills![0]!.artifact as SkillArtifactAvailable
      assert.throws(() => { artifact.artifactSha256 = 'b'.repeat(64) }, TypeError)
      return { skillPaths: [actual.path], skills: [actual] }
    })
    assert.ok(await authorizer.authorize('sub-a'))
  })

  it('rejects missing, blocked, mismatched or unnegotiated descriptors before skill IO', async () => {
    const manifest = artifactManifest()
    const skill = manifest.runtime.skills[0]!
    const { artifact: _artifact, ...withoutArtifact } = skill
    const { skillArtifactProtocolVersion: _protocol, ...withoutProtocol } = manifest.runtime
    const invalidRuntimes = [
      { ...manifest.runtime, skills: [withoutArtifact] },
      { ...withoutProtocol, skills: [skill] },
      { ...manifest.runtime, skills: [{ ...skill, artifact: {
        protocolVersion: 1, status: 'BLOCKED', capabilityId: skill.capabilityId, versionId: skill.versionId,
        approvedContentSha256: skill.artifact.approvedContentSha256, reason: 'PACKAGE_REQUIRED',
      } }] },
      ...[
        { capabilityId: 'cap-other' }, { versionId: 'approved-other' },
        { approvedContentSha256: digest(skill.content.trim()) },
      ].map(patch => ({ ...manifest.runtime, skills: [{ ...skill, artifact: { ...skill.artifact, ...patch } }] })),
    ]
    let preparations = 0
    for (const runtime of invalidRuntimes) {
      const authorizer = artifactAuthorizer({ ...manifest, runtime }, async () => {
        preparations++
        return { skillPaths: [], skills: [] }
      })
      await assert.rejects(authorizer.authorize('sub-a'), /artifact|manifest/i)
    }
    assert.equal(preparations, 0)
  })

  it('preserves protocol negotiation for employees without skills and never downgrades a failed download', async () => {
    const manifest = artifactManifest()
    const empty = { ...manifest, runtime: { ...manifest.runtime, skills: [] } }
    const authorizer = artifactAuthorizer(empty, async input => {
      assert.equal(input.skillArtifactProtocolVersion, 1)
      assert.deepEqual(input.runtimeSkills, [])
      return { skillPaths: [], skills: [] }
    })
    assert.equal((await authorizer.authorize('sub-a'))?.runtimeSnapshot?.skillArtifactProtocolVersion, 1)
    let downloads = 0
    const failed = artifactAuthorizer(manifest, async () => {
      downloads++
      throw new Error('Artifact download denied.')
    })
    await assert.rejects(failed.authorize('sub-a'), /Artifact download denied/)
    assert.equal(downloads, 1)
  })

  it('rejects a prepared approved entry from another version or with forged content', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    for (const patch of [
      { baseSkillVersionId: 'approved-other' }, { version: 'another-label' },
      { sha256: 'b'.repeat(64) }, { content: `${actual.content}changed` },
      { content: `${actual.content}changed`, sha256: digest(`${actual.content}changed`) },
      { artifact: undefined },
    ]) {
      const forged = { ...actual, ...patch }
      const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths: [forged.path], skills: [forged] }))
      await assert.rejects(authorizer.authorize('sub-a'), /prepared|artifact/i)
    }
  })

  it('requires every field of the complete prepared descriptor to match the approved descriptor', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    const artifact = actual.artifact!
    const descriptorChanges: Partial<SkillArtifactAvailable>[] = [
      { capabilityId: 'cap-other' }, { versionId: 'approved-other' },
      { approvedContentSha256: 'b'.repeat(64) }, { format: 'zip' },
      { installationDirectory: 'another-name' }, { entryPath: 'nested/SKILL.md' },
      { entrySha256: 'b'.repeat(64) }, { artifactSha256: 'b'.repeat(64) },
      { byteLength: artifact.byteLength + 1 }, { fileCount: artifact.fileCount + 1 },
      { downloadPath: '/client/subscriptions/sub-other/skills/cap-a/versions/approved-v1/artifact' },
    ]
    for (const change of descriptorChanges) {
      const forged = { ...actual, artifact: { ...artifact, ...change } }
      const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths: [forged.path], skills: [forged] }))
      await assert.rejects(authorizer.authorize('sub-a'), /prepared|artifact/i, JSON.stringify(change))
    }
  })

  it('allows owner-local content but never labels an approved descriptor as owner-local', async () => {
    const manifest = artifactManifest()
    const local = preparedSkill()
    const authorizer = artifactAuthorizer(manifest, async input => {
      assert.equal(input.skillArtifactProtocolVersion, 1)
      return { skillPaths: [local.path], skills: [local] }
    })
    const result = await authorizer.authorize('sub-a')
    assert.equal(result?.runtimeSnapshot?.skills[0]?.source, 'owner-local')
    assert.equal(result?.runtimeSnapshot?.skills[0]?.artifact, undefined)
    assert.deepEqual(result?.runtimeSnapshot?.approvedSkills[0]?.artifact, manifest.runtime.skills[0]!.artifact)
    for (const forged of [
      { ...local, artifact: manifest.runtime.skills[0]!.artifact },
      { ...local, sha256: 'b'.repeat(64) },
    ]) {
      const invalid = artifactAuthorizer(manifest, async () => ({ skillPaths: [forged.path], skills: [forged] }))
      await assert.rejects(invalid.authorize('sub-a'), /prepared|artifact/i)
    }
  })

  it('requires a one-to-one correspondence between approved skills, prepared entries and execution paths', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    for (const skillPaths of [[actual.path, '/skills/unapproved'], [actual.path, actual.path], []]) {
      const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths, skills: [actual] }))
      await assert.rejects(authorizer.authorize('sub-a'), /not fully prepared/)
    }
    const second = { ...manifest.runtime.skills[0]!, capabilityId: 'cap-b', versionId: 'approved-v2',
      artifact: { ...manifest.runtime.skills[0]!.artifact, capabilityId: 'cap-b', versionId: 'approved-v2',
        downloadPath: '/client/subscriptions/sub-a/skills/cap-b/versions/approved-v2/artifact' } }
    const secondActual = { ...actual, capabilityId: 'cap-b', baseSkillVersionId: 'approved-v2', artifact: second.artifact }
    const twoSkills = { ...manifest, runtime: { ...manifest.runtime, skills: [...manifest.runtime.skills, second] } }
    for (const skills of [[actual, actual], [actual, secondActual]]) {
      const authorizer = artifactAuthorizer(twoSkills, async () => ({ skillPaths: skills.map(skill => skill.path), skills }))
      await assert.rejects(authorizer.authorize('sub-a'), /not fully prepared/)
    }
    const empty = { ...manifest, runtime: { ...manifest.runtime, skills: [] } }
    await assert.rejects(artifactAuthorizer(empty, async () => ({ skillPaths: ['/skills/unapproved'], skills: [] })).authorize('sub-a'), /not fully prepared/)
  })

  it('rejects stale approved versions even on the legacy path', async () => {
    const actual = { ...preparedSkill(), source: 'approved' as const, baseSkillVersionId: 'another-approved-version' }
    const authorizer = artifactAuthorizer(runtimeManifest(), async () => ({ skillPaths: [actual.path], skills: [actual] }))
    await assert.rejects(authorizer.authorize('sub-a'), /not fully prepared/)
  })

  it('drops successful and failed artifact downloads after a member or generation change', async () => {
    for (const change of ['member', 'generation']) {
      for (const fail of [false, true]) {
        const manifest = artifactManifest()
        const actual = approvedPreparedSkill(manifest)
        const download = deferred<void>()
        const started = deferred<void>()
        let meta = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
        let guard: (() => boolean) | undefined
        const authorizer = artifactAuthorizer(manifest, async input => {
          guard = input.isCurrent
          started.resolve()
          await download.promise
          if (fail) throw new Error('Artifact download failed.')
          return { skillPaths: [actual.path], skills: [actual] }
        }, { ...session, getMeta: () => meta })
        const pending = authorizer.authorize('sub-a')
        await started.promise
        if (change === 'member') meta = { ...meta, memberId: 'member-2' }
        else authorizer.clear()
        assert.equal(guard?.(), false)
        download.resolve()
        assert.equal(await pending, null)
      }
    }
  })
})

describe('C1 employee runtime preparation', () => {
  it('carries a cloned, deeply frozen video policy in both the config and runtime snapshot', async () => {
    const video = structuredClone(videoFixture.runtime)
    const base = artifactManifest()
    const manifest = { ...base, runtime: { ...base.runtime, video } }
    const actual = approvedPreparedSkill(manifest)
    const authorizer = artifactAuthorizer(manifest, async () => {
      video.profiles[0]!.capabilities.durationsSeconds[0] = 600
      video.tools.length = 0
      return { skillPaths: [actual.path], skills: [actual] }
    })
    const result = await authorizer.authorize('sub-a')
    assert.deepEqual(result?.video, videoFixture.runtime)
    assert.equal(result?.video, result?.runtimeSnapshot?.video)
    assert.equal(result?.runtimeSnapshot?.skillArtifactProtocolVersion, 1)
    assert.equal(employeeRuntimeSnapshotSchema.safeParse(result?.runtimeSnapshot).success, true)
    function assertFrozen(value: unknown): void {
      if (value === null || typeof value !== 'object') return
      assert.ok(Object.isFrozen(value))
      for (const child of Object.values(value)) assertFrozen(child)
    }
    assertFrozen(result?.video)
    assert.throws(() => result!.video!.tools.push('video_cancel_job'), TypeError)
  })

  it('omits absent, invalid, newer or private video policies without dropping authorization', async () => {
    const base = artifactManifest()
    const actual = approvedPreparedSkill(base)
    for (const video of [undefined, null, { protocolVersion: 2 },
      { ...videoFixture.runtime, protocolVersion: undefined },
      { ...videoFixture.runtime, executionAvailable: false },
      { ...videoFixture.runtime, apiKey: 'private-video-secret' },
      { ...videoFixture.runtime, profiles: [{ ...videoFixture.runtime.profiles[0], modelId: 'private-video-model' }] },
    ]) {
      const manifest = { ...base, runtime: { ...base.runtime, video } }
      const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths: [actual.path], skills: [actual] }))
      const result = await authorizer.authorize('sub-a')
      assert.ok(result)
      assert.equal(result.video, undefined)
      assert.equal(result.runtimeSnapshot?.video, undefined)
      assert.equal(result.modelId, 'preferred')
      assert.equal(result.runtimeSnapshot?.skillArtifactProtocolVersion, 1)
      assert.equal(JSON.stringify(result).includes('private-video'), false)
    }
  })

  it('keeps the authorization revision stable across repeated successful runtime checks and advances on clear', async () => {
    const manifest = { ...artifactManifest(), runtime: { ...artifactManifest().runtime, video: videoFixture.runtime } }
    const actual = approvedPreparedSkill(manifest)
    const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths: [actual.path], skills: [actual] }))
    const revision = authorizer.getAuthorizationRevision()
    assert.equal(typeof revision, 'number')
    assert.ok(await authorizer.authorize('sub-a'))
    await authorizer.list()
    await authorizer.refresh()
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), revision)
    authorizer.clear()
    assert.equal(authorizer.getAuthorizationRevision(), revision + 1)
    assert.ok(await authorizer.authorize('sub-a'))
    assert.equal(authorizer.getAuthorizationRevision(), revision + 1)
    authorizer.clear()
    assert.equal(authorizer.getAuthorizationRevision(), revision + 2)
  })

  it('discards video authorization after a clear or member change during runtime fetch or preparation', async () => {
    for (const phase of ['runtime', 'skills']) {
      for (const change of ['clear', 'member']) {
        const base = artifactManifest()
        const manifest = { ...base, runtime: { ...base.runtime, video: videoFixture.runtime } }
        const actual = approvedPreparedSkill(manifest)
        const gate = deferred<void>()
        const started = deferred<void>()
        let meta = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
        const currentSession = { ...session, getMeta: () => meta }
        let preparations = 0
        let guard: (() => boolean) | undefined
        const skills: SkillProvisioner = {
          async prepare(input) {
            preparations++
            guard = input.isCurrent
            if (phase === 'skills') { started.resolve(); await gate.promise }
            return { skillPaths: [actual.path], skills: [actual] }
          },
          invalidate() {},
        }
        const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
        const authorizer = new EmployeeAuthorizer(currentSession, directory, skills, GATEWAY, {
          async getRuntime() {
            if (phase === 'runtime') { started.resolve(); await gate.promise }
            return manifest
          },
        })
        const pending = authorizer.authorize('sub-a')
        await started.promise
        const revision = authorizer.getAuthorizationRevision()
        if (change === 'clear') {
          authorizer.clear()
          assert.equal(authorizer.getAuthorizationRevision(), revision + 1)
        } else meta = { ...meta, memberId: 'member-2' }
        if (guard) assert.equal(guard(), false)
        gate.resolve()
        assert.equal(await pending, null)
        assert.equal(preparations, phase === 'runtime' ? 0 : 1)
      }
    }
  })

  it('uses the runtime prompt/model and snapshots the actual selected skill, not the platform default', async () => {
    const manifest = runtimeManifest()
    const actual = preparedSkill()
    const requests: Array<Parameters<SkillProvisioner['prepare']>[0]> = []
    const skills: SkillProvisioner = {
      async prepare(input) { requests.push(input); return { skillPaths: [actual.path], skills: [actual] } },
      invalidate() {},
    }
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    let runtimeFetches = 0
    const provider: RuntimeProvider = { async getRuntime(id, token) { assert.equal(id, 'sub-a'); assert.equal(token, 'access-token'); runtimeFetches++; return manifest } }
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, provider)
    const result = await authorizer.authorize('sub-a')
    assert.equal(result?.modelId, 'preferred')
    assert.equal(result?.systemPrompt, manifest.runtime.systemPrompt)
    assert.equal(result?.runtimeSnapshot?.templateVersion, 'locked-template')
    assert.equal(result?.runtimeSnapshot?.employeeVersion, 'actual-employee')
    assert.deepEqual(result?.runtimeSnapshot?.skills, [actual])
    assert.deepEqual(requests[0]?.runtimeSkills, manifest.runtime.skills)
    assert.equal(requests[0]?.isCurrent?.(), true)
    assert.equal(employeeRuntimeSnapshotSchema.safeParse(result?.runtimeSnapshot).success, true)
    actual.content = '# Later mutation'
    manifest.runtime.skills[0]!.content = '# Later platform mutation'
    assert.notEqual(result?.runtimeSnapshot?.skills[0]?.content, actual.content)
    assert.notEqual(result?.runtimeSnapshot?.approvedSkills[0]?.content, manifest.runtime.skills[0]?.content)
    assert.equal(Object.isFrozen(result?.runtimeSnapshot?.skills[0]), true)
    authorizer.resolve('sub-a')
    assert.equal(runtimeFetches, 1, 'resolve must not perform runtime IO')
  })

  it('passes raw media without advertising or negotiating a capability', async () => {
    const manifest = runtimeManifest()
    const media = { mock: true }
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    const skills: SkillProvisioner = { async prepare() { return { skillPaths: [], skills: [] } }, invalidate() {} }
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, {
      async getRuntime() { return { ...manifest, runtime: { ...manifest.runtime, skills: [], media } } },
    })
    assert.deepEqual((await authorizer.authorize('sub-a'))?.media, media)
  })

  it('checks selected models against both runtime and directory before skill IO', async () => {
    const manifest = runtimeManifest()
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred', 'directory-only'] }])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, { async getRuntime() { return manifest } })
    assert.equal(await authorizer.authorize('sub-a', 'directory-only'), null)
    manifest.runtime.allowedModels = []
    assert.equal(await authorizer.authorize('sub-a'), null)
    assert.equal(skills.prepared(), 0)
  })

  for (const preferred of ['retired', 'unavailable']) {
    it(`selects a shared default when runtime default ${preferred} is not in the current directory`, async () => {
      const manifest = runtimeManifest()
      manifest.runtime.modelId = preferred
      manifest.runtime.allowedModels = ['retired', 'preferred', 'current']
      manifest.runtime.skills = []
      const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['directory-only', 'current'] }])
      let prepared = 0
      const skills: SkillProvisioner = { async prepare() { prepared++; return { skillPaths: [], skills: [] } }, invalidate() {} }
      const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, { async getRuntime() { return manifest } })
      const employee = await authorizer.authorize('sub-a')
      assert.equal(employee?.modelId, 'current')
      assert.equal(employee?.runtimeSnapshot?.modelId, 'current')
      assert.equal(prepared, 1)
      assert.equal(await authorizer.authorize('sub-a', preferred), null, 'Explicit model choices must not silently fall back')
      assert.equal(prepared, 1)
    })
  }

  it('rejects disjoint model permissions without preparing skills', async () => {
    const manifest = runtimeManifest()
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [subscription('sub-a', 'directory-only')])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, { async getRuntime() { return manifest } })
    assert.equal(await authorizer.authorize('sub-a'), null)
    assert.equal(skills.prepared(), 0)
  })

  it('rejects unsupported or mismatched manifests without preparing skills', async () => {
    const manifest = runtimeManifest()
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    for (const invalid of [
      { ...manifest, manifestVersion: 2 },
      { ...manifest, subscriptionId: 'another-subscription' },
      { ...manifest, employee: { ...manifest.employee, id: 'another-employee' } },
    ]) {
      const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, { async getRuntime() { return invalid } })
      await assert.rejects(authorizer.authorize('sub-a'), /manifest|identity mismatch/)
    }
    assert.equal(skills.prepared(), 0)
  })

  it('fails explicitly when the provisioner omits an approved runtime skill', async () => {
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    const authorizer = new EmployeeAuthorizer(session, directory, fakeSkills(), GATEWAY, { async getRuntime() { return runtimeManifest() } })
    await assert.rejects(authorizer.authorize('sub-a'), /not fully prepared/)
  })

  it('rejects authorization with no scope or an inactive subscription', async () => {
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const noScope = new EmployeeAuthorizer({ ...session, getMeta() { return null } }, directory, skills, GATEWAY)
    assert.equal(await noScope.authorize('sub-a'), null)
    assert.equal(resolveEmployeeRuntime([{ ...subscription('sub-a'), status: 'PAUSED' }], 'sub-a', GATEWAY), null)
    assert.equal(skills.prepared(), 0)
  })

  it('drops results when scope changes while obtaining a token', async () => {
    const token = deferred<string>()
    let meta = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
    let directoryReads = 0
    const directory = new EmployeeDirectory(async () => { directoryReads++; return [subscription('sub-a')] })
    const authorizer = new EmployeeAuthorizer({ getValidAccessToken: () => token.promise, getMeta: () => meta }, directory, fakeSkills(), GATEWAY)
    const pending = authorizer.authorize('sub-a')
    meta = { enterpriseId: 'enterprise-2', memberId: 'member-2' }
    token.resolve('new-token')
    assert.equal(await pending, null)
    assert.equal(directoryReads, 0)
  })

  it('drains old directory requests and never admits old subscriptions into a new account', async () => {
    const oldDirectory = deferred<Subscription[]>()
    const started = deferred<void>()
    let meta = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
    let reads = 0
    const directory = new EmployeeDirectory(async () => {
      reads++
      if (reads === 1) { started.resolve(); return oldDirectory.promise }
      return [subscription('sub-b')]
    })
    const authorizer = new EmployeeAuthorizer({ ...session, getMeta: () => meta }, directory, fakeSkills(), GATEWAY)
    const old = authorizer.authorize('sub-a')
    await started.promise
    authorizer.clear()
    meta = { enterpriseId: 'enterprise-2', memberId: 'member-2' }
    const next = authorizer.authorize('sub-b')
    oldDirectory.resolve([subscription('sub-a')])
    assert.equal(await old, null)
    assert.ok(await next)
    assert.equal(reads, 2)
    assert.equal(authorizer.resolve('sub-a'), null)
    assert.ok(authorizer.resolve('sub-b'))
  })

  it('drops old runtime responses after clear even when the same member signs in again', async () => {
    const runtime = deferred<unknown>()
    const started = deferred<void>()
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    const skills = fakeSkills()
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, {
      getRuntime() { started.resolve(); return runtime.promise },
    })
    const pending = authorizer.authorize('sub-a')
    await started.promise
    authorizer.clear()
    runtime.resolve(runtimeManifest())
    assert.equal(await pending, null)
    assert.equal(skills.prepared(), 0)
    assert.equal(authorizer.resolve('sub-a'), null)
  })

  it('provides an invalidation guard and discards stale skill preparations', async () => {
    const preparation = deferred<{ skillPaths: string[] }>()
    const started = deferred<void>()
    let guard: (() => boolean) | undefined
    const skills: SkillProvisioner = {
      prepare(input) { guard = input.isCurrent; started.resolve(); return preparation.promise }, invalidate() {},
    }
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)
    const pending = authorizer.authorize('sub-a')
    await started.promise
    authorizer.clear()
    assert.equal(guard?.(), false)
    preparation.resolve({ skillPaths: ['/old-account/skill'] })
    assert.equal(await pending, null)
  })
})
