import * as assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TaskManager } from './task-manager'

test('a confirmation reservation creates one durable task under concurrent retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-reserved-task-'))
  try {
    const manager = new TaskManager(root)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const outcomes = await Promise.allSettled([
      manager.createTask('first', 'first prompt', undefined, 'employee-a', 'reserved-a'),
      manager.createTask('second', 'second prompt', undefined, 'employee-a', 'reserved-a'),
    ])
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
    const task = await manager.getTask('reserved-a')
    assert.ok(task)
    assert.equal(task.title, 'first')
    assert.ok((await stat(task.workDir!)).isDirectory())
    const restored = new TaskManager(root)
    await restored.initialize()
    await restored.setCurrentUser('member-a', 'enterprise-a')
    assert.equal((await restored.getTask('reserved-a'))?.prompt, 'first prompt')
    await assert.rejects(manager.createTask('third', 'third', undefined, null, 'reserved-a'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
