import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillVersion } from '../../common/platform/platform-api'
import { SkillVersionStore } from '../../data/skill-version-store'
import { SkillStore } from './pi-skill-packages'
import type { EmployeeRuntimeSkill } from '../../common/platform/employee-runtime-contract'
import type { SkillArtifactAvailable } from '../../common/platform/skill-artifact-contract'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function skillsPayload(versionId: string, version: string, versions: SkillVersion[] = []) {
  return {
    subscriptionId: 'sub-a',
    canManage: true,
    skills: [{
      capability: { id: 'cap-a', name: 'Orders', description: 'Order operations', type: 'SKILL' },
      currentVersion: {
        id: versionId,
        capabilityId: 'cap-a',
        scope: 'PLATFORM',
        enterpriseId: null,
        version,
        changeSummary: 'updated',
        status: 'PLATFORM_APPROVED',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
      versions,
      upgradeAvailable: false,
    }],
  }
}

function installPlatformMock(state: { versionId: string; version: string; content: string; versions?: SkillVersion[] }): { metadataRequests: () => number; previewRequests: () => number } {
  let metadataRequests = 0
  let previewRequests = 0
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/skills')) {
      metadataRequests += 1
      return jsonResponse(skillsPayload(state.versionId, state.version, state.versions))
    }
    if (path.endsWith(`/skill-versions/${state.versionId}/preview`)) {
      previewRequests += 1
      return jsonResponse({ content: state.content })
    }
    throw new Error(`Unexpected platform request: ${path}`)
  }
  return { metadataRequests: () => metadataRequests, previewRequests: () => previewRequests }
}

async function createStore(): Promise<{ versions: SkillVersionStore; skills: SkillStore }> {
  const root = await mkdtemp(join(tmpdir(), 'sep-skill-store-'))
  const versions = new SkillVersionStore(join(root, 'skill-data'))
  return { versions, skills: new SkillStore(join(root, 'runtime'), versions) }
}

const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
const request = () => ({
  enterpriseId: scope.enterpriseId,
  memberId: scope.memberId,
  subscriptionId: 'sub-a',
  employeeId: 'employee-a',
  accessToken: 'access-token',
})

function personal(): SkillVersion {
  return { id: 'personal-v1', capabilityId: 'cap-a', scope: 'PERSONAL', ownerId: 'member-a',
    version: 'personal', parentVersionId: 'version-v1', status: 'ENTERPRISE_APPROVED' }
}

async function readSkillBody(path: string): Promise<string> {
  const { parseFrontmatter } = await import('@earendil-works/pi-coding-agent')
  return parseFrontmatter(await readFile(join(path, 'SKILL.md'), 'utf8')).body
}

describe('SkillStore', () => {
  function artifactFixture(content = '---\nname: orders\ndescription: Approved order operations\n---\n# Approved\n'): EmployeeRuntimeSkill & { artifact: SkillArtifactAvailable } {
    const hash = createHash('sha256').update(content).digest('hex')
    return { capabilityId: 'cap-a', name: 'Orders', description: 'Orders', versionId: 'version-v1', version: '1.0', content,
      artifact: { protocolVersion: 1, status: 'AVAILABLE', capabilityId: 'cap-a', versionId: 'version-v1',
        approvedContentSha256: hash, format: 'single-file', installationDirectory: 'orders', entryPath: 'SKILL.md',
        entrySha256: hash, artifactSha256: hash, byteLength: Buffer.byteLength(content), fileCount: 1,
        downloadPath: '/client/subscriptions/sub-a/skills/cap-a/versions/version-v1/artifact' } }
  }

  function serveArtifact(skill: ReturnType<typeof artifactFixture>, options: { bytes?: Buffer; status?: number } = {}) {
    let downloads = 0
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/skills')) return jsonResponse(skillsPayload(skill.versionId, skill.version))
      if (path.endsWith('/artifact')) {
        downloads++
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer access-token')
        return new Response(options.bytes ?? Buffer.from(skill.content), { status: options.status ?? 200,
          headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': String(skill.artifact.byteLength),
            'X-SHA256': skill.artifact.artifactSha256 } })
      }
      throw new Error('Negotiated preparation must not preview or downgrade.')
    }
    return () => downloads
  }

  it('installs exact approved bytes, freezes descriptor, and reauthorizes downloads even when cached', async () => {
    const runtime = artifactFixture()
    const downloads = serveArtifact(runtime)
    const { skills } = await createStore()
    const prepared = await skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [runtime] })
    assert.deepEqual(await readFile(join(prepared.skillPaths[0]!, 'SKILL.md')), Buffer.from(runtime.content))
    assert.deepEqual(prepared.skills[0]?.artifact, runtime.artifact)
    assert.equal(prepared.skills[0]?.sha256, runtime.artifact.entrySha256)
    const { loadSkills } = await import('@earendil-works/pi-coding-agent')
    const loaded = loadSkills({ cwd: tmpdir(), agentDir: tmpdir(), skillPaths: prepared.skillPaths, includeDefaults: false })
    assert.deepEqual(loaded.diagnostics, [])
    assert.equal(loaded.skills[0]?.name, runtime.artifact.installationDirectory)
    assert.equal((await skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [runtime] })).skillPaths[0], prepared.skillPaths[0])
    assert.equal(downloads(), 2)
    serveArtifact(runtime, { status: 404 })
    await assert.rejects(skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [runtime] }))
    assert.equal(await readFile(join(prepared.skillPaths[0]!, 'SKILL.md'), 'utf8'), runtime.content)
  })

  it('refuses missing, BLOCKED, foreign, and mismatched approved artifacts without falling back', async () => {
    const runtime = artifactFixture()
    const downloads = serveArtifact(runtime)
    const { skills } = await createStore()
    const { artifact: _artifact, ...missing } = runtime
    await assert.rejects(skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [missing] }), /descriptor is missing/)
    await assert.rejects(skills.prepare({ ...request(), runtimeSkills: [{ ...runtime, artifact: {
      protocolVersion: 1, status: 'BLOCKED', capabilityId: 'cap-a', versionId: 'version-v1',
      approvedContentSha256: runtime.artifact.approvedContentSha256, reason: 'PACKAGE_REQUIRED',
    } }] }), /BLOCKED/)
    await assert.rejects(skills.prepare({ ...request(), runtimeSkills: [{ ...runtime, artifact: { ...runtime.artifact, capabilityId: 'foreign' } }] }), /mismatch/)
    await assert.rejects(skills.prepare({ ...request(), runtimeSkills: [{ ...runtime, content: '# changed' }] }), /mismatch/)
    assert.equal(downloads(), 0)
  })

  it('does not normalize approved CRLF bytes and rejects corrupted immutable entries', async () => {
    const runtime = artifactFixture('---\r\nname: orders\r\ndescription: Orders\r\n---\r\n# Approved\r\n')
    serveArtifact(runtime)
    const { skills } = await createStore()
    const prepared = await skills.prepare({ ...request(), runtimeSkills: [runtime] })
    assert.equal(prepared.skills[0]?.content, runtime.content)
    await writeFile(join(prepared.skillPaths[0]!, 'SKILL.md'), '# changed')
    await assert.rejects(skills.prepare({ ...request(), runtimeSkills: [runtime] }), /integrity mismatch/)
    assert.equal(await readFile(join(prepared.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# changed')
    assert.deepEqual(await readdir(join(prepared.skillPaths[0]!, '..')), ['orders'])
  })

  it('refuses ZIP until safe package installation is implemented', async () => {
    const runtime = artifactFixture()
    const downloads = serveArtifact(runtime)
    const { skills } = await createStore()
    await assert.rejects(skills.prepare({ ...request(), runtimeSkills: [{ ...runtime, artifact: { ...runtime.artifact, format: 'zip' } }] }), /ZIP skill installation is not supported/)
    assert.equal(downloads(), 0)
  })

  it('keeps owner-local content separate from approved artifact provenance', async () => {
    const runtime = artifactFixture()
    const downloads = serveArtifact(runtime)
    const { skills, versions } = await createStore()
    const local = await versions.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a',
      baseSkillVersionId: 'version-v1', version: 'Owner', content: '# Local owner', localSubmissionId: 'local-owner-source' })
    await versions.select(scope, 'sub-a', 'cap-a', local.versionId)
    const prepared = await skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [runtime] })
    assert.equal(prepared.skills[0]?.source, 'owner-local')
    assert.equal(prepared.skills[0]?.artifact, undefined)
    assert.equal(downloads(), 1)
    assert.equal(await readSkillBody(prepared.skillPaths[0]!), '# Local owner')
  })

  it('keeps old artifact paths alive across content updates and concurrent preparations', async () => {
    const firstRuntime = artifactFixture()
    serveArtifact(firstRuntime)
    const { skills } = await createStore()
    const first = await skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [firstRuntime] })
    const secondRuntime = artifactFixture(firstRuntime.content.replace('# Approved', '# Approved update'))
    serveArtifact(secondRuntime)
    const next = await Promise.all(Array.from({ length: 4 }, () => skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [secondRuntime] })))
    assert.equal(new Set(next.map(result => result.skillPaths[0])).size, 1)
    assert.notEqual(first.skillPaths[0], next[0]!.skillPaths[0])
    assert.equal(await readFile(join(first.skillPaths[0]!, 'SKILL.md'), 'utf8'), firstRuntime.content)
    assert.equal(await readFile(join(next[0]!.skillPaths[0]!, 'SKILL.md'), 'utf8'), secondRuntime.content)
    assert.deepEqual(await readdir(join(next[0]!.skillPaths[0]!, '..')), ['orders'])
  })

  it('migrates the automatic approved selection from v1 to v2 while preserving the v1 files and snapshot', async () => {
    const firstRuntime = artifactFixture()
    serveArtifact(firstRuntime)
    const { skills, versions } = await createStore()
    const first = await skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [firstRuntime] })
    const firstSnapshot = JSON.parse(JSON.stringify(first.skills[0]))
    const firstManifest = await readFile(join(first.skillPaths[0]!, 'manifest.json'), 'utf8')
    const secondRuntime = artifactFixture(firstRuntime.content.replace('# Approved', '# Approved v2'))
    secondRuntime.versionId = 'version-v2'
    secondRuntime.version = '2.0'
    secondRuntime.artifact.versionId = secondRuntime.versionId
    secondRuntime.artifact.downloadPath = '/client/subscriptions/sub-a/skills/cap-a/versions/version-v2/artifact'
    serveArtifact(secondRuntime)
    const second = await skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [secondRuntime] })
    assert.equal(second.skills[0]?.baseSkillVersionId, 'version-v2')
    assert.equal(second.skills[0]?.version, '2.0')
    assert.deepEqual((await versions.selections(scope, 'sub-a'))['cap-a'], { versionId: 'platform-version-v2', automatic: true })
    assert.notEqual(first.skillPaths[0], second.skillPaths[0])
    assert.deepEqual(first.skills[0], firstSnapshot)
    assert.equal(await readFile(join(first.skillPaths[0]!, 'manifest.json'), 'utf8'), firstManifest)
    assert.deepEqual(await readFile(join(first.skillPaths[0]!, 'SKILL.md')), Buffer.from(firstRuntime.content))
    assert.deepEqual(await readFile(join(second.skillPaths[0]!, 'SKILL.md')), Buffer.from(secondRuntime.content))
  })

  it('rejects an explicitly selected old approved version instead of migrating it', async () => {
    const firstRuntime = artifactFixture()
    serveArtifact(firstRuntime)
    const { skills, versions } = await createStore()
    const first = await skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [firstRuntime] })
    await versions.select(scope, 'sub-a', 'cap-a', 'platform-version-v1')
    const secondRuntime = artifactFixture(firstRuntime.content.replace('# Approved', '# Approved v2'))
    secondRuntime.versionId = 'version-v2'
    secondRuntime.version = '2.0'
    secondRuntime.artifact.versionId = secondRuntime.versionId
    secondRuntime.artifact.downloadPath = '/client/subscriptions/sub-a/skills/cap-a/versions/version-v2/artifact'
    serveArtifact(secondRuntime)
    await assert.rejects(skills.prepare({ ...request(), skillArtifactProtocolVersion: 1, runtimeSkills: [secondRuntime] }), /not the currently approved runtime version/)
    assert.deepEqual((await versions.selections(scope, 'sub-a'))['cap-a'], { versionId: 'platform-version-v1' })
    assert.deepEqual(await readFile(join(first.skillPaths[0]!, 'SKILL.md')), Buffer.from(firstRuntime.content))
    assert.equal(await versions.load(scope, 'sub-a', 'cap-a', 'platform-version-v2'), null)
  })

  it('stops before publishing or selecting an artifact downloaded after logout', async () => {
    const runtime = artifactFixture()
    let current = true
    const downloads = serveArtifact(runtime)
    const fetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const result = await fetch(input, init)
      if (String(input).endsWith('/artifact')) current = false
      return result
    }
    const { skills, versions } = await createStore()
    await assert.rejects(skills.prepare({ ...request(), runtimeSkills: [runtime], isCurrent: () => current }), /scope changed/)
    assert.equal(downloads(), 1)
    assert.equal(await versions.load(scope, 'sub-a', 'cap-a', 'platform-version-v1'), null)
    assert.deepEqual(await versions.selections(scope, 'sub-a'), {})
  })

  it('executes an unuploaded personal source only in its owner scope and keeps runtime paths isolated', async () => {
    installPlatformMock({ versionId: 'version-v1', version: '1.0', content: '# Published' })
    const { versions, skills } = await createStore()
    const local = await versions.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'version-v1', version: 'Personal local', content: '# Private source', localSubmissionId: 'local-request-key-001' })
    await versions.select(scope, 'sub-a', 'cap-a', local.versionId)
    const owner = await skills.prepare(request())
    assert.equal(await readSkillBody(owner.skillPaths[0]!), '# Private source')
    const other = await skills.prepare({ ...request(), memberId: 'other-user' })
    assert.notEqual(owner.skillPaths[0], other.skillPaths[0])
    assert.equal(await readSkillBody(other.skillPaths[0]!), '# Published')
    assert.equal(await readSkillBody(owner.skillPaths[0]!), '# Private source')
    await assert.rejects(versions.select({ ...scope, memberId: 'other-user' }, 'sub-a', 'cap-a', local.versionId))
    assert.equal((await versions.selections(scope, 'sub-a'))['cap-a']?.pendingVersionId, undefined)
  })


  for (const status of ['PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_REJECTED']) {
    it('keeps the owner local copy executable with review status ' + status, async () => {
      installPlatformMock({ versionId: 'version-v1', version: '1.0', content: '# Published', versions: [{ ...personal(), status }] })
      const { versions, skills } = await createStore()
      const local = await versions.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'personal-v1', version: 'Local edit', content: '# Owner edit', localSubmissionId: 'owner-request-001' })
      await versions.select(scope, 'sub-a', 'cap-a', local.versionId)
      const owner = await skills.prepare(request())
      assert.equal(await readSkillBody(owner.skillPaths[0]!), '# Owner edit')
      const other = await skills.prepare({ ...request(), memberId: 'other-user' })
      assert.equal(await readSkillBody(other.skillPaths[0]!), '# Published')
      assert.equal(await versions.load({ ...scope, memberId: 'other-user' }, 'sub-a', 'cap-a', local.versionId), null)
    })
  }

  it('does not gate an owner local edit on the current remote version review status or preview', async () => {
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname
      if (!path.endsWith('/skills')) throw new Error('Local execution must not request an unapproved remote preview')
      const payload = skillsPayload('version-v1', '1.0')
      return jsonResponse({ ...payload, skills: payload.skills.map(skill => ({ ...skill, currentVersion: { ...skill.currentVersion, status: 'PENDING_ENTERPRISE_REVIEW' } })) })
    }
    const { versions, skills } = await createStore()
    const local = await versions.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'version-v1', version: 'Local edit', content: '# Local', localSubmissionId: 'owner-request-002' })
    await versions.select(scope, 'sub-a', 'cap-a', local.versionId)
    const owner = await skills.prepare(request())
    assert.equal(owner.skillPaths.length, 1)
    assert.equal(await readSkillBody(owner.skillPaths[0]!), '# Local')
    assert.deepEqual((await skills.prepare({ ...request(), memberId: 'other-user' })).skillPaths, [])
  })

  it('keeps an already selected local copy usable when the public source preview fails', async () => {
    globalThis.fetch = async input => {
      if (new URL(String(input)).pathname.endsWith('/skills')) return jsonResponse(skillsPayload('version-v1', '1.0'))
      throw new Error('Preview unavailable')
    }
    const { versions, skills } = await createStore()
    const local = await versions.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'version-v1', version: 'Local edit', content: '# Local source', localSubmissionId: 'owner-request-003' })
    await versions.select(scope, 'sub-a', 'cap-a', local.versionId)
    const result = await skills.prepare(request())
    assert.equal(await readSkillBody(result.skillPaths[0]!), '# Local source')
  })

  it('refreshes metadata on every authorization but reuses an installed platform version', async () => {
    const state = { versionId: 'version-v1', version: '1.0.0', content: '# Platform v1', versions: [personal()] }
    const calls = installPlatformMock(state)
    const { versions, skills } = await createStore()

    const first = await skills.prepare(request())
    const second = await skills.prepare(request())

    assert.equal(calls.metadataRequests(), 2)
    assert.equal(calls.previewRequests(), 1)
    assert.deepEqual(await versions.selections(scope, 'sub-a'), { 'cap-a': { versionId: 'platform-version-v1', automatic: true } })
    assert.equal(await readSkillBody(first.skillPaths[0]!), '# Platform v1')
    assert.equal(await readSkillBody(second.skillPaths[0]!), '# Platform v1')
  })

  it('migrates the legacy default to the current platform version and preserves the old entry', async () => {
    const state = { versionId: 'version-v1', version: '1.0', content: '# Platform v1' }
    installPlatformMock(state)
    const { versions, skills } = await createStore()
    const first = await skills.prepare(request())
    state.versionId = 'version-v2'
    state.version = '2.0'
    state.content = '# Platform v2'
    const second = await skills.prepare(request())
    assert.deepEqual((await versions.selections(scope, 'sub-a'))['cap-a'], { versionId: 'platform-version-v2', automatic: true })
    assert.equal(second.skills[0]?.baseSkillVersionId, 'version-v2')
    assert.notEqual(first.skillPaths[0], second.skillPaths[0])
    assert.equal(await readSkillBody(first.skillPaths[0]!), '# Platform v1')
    assert.equal(await readSkillBody(second.skillPaths[0]!), '# Platform v2')
  })

  it('keeps a user-selected version active and records a newer platform version as pending', async () => {
    const state = { versionId: 'version-v1', version: '1.0.0', content: '# Platform v1', versions: [personal()] }
    const calls = installPlatformMock(state)
    const { versions, skills } = await createStore()
    await skills.prepare(request())

    const local = await versions.savePlatform(scope, {
      subscriptionId: 'sub-a',
      employeeId: 'employee-a',
      capabilityId: 'cap-a',
      baseSkillVersionId: 'personal-v1',
      version: '1.0.0-user.1',
      content: '# User version',
    })
    await versions.select(scope, 'sub-a', 'cap-a', local.versionId)

    state.versionId = 'version-v2'
    state.version = '2.0.0'
    state.content = '# Platform v2'
    const result = await skills.prepare(request())

    assert.equal(calls.metadataRequests(), 2)
    assert.equal(calls.previewRequests(), 2)
    assert.equal(await readSkillBody(result.skillPaths[0]!), '# User version')
    assert.deepEqual((await versions.selections(scope, 'sub-a'))['cap-a'], {
      versionId: local.versionId,
      pendingVersionId: 'platform-version-v2',
    })
  })

  it('does not report an update when the selected local version is based on the current platform version', async () => {
    const state = { versionId: 'version-v1', version: '1.0.0', content: '# Platform v1', versions: [personal()] }
    installPlatformMock(state)
    const { versions, skills } = await createStore()
    await skills.prepare(request())

    const local = await versions.savePlatform(scope, {
      subscriptionId: 'sub-a',
      employeeId: 'employee-a',
      capabilityId: 'cap-a',
      baseSkillVersionId: 'personal-v1',
      version: '1.0.0-user.1',
      content: '# User version',
    })
    await versions.select(scope, 'sub-a', 'cap-a', local.versionId)
    await skills.prepare(request())

    assert.deepEqual((await versions.selections(scope, 'sub-a'))['cap-a'], { versionId: local.versionId })
  })
  it('rejects remote unapproved or foreign-owned versions and local selections without submission provenance', async () => {
    for (const overrides of [
      { status: 'PENDING_ENTERPRISE_REVIEW' }, { status: 'ENTERPRISE_REJECTED' },
      { ownerId: 'another-user' }, { status: 'PERSONAL_ACTIVE' },
    ]) {
      const state = { versionId: 'version-v1', version: '1.0.0', content: '# Public', versions: [{ ...personal(), ...overrides }] }
      installPlatformMock(state)
      const { versions, skills } = await createStore()
      const saved = await versions.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'personal-v1', version: 'personal', content: '# Not approved' })
      await versions.select(scope, 'sub-a', 'cap-a', saved.versionId)
      await assert.rejects(skills.prepare(request()), /approved/)
    }
    installPlatformMock({ versionId: 'version-v1', version: '1.0.0', content: '# Public' })
    const { versions, skills } = await createStore()
    const saved = await versions.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'version-v1', version: 'local', content: '# Unreviewed' })
    await versions.select(scope, 'sub-a', 'cap-a', saved.versionId)
    await assert.rejects(skills.prepare(request()), /approved/)
  })

  it('loads an enterprise-approved published skill', async () => {
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/skills')) return jsonResponse({ subscriptionId: 'sub-a', skills: [{
        capability: { id: 'cap-a', name: 'Enterprise skill', description: '', type: 'SKILL' },
        currentVersion: { id: 'enterprise-v1', capabilityId: 'cap-a', scope: 'ENTERPRISE', version: '1.0', status: 'ENTERPRISE_APPROVED' }, versions: [],
      }] })
      if (path.endsWith('/preview')) return jsonResponse({ content: '# Enterprise source' })
      throw new Error('Unexpected request')
    }
    const { skills } = await createStore()
    const result = await skills.prepare(request())
    assert.equal(await readSkillBody(result.skillPaths[0]!), '# Enterprise source')
  })

  it('restores approved metadata and loads in Pi without diagnostics', async () => {
    installPlatformMock({ versionId: 'version-v1', version: '1.0', content: '# Published' })
    const { skills } = await createStore()
    const prepared = await skills.prepare(request())
    const { loadSkills } = await import('@earendil-works/pi-coding-agent')
    const loaded = loadSkills({ cwd: tmpdir(), agentDir: tmpdir(), skillPaths: prepared.skillPaths, includeDefaults: false })
    assert.deepEqual(loaded.diagnostics, [])
    assert.equal(loaded.skills[0]?.name, 'cap-a')
    assert.equal(loaded.skills[0]?.description, 'Order operations')
    const entry = await readFile(join(prepared.skillPaths[0]!, 'SKILL.md'), 'utf8')
    assert.equal(prepared.skills[0]?.content, entry)
    assert.equal(prepared.skills[0]?.sha256, createHash('sha256').update(entry).digest('hex'))
  })

  it('preserves valid YAML frontmatter, including folded descriptions', async () => {
    const content = '---\nname: order-work\ndescription: >-\n  Approved order\n  operations\n---\n\n# Work'
    installPlatformMock({ versionId: 'version-v1', version: '1.0', content })
    const { skills } = await createStore()
    const prepared = await skills.prepare(request())
    assert.equal(await readFile(join(prepared.skillPaths[0]!, 'SKILL.md'), 'utf8'), content)
    assert.equal(prepared.skills[0]?.description, 'Approved order operations')
  })

  for (const metadata of [
    'name: order-work\ndescription: "Approved: order operations"',
    'name: order-work\ndescription: >-\n  Approved order\n  operations',
    'name: order-work\ndescription: |-\n  Approved order\n  operations',
    'name: order-work\ndescription: 2026-10-12\ndisable-model-invocation: false',
  ]) {
    it('matches the pinned SDK parser and loader for YAML: ' + metadata.split('\n')[1], async () => {
      const content = `---\n${metadata}\n---\n\n# Work`
      installPlatformMock({ versionId: 'version-v1', version: '1.0', content })
      const { skills } = await createStore()
      const prepared = await skills.prepare(request())
      const { parseFrontmatter, loadSkills } = await import('@earendil-works/pi-coding-agent')
      const expected = parseFrontmatter(content).frontmatter
      assert.equal(prepared.skills[0]?.name, expected.name)
      assert.equal(prepared.skills[0]?.description, expected.description)
      const loaded = loadSkills({ cwd: tmpdir(), agentDir: tmpdir(), skillPaths: prepared.skillPaths, includeDefaults: false })
      assert.deepEqual(loaded.diagnostics, [])
      assert.equal(loaded.skills[0]?.name, expected.name)
      assert.equal(loaded.skills[0]?.description, expected.description)
    })
  }

  for (const content of [
    '---\nname: Bad_Name\ndescription: valid\n---\n# Work',
    '---\nname: valid-name\ndescription: 123\n---\n# Work',
    '---\nname: valid-name\ndescription: ""\n---\n# Work',
    '---\nname: [invalid\ndescription: test\n---\n# Work',
    '---\nname: missing-end',
    '---\nname: valid-name\nname: duplicated\ndescription: test\n---\n# Work',
    '---\nname: valid-name\ndescription: test\ndisable-model-invocation: true\n---\n# Work',
    '---\n- name: valid-name\n- description: test\n---\n# Work',
    '---\nname: valid-name\ndescription: true\n---\n# Work',
    '---\nname: valid-name\ndescription: test\n---invalid\n# Work',
  ]) {
    it('rejects invalid or hidden frontmatter: ' + content.split('\n')[1], async () => {
      installPlatformMock({ versionId: 'version-v1', version: '1.0', content })
      const { skills } = await createStore()
      await assert.rejects(skills.prepare(request()), /frontmatter/)
    })
  }

  for (const content of [
    'Read [instructions](references/orders.md).',
    'Run `scripts/order.py`.',
    'Read [orders][ref].\n[ref]: ./orders.md',
    '<img src="assets/order.png">',
    'Run `./helper.sh`.',
    'Read `guide.md`.',
  ]) {
    it('rejects missing package resources: ' + content, async () => {
      installPlatformMock({ versionId: 'version-v1', version: '1.0', content })
      const { skills } = await createStore()
      await assert.rejects(skills.prepare(request()), /missing local resource/)
    })
  }

  it('permits web links and references to the single entry itself', async () => {
    installPlatformMock({ versionId: 'version-v1', version: '1.0', content: '[Web](https://example.test/orders) [Local](#orders) [Entry](./SKILL.md#orders)' })
    const { skills } = await createStore()
    assert.equal((await skills.prepare(request())).skillPaths.length, 1)
  })

  it('uses runtime content without preview and preserves old paths across same-ID changes', async () => {
    const calls = installPlatformMock({ versionId: 'version-v1', version: '1.0', content: '# Stale preview' })
    const { skills } = await createStore()
    const runtime = { capabilityId: 'cap-a', name: 'Orders', description: 'Approved operations', versionId: 'version-v1', version: '1.0', content: '# Runtime first' }
    const first = await skills.prepare({ ...request(), runtimeSkills: [runtime] })
    const second = await skills.prepare({ ...request(), runtimeSkills: [{ ...runtime, content: '# Runtime second' }] })
    assert.equal(calls.previewRequests(), 0)
    assert.notEqual(first.skillPaths[0], second.skillPaths[0])
    assert.equal(await readSkillBody(first.skillPaths[0]!), '# Runtime first')
    assert.equal(await readSkillBody(second.skillPaths[0]!), '# Runtime second')
    skills.invalidate()
    assert.equal(await readSkillBody(first.skillPaths[0]!), '# Runtime first')
  })

  it('installs concurrently without replacing published resources or leaking staging', async () => {
    installPlatformMock({ versionId: 'version-v1', version: '1.0', content: '# Concurrent' })
    const root = await mkdtemp(join(tmpdir(), 'sep-concurrent-skills-'))
    const skills = new SkillStore(root)
    const results = await Promise.all(Array.from({ length: 8 }, () => skills.prepare(request())))
    assert.equal(new Set(results.map(result => result.skillPaths[0])).size, 1)
    assert.deepEqual(await readdir(join(results[0]!.skillPaths[0]!, '..')), ['cap-a'])
    assert.equal(await readSkillBody(results[0]!.skillPaths[0]!), '# Concurrent')
  })

  it('rejects mismatched metadata, missing preview, and unapproved runtime versions', async () => {
    const { skills } = await createStore()
    globalThis.fetch = async () => jsonResponse({ ...skillsPayload('version-v1', '1.0'), subscriptionId: 'other' })
    await assert.rejects(skills.prepare(request()), /match the subscription/)
    installPlatformMock({ versionId: 'version-v1', version: '1.0', content: '' })
    await assert.rejects(skills.prepare(request()), /empty/)
    await assert.rejects(skills.prepare({ ...request(), runtimeSkills: [{ capabilityId: 'cap-a', name: 'Orders', description: null, versionId: 'unknown', version: '1.0', content: '# Unknown' }] }), /not approved/)
  })

  it('does not persist a stale preview after session invalidation', async () => {
    let current = true
    let finish!: (value: Response) => void
    let previewStarted!: () => void
    const started = new Promise<void>(resolve => { previewStarted = resolve })
    globalThis.fetch = async input => {
      if (String(input).endsWith('/skills')) return jsonResponse(skillsPayload('version-v1', '1.0'))
      previewStarted()
      return new Promise<Response>(resolve => { finish = resolve })
    }
    const { versions, skills } = await createStore()
    const preparation = skills.prepare({ ...request(), isCurrent: () => current })
    await started
    current = false
    finish(jsonResponse({ content: '# Stale' }))
    await assert.rejects(preparation, /scope changed/)
    assert.equal(await versions.load(scope, 'sub-a', 'cap-a', 'platform-version-v1'), null)
    assert.deepEqual(await versions.selections(scope, 'sub-a'), {})
  })

})
