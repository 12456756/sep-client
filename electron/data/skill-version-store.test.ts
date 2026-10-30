import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { SkillVersionStore } from './skill-version-store'

describe('SkillVersionStore', () => {
  it('serializes concurrent saves to the same version file in submission order', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'sep-skills-version-race-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const store = new SkillVersionStore(relative(process.cwd(), root))
    const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    const input = { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a',
      baseSkillVersionId: 'v1', version: '1', content: '# Original' }
    const original = await store.savePlatform(scope, input)
    const saves = await Promise.all(Array.from({ length: 16 }, (_, index) => {
      const update = { ...input, content: `# Update ${index}` }
      return index % 2 === 0
        ? store.save(scope, { ...update, versionId: original.versionId })
        : store.savePlatform(scope, update)
    }))
    const file = join(root, 'enterprise-a', 'member-a', 'sub-a', 'cap-a', 'versions', `${original.versionId}.json`)
    assert.equal(saves.length, 16)
    assert.deepEqual(await store.load(scope, 'sub-a', 'cap-a', original.versionId), saves[15])
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saves[15])
    assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')), saves[14])
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.equal((await stat(`${file}.bak`)).mode & 0o777, 0o600)
    }
  })

  it('keeps concurrent same-version saves isolated by owner scope and rejects unsafe identifiers', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'sep-skills-version-scope-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const store = new SkillVersionStore(root)
    const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    const scopes = [scope, { ...scope, memberId: 'member-b' }, { ...scope, enterpriseId: 'enterprise-b' }]
    const input = { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a',
      baseSkillVersionId: 'v1', version: '1', content: '# Source' }
    const saves = await Promise.all(scopes.map((owner, index) => store.savePlatform(owner, {
      ...input, content: `# Owner ${index}`,
    })))
    for (const [index, owner] of scopes.entries()) {
      assert.deepEqual(await store.load(owner, 'sub-a', 'cap-a', 'platform-v1'), saves[index])
    }
    await assert.rejects(store.save({ ...scope, memberId: '..' }, input), /Invalid skill identifier/)
    await assert.rejects(store.save(scope, { ...input, versionId: '../escape' }), /Invalid skill identifier/)
    await assert.rejects(store.savePlatform(scope, { ...input, capabilityId: '..' }), /Invalid skill identifier/)
  })

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

  it('migrates only the observed legacy pointer and preserves a newer personal selection', async () => {
    const store = new SkillVersionStore(await mkdtemp(join(tmpdir(), 'sep-skills-migrate-race-')))
    const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    const input = { subscriptionId: 'sub-a', employeeId: 'employee-a', capabilityId: 'cap-a', baseSkillVersionId: 'v1', version: '1', content: '# Old' }
    const first = await store.savePlatform(scope, input)
    const next = await store.savePlatform(scope, { ...input, baseSkillVersionId: 'v2' })
    const personal = await store.save(scope, { ...input, localSubmissionId: 'personal-source', content: '# Personal' })
    await store.select(scope, 'sub-a', 'cap-a', first.versionId)
    await store.selectDefault(scope, 'sub-a', 'cap-a', next.versionId, { versionId: first.versionId })
    assert.deepEqual((await store.selections(scope, 'sub-a'))['cap-a'], { versionId: next.versionId, automatic: true })
    const observed = (await store.selections(scope, 'sub-a'))['cap-a']
    await store.select(scope, 'sub-a', 'cap-a', personal.versionId)
    await store.selectDefault(scope, 'sub-a', 'cap-a', first.versionId, observed)
    await store.selectDefault(scope, 'sub-a', 'cap-a', first.versionId, null)
    assert.deepEqual((await store.selections(scope, 'sub-a'))['cap-a'], { versionId: personal.versionId })
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
