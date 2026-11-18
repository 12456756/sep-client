import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskRunStorePort } from './task-run-store'
import { readTaskSessionHistory } from './task-session-history'

test('reads the latest task session without modifying it and refuses files outside its task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-context-usage-'))
  try {
    const taskDir = join(root, 'task')
    await mkdir(taskDir)
    const sessionFile = join(taskDir, 'session.jsonl')
    await writeFile(sessionFile, 'original history')
    const run = { sessionFile, sessionId: 'session' }
    const store = { list: async () => [run], getTaskDir: () => taskDir } as unknown as TaskRunStorePort
    const scope = { memberId: 'member', enterpriseId: 'enterprise' }
    assert.deepEqual(await readTaskSessionHistory(store, scope, 'task'), { content: 'original history', sessionId: 'session' })
    assert.equal(await readFile(sessionFile, 'utf8'), 'original history')
    run.sessionFile = join(root, 'outside.jsonl')
    await writeFile(run.sessionFile, 'other task')
    assert.equal(await readTaskSessionHistory(store, scope, 'task'), null)
    run.sessionFile = join(taskDir, 'missing.jsonl')
    assert.equal(await readTaskSessionHistory(store, scope, 'task'), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
