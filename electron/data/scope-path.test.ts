/**
 * 目录布局的回归测试。
 *
 * 方案第 11 章把"不改持久化文件格式与目录布局"列为硬约束——旧数据必须能直接读。
 * Phase 7 把四处路径拼接归并成 `ScopePath`，最容易犯的错就是在归并过程中悄悄挪一层。
 * 这里把**每一条路径逐字钉死**：改动它必须是一次有意识的决定，而不是重构的副作用。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ScopePath, TaskScopeError, encodeTaskScopeSegment } from './scope-path'

const SCOPE = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const ENT = encodeTaskScopeSegment(SCOPE.enterpriseId, 'enterpriseId')
const MEM = encodeTaskScopeSegment(SCOPE.memberId, 'memberId')
const ROOT = '/data'

/** 断言用正斜杠比较，与平台分隔符无关。 */
function normalize(path: string): string {
  return path.replaceAll('\\', '/')
}

describe('ScopePath 的目录布局（第 11 章硬约束）', () => {
  const paths = new ScopePath(ROOT)
  const owner = `/data/task-data/v3/${ENT}/${MEM}`

  it('pins every task-data path', () => {
    assert.equal(normalize(paths.ownerRoot(SCOPE)), owner)
    assert.equal(normalize(paths.taskSnapshotFile(SCOPE)), `${owner}/tasks.json`)
    assert.equal(normalize(paths.tasksRoot(SCOPE)), `${owner}/tasks`)
    assert.equal(normalize(paths.taskDir(SCOPE, 'task-1')), `${owner}/tasks/task-1`)
    assert.equal(normalize(paths.eventFile(SCOPE, 'task-1')), `${owner}/tasks/task-1/events.jsonl`)
    assert.equal(normalize(paths.workflowFile(SCOPE, 'task-1')), `${owner}/tasks/task-1/workflow.json`)
    assert.equal(normalize(paths.metadataFile(SCOPE, 'task-1')), `${owner}/tasks/task-1/metadata.json`)
    assert.equal(normalize(paths.runsDir(SCOPE, 'task-1')), `${owner}/tasks/task-1/runs`)
  })

  it('pins the four per-run paths', () => {
    const run = paths.runPaths(SCOPE, 'task-1', 'run-1')
    assert.equal(normalize(run.taskDir), `${owner}/tasks/task-1`)
    assert.equal(normalize(run.runFile), `${owner}/tasks/task-1/runs/run-1.json`)
    assert.equal(normalize(run.sessionDir), `${owner}/tasks/task-1/sessions/run-1`)
    assert.equal(normalize(run.agentDir), `${owner}/tasks/task-1/agent-runs/run-1`)
  })

  it('pins the task-level shared conversation session', () => {
    const conversation = paths.conversationSessionPaths(SCOPE, 'task-1')
    assert.equal(normalize(conversation.sessionDir), `${owner}/tasks/task-1/conversation/pi-session`)
    assert.equal(normalize(conversation.agentDir), `${owner}/tasks/task-1/conversation/pi-agent`)
  })

  it('keeps the default workspace out of the task-data tree', () => {
    // 工作区是 pi 真正干活的地方，可能很大，与数据分开放。
    assert.equal(
      normalize(paths.defaultWorkspaceDir(SCOPE, 'task-1')),
      `/data/task-workspaces/v1/${ENT}/${MEM}/task-1`,
    )
  })

  it('derives the task directory from taskId alone', () => {
    // Phase 7 之前想拿 taskDir 得先编一个假 runId（getPaths(scope, taskId, 'store')），
    // 于是一个非法 runId 会在完全无关的调用里通过校验。
    assert.equal(normalize(paths.taskDir(SCOPE, 'task-1')), `${owner}/tasks/task-1`)
  })
})

describe('ScopePath 的越界防护', () => {
  const paths = new ScopePath(ROOT)

  it('rejects ids that could escape the scope subtree', () => {
    for (const bad of ['..', '.', 'a/b', 'a\\b', '', 'x'.repeat(129), 'has.dot']) {
      assert.throws(() => paths.taskDir(SCOPE, bad), TaskScopeError, `taskId ${JSON.stringify(bad)} 应被拒绝`)
    }
  })

  it('rejects run ids separately from task ids', () => {
    assert.throws(() => paths.runPaths(SCOPE, 'task-1', '../escape'), TaskScopeError)
  })

  it('rejects scope segments containing separators', () => {
    assert.throws(() => paths.ownerRoot({ memberId: 'a/b', enterpriseId: 'e' }), TaskScopeError)
    assert.throws(() => paths.ownerRoot({ memberId: 'm', enterpriseId: '..' }), TaskScopeError)
  })
})
