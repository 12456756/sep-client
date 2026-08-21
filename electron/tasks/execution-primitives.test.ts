import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ApprovalBroker } from '../pi/approval-broker'
import { WorkspaceLockManager } from './workspace-lock-manager'

const temporaryDirectories: string[] = []

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-coordinator-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('WorkspaceLockManager', () => {
  it('blocks equal and ancestor paths but permits disjoint paths', async () => {
    const root = await makeDirectory()
    const lockManager = new WorkspaceLockManager(root)
    const first = lockManager.acquire('run-a', root)
    assert.ok(first)
    assert.equal(lockManager.acquire('run-b', join(root, 'child')), null)
    assert.ok(lockManager.acquire('run-c', join(root, '..', 'different')))
    first?.()
    assert.ok(lockManager.acquire('run-b', join(root, 'child')))
  })

  it('normalizes Windows-style case variations', async () => {
    const root = await makeDirectory()
    const lockManager = new WorkspaceLockManager(root)
    const first = lockManager.acquire('run-a', root.toUpperCase())
    assert.ok(first)
    assert.equal(lockManager.acquire('run-b', root.toLowerCase()), null)
  })

  it('normalizes symlink aliases when present', async () => {
    const root = await makeDirectory()
    const real = join(root, 'real')
    const alias = join(root, 'alias')
    await mkdir(real)
    try {
      await symlink(real, alias, 'junction')
    } catch {
      return
    }
    const lockManager = new WorkspaceLockManager(root)
    assert.ok(lockManager.acquire('run-a', real))
    assert.equal(lockManager.acquire('run-b', alias), null)
  })
})

describe('ApprovalBroker', () => {
  it('routes concurrent approvals by request ID', async () => {
    const requests: string[] = []
    const broker = new ApprovalBroker({
      onRequest: request => requests.push(request.requestId),
      timeoutMs: 1_000,
    })
    const first = broker.request({ taskId: 'task-a', runId: 'run-a', employeeInstanceId: 'employee-a', toolName: 'write', input: {} })
    const second = broker.request({ taskId: 'task-b', runId: 'run-b', employeeInstanceId: 'employee-b', toolName: 'bash', input: {} })

    assert.equal(broker.respond({ requestId: requests[1], approved: false }), true)
    assert.equal(broker.respond({ requestId: requests[0], approved: true }), true)
    assert.equal(await first, true)
    assert.equal(await second, false)
    assert.equal(broker.size, 0)
  })

  it('denies timed out and cancelled approvals', async () => {
    const broker = new ApprovalBroker({ onRequest: () => {}, timeoutMs: 5 })
    const timed = broker.request({ taskId: 'task-a', runId: 'run-a', employeeInstanceId: 'employee-a', toolName: 'write', input: {} })
    assert.equal(await timed, false)

    const pending = broker.request({ taskId: 'task-b', runId: 'run-b', employeeInstanceId: 'employee-b', toolName: 'edit', input: {} })
    broker.denyRun('run-b')
    assert.equal(await pending, false)
  })

  it('supports an ID-less response only for one pending request', async () => {
    const broker = new ApprovalBroker({ onRequest: () => {}, timeoutMs: 1_000 })
    const one = broker.request({ taskId: 'task-a', runId: 'run-a', employeeInstanceId: 'employee-a', toolName: 'write', input: {} })
    assert.equal(broker.respond({ approved: true }), true)
    assert.equal(await one, true)

    const first = broker.request({ taskId: 'task-a', runId: 'run-a', employeeInstanceId: 'employee-a', toolName: 'write', input: {} })
    const second = broker.request({ taskId: 'task-b', runId: 'run-b', employeeInstanceId: 'employee-b', toolName: 'edit', input: {} })
    assert.equal(broker.respond({ approved: true }), false)
    broker.denyAll()
    await Promise.all([first, second])
  })
})
