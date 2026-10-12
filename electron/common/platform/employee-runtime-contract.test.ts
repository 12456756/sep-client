import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { employeeRuntimeSnapshotSchema, parseEmployeeRuntimeManifest } from './employee-runtime-contract'
import { getEmployeeRuntime } from './platform-api'
import { readFileSync } from 'node:fs'

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

  it('negotiates the implemented SEP media runtime v1 using bearer auth', async () => {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/api/client/subscriptions/sub-1/runtime')
      assert.equal(url.search, '?mediaProtocolVersion=1')
      assert.deepEqual([...new Headers(init?.headers)], [['authorization', 'Bearer access']])
      return new Response(JSON.stringify(fixture()), { status: 200 })
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
      const value = fixture()
      globalThis.fetch = async () => new Response(JSON.stringify({ ...value, runtime: { ...value.runtime, media: entry.media } }))
      const result = await getEmployeeRuntime('sub-1', 'access')
      assert.deepEqual(result.runtime.media, entry.media)
      assert.equal(result.runtime.modelId, 'model-1')
      assert.equal(result.runtime.systemPrompt, 'Actual instructions')
      assert.equal(result.runtime.skills.length, 1)
    }
  })

  it('omits malformed or unsupported media without disabling ordinary chat or returning private fields', async () => {
    const value = fixture()
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
  })
})
