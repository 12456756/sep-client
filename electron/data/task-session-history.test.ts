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
    const run = { id: 'run', sessionFile, sessionId: 'session' }
    const usage = { tokens: 32000, contextWindow: 128000, percent: 25, breakdown: { system: 2000, tools: 5000, messages: 25000 } }
    let historicalUsage: unknown = usage
    const store = { list: async () => [run], getTaskDir: () => taskDir,
      events: { getTimeline: async () => [{ type: 'context_usage', data: usage }, { type: 'context_usage', data: historicalUsage }] },
    } as unknown as TaskRunStorePort
    const scope = { memberId: 'member', enterpriseId: 'enterprise' }
    assert.deepEqual(await readTaskSessionHistory(store, scope, 'task'), { content: 'original history', sessionId: 'session', usage })
    historicalUsage = { ...usage, tokens: '[redacted]' }
    assert.deepEqual(await readTaskSessionHistory(store, scope, 'task'), { content: 'original history', sessionId: 'session', usage })
    historicalUsage = { ...usage, tokens: '[redacted]', percent: 40 }
    assert.deepEqual(await readTaskSessionHistory(store, scope, 'task'), { content: 'original history', sessionId: 'session' })
    historicalUsage = { tokens: null, contextWindow: 128000, percent: null }
    assert.deepEqual(await readTaskSessionHistory(store, scope, 'task'), { content: 'original history', sessionId: 'session' })
    assert.equal(await readFile(sessionFile, 'utf8'), 'original history')
    run.sessionFile = join(root, 'outside.jsonl')
    await writeFile(run.sessionFile, 'other task')
    assert.equal(await readTaskSessionHistory(store, scope, 'task'), null)
    run.sessionFile = join(taskDir, 'missing.jsonl')
    assert.equal(await readTaskSessionHistory(store, scope, 'task'), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
