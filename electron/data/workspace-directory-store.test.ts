import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ScopePath, TaskScopeError } from './scope-path'
import { WorkspaceDirectoryStore } from './workspace-directory-store'

const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
const names = { enterpriseName: '\u9f99\u9053\u516c\u53f8', memberName: '\u5f20\u4e09' }

describe('readable workspace directories', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))) })

  async function harness() {
    const root = await mkdtemp(join(tmpdir(), 'sep-workspace-names-'))
    directories.push(root)
    return { root, paths: new ScopePath(root), store: new WorkspaceDirectoryStore(root) }
  }

  it('uses readable Unicode names and retains their ID association after restart or rename', async () => {
    const { root, store } = await harness()
    assert.deepEqual(await store.resolve(scope, names), names)
    const restored = new WorkspaceDirectoryStore(root)
    assert.deepEqual(await restored.resolve(scope, { enterpriseName: 'Renamed', memberName: 'Renamed' }), names)
  })

  it('separates same-named enterprises and same-named members with readable numeric suffixes', async () => {
    const { store } = await harness()
    const values = await Promise.all([
      store.resolve(scope, names),
      store.resolve({ ...scope, memberId: 'member-b' }, names),
      store.resolve({ ...scope, enterpriseId: 'enterprise-b' }, names),
    ])
    assert.deepEqual(values, [names, { ...names, memberName: `${names.memberName} (2)` }, { ...names, enterpriseName: `${names.enterpriseName} (2)` }])
  })

  it('treats case and sanitized-name collisions as separate owners', async () => {
    const { store } = await harness()
    await store.resolve(scope, { enterpriseName: 'ACME:', memberName: 'Alice' })
    assert.deepEqual(await store.resolve({ ...scope, memberId: 'other' }, { enterpriseName: 'ACME:', memberName: 'alice' }), { enterpriseName: 'ACME_', memberName: 'alice (2)' })
    assert.deepEqual(await store.resolve({ ...scope, enterpriseId: 'other' }, { enterpriseName: 'acme?', memberName: 'Alice' }), { enterpriseName: 'acme_ (2)', memberName: 'Alice' })
  })

  it('does not adopt existing untracked directories or files', async () => {
    const { root, store } = await harness()
    const workspaceRoot = join(root, 'task-workspaces', 'v1')
    await mkdir(join(workspaceRoot, names.enterpriseName), { recursive: true })
    assert.deepEqual(await store.resolve(scope, names), { ...names, enterpriseName: `${names.enterpriseName} (2)` })
    await mkdir(join(workspaceRoot, `${names.enterpriseName} (2)`), { recursive: true })
    await writeFile(join(workspaceRoot, `${names.enterpriseName} (2)`, 'Bob'), 'occupied')
    assert.deepEqual(await store.resolve({ ...scope, memberId: 'bob' }, { ...names, memberName: 'Bob' }), { enterpriseName: `${names.enterpriseName} (2)`, memberName: 'Bob (2)' })
  })

  it('handles empty, traversal, reserved, control-character and long names within the workspace root', async () => {
    const { paths, store } = await harness()
    const fixtures = [
      { enterpriseName: '..', memberName: ' ' },
      { enterpriseName: '../outside', memberName: 'a\\b:c*?<>|\u0000' },
      { enterpriseName: 'LPT1.log', memberName: 'NUL' },
      { enterpriseName: '\u4e2d'.repeat(200), memberName: '\ud83d\ude00'.repeat(200) },
    ]
    for (const [index, input] of fixtures.entries()) {
      const owner = { enterpriseId: `enterprise-${index}`, memberId: `member-${index}` }
      const result = await store.resolve(owner, input)
      for (const segment of [result.enterpriseName, result.memberName]) {
        assert.ok(segment.length > 0 && segment.length <= 80)
        assert.ok(!/[\\/:*?\u0022<>|]/.test(segment))
        assert.ok(Array.from(segment).every(character => character.charCodeAt(0) >= 32))
        assert.ok(!/[. ]$/.test(segment))
        assert.notEqual(segment, '..')
      }
      assert.ok(paths.defaultWorkspaceDir(owner, 'task-1', result).startsWith(paths.workspaceBaseRoot()))
    }
  })

  it('rejects invalid owner IDs and corrupt directory associations rather than sharing workspaces', async () => {
    const { paths, store } = await harness()
    await assert.rejects(store.resolve({ ...scope, memberId: '../escape' }, names), TaskScopeError)
    await mkdir(paths.workspaceBaseRoot(), { recursive: true })
    await writeFile(paths.workspaceDirectoryIndexFile(), '{broken', 'utf8')
    await assert.rejects(store.resolve(scope, names), /workspace directory/i)
  })

  it('does not split Unicode characters when adding a collision suffix', async () => {
    const { store } = await harness()
    const input = { enterpriseName: 'Company', memberName: 'a'.repeat(75) + '\ud83d\ude00' }
    await store.resolve(scope, input)
    const result = await store.resolve({ ...scope, memberId: 'other' }, input)
    assert.equal(result.memberName, 'a'.repeat(75) + ' (2)')
    assert.deepEqual(await store.resolve({ ...scope, memberId: 'other' }, input), result)
  })

  it('keeps unnamed owners isolated without using encoded IDs', async () => {
    const { store } = await harness()
    assert.deepEqual(await store.resolve(scope), { enterpriseName: 'Enterprise', memberName: 'User' })
    assert.deepEqual(await store.resolve({ ...scope, memberId: 'other' }), { enterpriseName: 'Enterprise', memberName: 'User (2)' })
  })
})
