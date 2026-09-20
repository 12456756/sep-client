import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillVersion } from '../../common/platform/platform-api'
import { SkillVersionStore } from '../../data/skill-version-store'
import { SkillStore } from './pi-skill-packages'

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

describe('SkillStore', () => {
  it('executes an unuploaded personal source only in its owner scope and keeps runtime paths isolated', async () => {
    installPlatformMock({ versionId: 'version-v1', version: '1.0', content: '# Published' })
    const { versions, skills } = await createStore()
    const local = await versions.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'version-v1', version: 'Personal local', content: '# Private source', localSubmissionId: 'local-request-key-001' })
    await versions.select(scope, 'sub-a', 'cap-a', local.versionId)
    const owner = await skills.prepare(request())
    assert.equal(await readFile(join(owner.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Private source')
    const other = await skills.prepare({ ...request(), memberId: 'other-user' })
    assert.notEqual(owner.skillPaths[0], other.skillPaths[0])
    assert.equal(await readFile(join(other.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Published')
    assert.equal(await readFile(join(owner.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Private source')
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
      assert.equal(await readFile(join(owner.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Owner edit')
      const other = await skills.prepare({ ...request(), memberId: 'other-user' })
      assert.equal(await readFile(join(other.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Published')
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
    assert.equal(await readFile(join(owner.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Local')
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
    assert.equal(await readFile(join(result.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Local source')
  })

  it('refreshes metadata on every authorization but reuses an installed platform version', async () => {
    const state = { versionId: 'version-v1', version: '1.0.0', content: '# Platform v1', versions: [personal()] }
    const calls = installPlatformMock(state)
    const { versions, skills } = await createStore()

    const first = await skills.prepare(request())
    const second = await skills.prepare(request())

    assert.equal(calls.metadataRequests(), 2)
    assert.equal(calls.previewRequests(), 1)
    assert.deepEqual(await versions.selections(scope, 'sub-a'), { 'cap-a': { versionId: 'platform-version-v1' } })
    assert.equal(await readFile(join(first.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Platform v1')
    assert.equal(await readFile(join(second.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Platform v1')
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
    assert.equal(await readFile(join(result.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# User version')
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
    assert.equal(await readFile(join(result.skillPaths[0]!, 'SKILL.md'), 'utf8'), '# Enterprise source')
  })

})
