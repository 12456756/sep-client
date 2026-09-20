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