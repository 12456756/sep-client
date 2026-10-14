import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillVersionStore } from './skill-version-store'

describe('SkillVersionStore', () => {
  it('keeps local content isolated and selects only an existing version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-skills-'))
    const store = new SkillVersionStore(root)
    const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    const version = await store.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'platform-v1', version: '1.0.0-user.1', content: '# Custom' })
    assert.equal(version.state, 'DRAFT')
    assert.match(version.sha256, /^[a-f0-9]{64}$/)
    await store.select(scope, 'sub-a', 'cap-a', version.versionId)
    assert.equal(await store.selected(scope, 'sub-a', 'cap-a'), version.versionId)
    assert.equal((await store.load(scope, 'sub-a', 'cap-a', version.versionId))?.content, '# Custom')
    assert.equal((await readFile(join(root, 'enterprise-a', 'member-a', 'sub-a', 'cap-a', 'versions', `${version.versionId}.json`), 'utf8')).includes('platform-v1'), true)
    await assert.rejects(() => store.select(scope, 'sub-a', 'cap-a', 'missing'))

    const second = await store.save(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-b', baseSkillVersionId: 'platform-v1', version: '1.0.0-user.1', content: '# Other' })
    await store.select(scope, 'sub-a', 'cap-b', second.versionId)
    assert.deepEqual(await store.selections(scope, 'sub-a'), {
      'cap-a': { versionId: version.versionId },
      'cap-b': { versionId: second.versionId },
    })
    await store.markPending(scope, 'sub-a', 'cap-a', 'platform-v2')
    assert.deepEqual((await store.selections(scope, 'sub-a'))['cap-a'], {
      versionId: version.versionId,
      pendingVersionId: 'platform-v2',
    })
  })
  it('marks default selections and migrates them without changing saved versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-skills-default-'))
    const store = new SkillVersionStore(root)
    const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    const first = await store.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'v1', version: '1', content: '# First' })
    const second = await store.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'v2', version: '2', content: '# Second' })
    await store.selectDefault(scope, 'sub-a', 'cap-a', first.versionId)
    await store.markPending(scope, 'sub-a', 'cap-a', second.versionId)
    const restored = new SkillVersionStore(root)
    assert.deepEqual((await restored.selections(scope, 'sub-a'))['cap-a'], { versionId: first.versionId, automatic: true, pendingVersionId: second.versionId })
    await restored.selectDefault(scope, 'sub-a', 'cap-a', second.versionId)
    assert.deepEqual((await restored.selections(scope, 'sub-a'))['cap-a'], { versionId: second.versionId, automatic: true })
    assert.deepEqual(await restored.load(scope, 'sub-a', 'cap-a', first.versionId), first)
    await assert.rejects(restored.selectDefault(scope, 'sub-a', 'cap-a', 'missing'), /not found/)
  })

  it('preserves unmarked selections as manual and clears automatic on explicit selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-skills-manual-'))
    const store = new SkillVersionStore(root)
    const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    const first = await store.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'v1', version: '1', content: '# First' })
    const second = await store.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'v2', version: '2', content: '# Second' })
    await store.selectDefault(scope, 'sub-a', 'cap-a', first.versionId)
    await store.select(scope, 'sub-a', 'cap-a', first.versionId)
    await store.markPending(scope, 'sub-a', 'cap-a', second.versionId)
    // Existing records without the new marker must remain explicit selections after restart.
    const restored = new SkillVersionStore(root)
    await restored.selectDefault(scope, 'sub-a', 'cap-a', second.versionId)
    assert.deepEqual((await restored.selections(scope, 'sub-a'))['cap-a'], { versionId: first.versionId, pendingVersionId: second.versionId })
  })

  it('never overwrites manual selection when default and manual writes race', async () => {
    const store = new SkillVersionStore(await mkdtemp(join(tmpdir(), 'sep-skills-default-race-')))
    const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    const first = await store.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'v1', version: '1', content: '# First' })
    const second = await store.savePlatform(scope, { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'v2', version: '2', content: '# Second' })
    await store.selectDefault(scope, 'sub-a', 'cap-a', first.versionId)
    await Promise.all([
      store.selectDefault(scope, 'sub-a', 'cap-a', second.versionId),
      store.select(scope, 'sub-a', 'cap-a', first.versionId),
    ])
    assert.deepEqual((await store.selections(scope, 'sub-a'))['cap-a'], { versionId: first.versionId })
    await Promise.all([
      store.select(scope, 'sub-a', 'cap-a', second.versionId),
      store.selectDefault(scope, 'sub-a', 'cap-a', first.versionId),
    ])
    assert.deepEqual((await store.selections(scope, 'sub-a'))['cap-a'], { versionId: second.versionId })
  })

  it('preserves concurrent capability selections and rejects dot path segments', async () => {
    const store = new SkillVersionStore(await mkdtemp(join(tmpdir(), 'sep-skills-race-')))
    const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    const values = await Promise.all(['cap-a', 'cap-b'].map(capabilityId => store.savePlatform(scope, {
      subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId,
      baseSkillVersionId: 'v1', version: '1', content: '# Source',
    })))
    await Promise.all(values.map(value => store.select(scope, 'sub-a', value.capabilityId, value.versionId)))
    assert.equal(Object.keys(await store.selections(scope, 'sub-a')).length, 2)
    await assert.rejects(store.selections({ ...scope, memberId: '..' }, 'sub-a'), /Invalid/)
  })

})