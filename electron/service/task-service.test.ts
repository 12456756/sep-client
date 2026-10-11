import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from '../runtime/task-manager'
import { ScopePath, type TaskOwnerScope } from '../data/scope-path'
import { TaskService } from './task-service'

const owner: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

describe('directory selection starting path', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

  async function harness() {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-directory-selection-'))
    directories.push(userDataDir)
    const manager = new TaskManager(userDataDir)
    await manager.initialize()
    await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
    const service = new TaskService({
      scope: { currentScope: () => manager.getCurrentUserScope() }, taskManager: manager,
    } as ConstructorParameters<typeof TaskService>[0])
    return { userDataDir, manager, service, clearScope: () => manager.clearCurrentUser() }
  }

  it('creates the default parent without creating or changing a task', async () => {
    const { userDataDir, manager, service } = await harness()
    const path = await service.prepareDirectorySelection()
    const expected = new ScopePath(userDataDir).defaultWorkspaceRoot(owner)
    assert.equal(path, expected)
    assert.ok((await stat(path)).isDirectory())
    assert.deepEqual(await manager.getAllTasks(), [])
    const task = await manager.createTask('new task', 'goal')
    assert.equal(task.workDir, join(path, task.id))
  })

  it('starts from an existing chosen directory', async () => {
    const { userDataDir, service } = await harness()
    const chosen = join(userDataDir, 'chosen')
    await mkdir(chosen)
    assert.equal(await service.prepareDirectorySelection(chosen), chosen)
  })

  it('falls back for empty, missing, or non-directory paths', async () => {
    const { userDataDir, service } = await harness()
    const file = join(userDataDir, 'file.txt')
    await writeFile(file, 'fixture')
    const expected = new ScopePath(userDataDir).defaultWorkspaceRoot(owner)
    for (const path of ['', '   ', join(userDataDir, 'missing'), file]) {
      assert.equal(await service.prepareDirectorySelection(path), expected)
    }
  })

  it('uses the currently authenticated owner workspace', async () => {
    const { userDataDir, manager, service } = await harness()
    await manager.setCurrentUser('member-b', 'enterprise-b')
    assert.equal(await service.prepareDirectorySelection(), new ScopePath(userDataDir).defaultWorkspaceRoot({ memberId: 'member-b', enterpriseId: 'enterprise-b' }))
  })

  it('rejects a cleared session before using a supplied directory', async () => {
    const { userDataDir, service, clearScope } = await harness()
    clearScope()
    await assert.rejects(() => service.prepareDirectorySelection(userDataDir), { code: 'AUTH_REQUIRED' })
  })
})
