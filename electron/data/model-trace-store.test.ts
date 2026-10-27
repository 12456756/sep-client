import { afterEach, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelTraceStore } from './model-trace-store'

const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(): Promise<ModelTraceStore> {
  const root = await mkdtemp(join(tmpdir(), 'sep-model-trace-'))
  roots.push(root)
  return new ModelTraceStore(root)
}
it('preserves long content, redacts secrets and isolates concurrent requests', async () => {
  const store = await fixture()
  const text = `系统提示词\n${'long-content '.repeat(1000)}Bearer abc-secret\npassword: "hidden"`
  await Promise.all([1, 2].map(requestId => store.append(scope, 'task-a', {
    phase: '第一阶段：已授权员工匹配', kind: 'input', requestId, text, title: '市场报告',
  })))
  const index = await readFile(store.file(scope, 'task-a'), 'utf8')
  assert.match(index, /# 市场报告/)
  assert.match(index, /请求明细/)
  for (const requestId of [1, 2]) {
    const saved = await readFile(store.requestFile(scope, 'task-a', requestId), 'utf8')
    assert.ok(saved.includes('long-content '.repeat(1000)))
    assert.match(saved, /实际模型输入/)
    assert.doesNotMatch(saved, /abc-secret|hidden|\[truncated\]/)
  }
  assert.notEqual(store.file(scope, 'task-a'), store.file({ ...scope, memberId: 'member-b' }, 'task-a'))
  assert.throws(() => store.file(scope, '../escape'))
})
it('replaces streaming snapshots without duplicate text and marks interrupted responses', async () => {
  const store = await fixture()
  const base = { phase: '节点：需求分析', kind: 'output' as const, requestId: 3, streamId: '0', replace: true }
  await store.append(scope, 'task-a', { ...base, text: '第一段' })
  await store.append(scope, 'task-a', { ...base, text: '第一段第二段' })
  await store.append(scope, 'task-a', { phase: base.phase, requestId: 3, kind: 'status', text: '流式响应未正常结束', completed: true })
  const saved = await readFile(store.requestFile(scope, 'task-a', 3), 'utf8')
  assert.equal(saved.match(/第一段/g)?.length, 1)
  assert.match(saved, /未正常结束/)
})
it('does not fail the task when the log directory is unwritable', async () => {
  const store = await fixture()
  const invalid = new ModelTraceStore(join(store.file(scope, 'task-a'), 'invalid'))
  await store.append(scope, 'task-a', { phase: '任务', kind: 'status', text: '开始' })
  await assert.doesNotReject(invalid.append(scope, 'task-a', { phase: '任务', kind: 'status', text: '开始' }))
})
