import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { employeeRuntimeSnapshotSchema, parseEmployeeRuntimeManifest } from './employee-runtime-contract'
import { getEmployeeRuntime } from './platform-api'
import { readFileSync } from 'node:fs'
import { skillArtifactAvailableSchema } from './skill-artifact-contract'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function fixture() {
  return {
    manifestVersion: 1, subscriptionId: 'sub-1', templateVersion: '1.0',
    employee: { id: 'employee-1', name: 'Employee', version: '1.1', maxSteps: 10, avatar: null },
    runtime: {
      systemPrompt: 'Actual instructions', modelId: 'model-1', allowedModels: ['model-1'], config: null,
      skills: [{ capabilityId: 'cap-1', name: 'Skill', description: null, versionId: 'approved-1', version: '2.0', content: '# Approved' }],
    },
  }
}

function negotiatedFixture() {
  const value = fixture()
  return { ...value, runtime: { ...value.runtime, skillArtifactProtocolVersion: 1, skills: value.runtime.skills.map(skill => ({
    ...skill,
    artifact: {
      protocolVersion: 1, capabilityId: skill.capabilityId, versionId: skill.versionId,
      approvedContentSha256: 'a'.repeat(64), status: 'AVAILABLE', format: 'single-file',
      installationDirectory: 'approved-skill', entryPath: 'SKILL.md', entrySha256: 'b'.repeat(64),
      artifactSha256: 'b'.repeat(64), byteLength: 100, fileCount: 1,
      downloadPath: `/client/subscriptions/sub-1/skills/${skill.capabilityId}/versions/${skill.versionId}/artifact`,
    },
  })) } }
}

describe('existing SEP employee runtime manifest v1', () => {
  it('parses the formal manifest and strips unrelated fields and config', () => {
    const result = parseEmployeeRuntimeManifest({ ...fixture(), refreshToken: 'secret' })
    assert.equal(result.runtime.systemPrompt, 'Actual instructions')
    assert.equal(result.runtime.skills[0]?.description, null)
    assert.equal('config' in result.runtime, false)
    assert.equal('avatar' in result.employee, false)
    assert.equal('refreshToken' in result, false)
  })

  it('preserves media as an unvalidated optional fragment only', () => {
    const value = fixture()
    const media = { notNegotiated: true }
    assert.deepEqual(parseEmployeeRuntimeManifest({ ...value, runtime: { ...value.runtime, media } }).runtime.media, media)
    assert.equal(parseEmployeeRuntimeManifest(value).runtime.media, undefined)
  })

  it('rejects unsupported versions, wrong prompt/model types, and duplicate skills without echoing input', () => {
    const value = fixture()
    for (const invalid of [
      { ...value, manifestVersion: 2 },
      { ...value, runtime: { ...value.runtime, systemPrompt: 123 } },
      { ...value, runtime: { ...value.runtime, allowedModels: [123] } },
      { ...value, runtime: { ...value.runtime, skills: [...value.runtime.skills, ...value.runtime.skills] } },
      { ...value, employee: { ...value.employee, maxSteps: '10' } },
    ]) assert.throws(() => parseEmployeeRuntimeManifest(invalid), { message: 'Invalid employee runtime manifest.' })
  })

  it('independently negotiates skill artifacts and SEP media runtime v1 using bearer auth', async () => {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/api/client/subscriptions/sub-1/runtime')
      assert.equal(url.search, '?mediaProtocolVersion=1&skillArtifactProtocolVersion=1')
      assert.deepEqual([...new Headers(init?.headers)], [['authorization', 'Bearer access']])
      return new Response(JSON.stringify(negotiatedFixture()), { status: 200 })
    }
    assert.equal((await getEmployeeRuntime('sub-1', 'access')).subscriptionId, 'sub-1')
  })

  it('rejects a response for a different subscription', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ ...fixture(), subscriptionId: 'other' }), { status: 200 })
    await assert.rejects(getEmployeeRuntime('sub-1', 'access'), /subscription mismatch/)
  })

  it('consumes the authoritative SEP media fixtures without changing chat configuration', async () => {
    const fixtures: { media: unknown }[] = JSON.parse(readFileSync(
      new URL('./fixtures/sep-media-runtime-v1.json', import.meta.url), 'utf8',
    ))
    for (const entry of fixtures) {
      const value = negotiatedFixture()
      globalThis.fetch = async () => new Response(JSON.stringify({ ...value, runtime: { ...value.runtime, media: entry.media } }))
      const result = await getEmployeeRuntime('sub-1', 'access')
      assert.deepEqual(result.runtime.media, entry.media)
      assert.equal(result.runtime.modelId, 'model-1')
      assert.equal(result.runtime.systemPrompt, 'Actual instructions')
      assert.equal(result.runtime.skills.length, 1)
    }
  })

  it('omits malformed or unsupported media without disabling ordinary chat or returning private fields', async () => {
    const value = negotiatedFixture()
    for (const media of [
      { protocolVersion: 2, apiKey: 'secret' },
      { protocolVersion: 1, executionAvailable: true, defaultProfileId: null, tools: [], profiles: [] },
      { protocolVersion: 1, executionAvailable: false, defaultProfileId: null, tools: [], profiles: [], apiKey: 'secret' },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...value, runtime: { ...value.runtime, media } }))
      const result = await getEmployeeRuntime('sub-1', 'access')
      assert.equal(result.runtime.media, undefined)
      assert.equal(result.runtime.modelId, 'model-1')
      assert.equal(JSON.stringify(result).includes('secret'), false)
    }
  })

  it('round-trips the complete immutable snapshot and validates disk skill hashes', () => {
    const value = fixture()
    const snapshot = {
      manifestVersion: 1, subscriptionId: value.subscriptionId, enterpriseId: 'enterprise-1', memberId: 'member-1',
      employeeId: value.employee.id, templateVersion: value.templateVersion, employeeVersion: value.employee.version,
      maxSteps: value.employee.maxSteps, systemPrompt: value.runtime.systemPrompt, modelId: value.runtime.modelId,
      allowedModels: value.runtime.allowedModels, approvedSkills: value.runtime.skills,
      skills: [{ capabilityId: 'cap-1', versionId: 'local-1', baseSkillVersionId: 'approved-1', version: 'personal', source: 'owner-local',
        name: 'cap-1', description: 'Approved skill', content: '---\nname: cap-1\ndescription: Approved skill\n---\n# Local',
        sha256: 'a'.repeat(64), path: '/runtime/immutable/cap-1' }],
    }
    const parsed = employeeRuntimeSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))
    assert.deepEqual(parsed, snapshot)
    assert.equal(Object.isFrozen(parsed), true)
    assert.equal(Object.isFrozen(parsed.skills), true)
    assert.equal(Object.isFrozen(parsed.skills[0]), true)
    assert.equal(employeeRuntimeSnapshotSchema.safeParse({ ...snapshot, skills: [{ ...snapshot.skills[0], sha256: 'bad' }] }).success, false)
    const artifact = skillArtifactAvailableSchema.parse(negotiatedFixture().runtime.skills[0]!.artifact)
    const withArtifact = { ...snapshot, skillArtifactProtocolVersion: 1, approvedSkills: negotiatedFixture().runtime.skills,
      skills: [{ ...snapshot.skills[0], artifact }] }
    const frozen = employeeRuntimeSnapshotSchema.parse(JSON.parse(JSON.stringify(withArtifact)))
    assert.deepEqual(frozen, withArtifact)
    assert.equal(frozen.skillArtifactProtocolVersion, 1)
    assert.equal(frozen.skills[0]?.artifact?.status, 'AVAILABLE')
    assert.equal(Object.isFrozen(frozen.skills[0]?.artifact), true)
    assert.equal(Object.isFrozen(frozen.approvedSkills[0]?.artifact), true)
    assert.equal(employeeRuntimeSnapshotSchema.safeParse({ ...withArtifact, skillArtifactProtocolVersion: 2 }).success, false)
    assert.equal(employeeRuntimeSnapshotSchema.safeParse({ ...withArtifact,
      skills: [{ ...withArtifact.skills[0], artifact: { ...artifact, storageKey: 'private' } }] }).success, false)
    const blocked = { protocolVersion: 1, capabilityId: 'cap-1', versionId: 'approved-1',
      approvedContentSha256: 'a'.repeat(64), status: 'BLOCKED', reason: 'PACKAGE_REQUIRED' }
    assert.equal(employeeRuntimeSnapshotSchema.safeParse({ ...withArtifact,
      skills: [{ ...withArtifact.skills[0], artifact: blocked }] }).success, false)
    const blockedSnapshot = employeeRuntimeSnapshotSchema.parse({ ...snapshot,
      approvedSkills: [{ ...value.runtime.skills[0], artifact: blocked }] })
    assert.equal(Object.isFrozen(blockedSnapshot.approvedSkills[0]?.artifact), true)
  })

  it('keeps legacy manifests readable while preserving optional full AVAILABLE and BLOCKED descriptors', () => {
    assert.equal(parseEmployeeRuntimeManifest(fixture()).runtime.skills[0]?.artifact, undefined)
    const value = negotiatedFixture()
    const parsed = parseEmployeeRuntimeManifest(value)
    assert.deepEqual(parsed.runtime.skills[0]?.artifact, value.runtime.skills[0]?.artifact)
    assert.equal(parsed.runtime.skillArtifactProtocolVersion, 1)
    assert.equal('skillArtifactProtocolVersion' in parsed, false)
    const blocked = { protocolVersion: 1, capabilityId: 'cap-1', versionId: 'approved-1',
      approvedContentSha256: 'a'.repeat(64), status: 'BLOCKED', reason: 'PACKAGE_REQUIRED' }
    assert.deepEqual(parseEmployeeRuntimeManifest({ ...value, runtime: { ...value.runtime,
      skills: [{ ...value.runtime.skills[0], artifact: blocked }] } }).runtime.skills[0]?.artifact, blocked)
  })

  it('rejects malformed descriptors and identity/download path mismatches without echoing input', () => {
    const value = negotiatedFixture()
    const skill = value.runtime.skills[0]!
    for (const override of [
      { capabilityId: 'other' }, { versionId: 'other' }, { protocolVersion: 2 }, { storageKey: 'private' },
      { downloadPath: '/client/subscriptions/other/skills/cap-1/versions/approved-1/artifact' },
      { downloadPath: '/client/subscriptions/sub-1/skills/other/versions/approved-1/artifact' },
      { downloadPath: '/client/subscriptions/sub-1/skills/cap-1/versions/other/artifact' },
    ]) {
      assert.throws(() => parseEmployeeRuntimeManifest({ ...value, runtime: { ...value.runtime,
        skills: [{ ...skill, artifact: { ...skill.artifact, ...override } }] } }), { message: 'Invalid employee runtime manifest.' })
    }
  })

  it('does not silently downgrade when the negotiated protocol or any descriptor is missing', async () => {
    const value = negotiatedFixture()
    for (const runtime of [
      fixture().runtime,
      { ...value.runtime, skillArtifactProtocolVersion: undefined },
      { ...value.runtime, skillArtifactProtocolVersion: 2 },
      { ...value.runtime, skills: fixture().runtime.skills },
      { ...value.runtime, skills: [{ ...value.runtime.skills[0], artifact: null }] },
      { ...value.runtime, skills: [], skillArtifactProtocolVersion: undefined },
    ]) {
      let calls = 0
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ ...value, runtime })) }
      await assert.rejects(getEmployeeRuntime('sub-1', 'access'), /negotiation failed|Invalid employee runtime manifest/)
      assert.equal(calls, 1)
    }
  })

  it('accepts an acknowledged runtime with no skills or with blocked artifacts without dropping chat', async () => {
    const value = negotiatedFixture()
    for (const skills of [[], [{ ...value.runtime.skills[0], artifact: {
      protocolVersion: 1, capabilityId: 'cap-1', versionId: 'approved-1', approvedContentSha256: 'a'.repeat(64),
      status: 'BLOCKED', reason: 'PACKAGE_UNAVAILABLE',
    } }]]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...value, runtime: { ...value.runtime, skills } }))
      const result = await getEmployeeRuntime('sub-1', 'access')
      assert.equal(result.runtime.skillArtifactProtocolVersion, 1)
      assert.deepEqual(result.runtime.skills, skills)
      assert.equal(result.runtime.modelId, 'model-1')
    }
  })
})
