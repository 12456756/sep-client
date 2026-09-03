/**
 * 旧数据可读性（方案 Phase 7 的额外验收项）
 *
 * 「用旧数据目录启动，确认历史任务、run、事件、消息全部可读」。手工做一次只能证明
 * 那一次；这里用**纯 fs** 按 Phase 7 之前的布局手写一棵数据树，再让每个 reader 去读它。
 * 任何一次"归并路径"时的悄悄挪层，都会在这里变红。
 *
 * 刻意不用任何 store 的写入方法来准备数据——否则读写用同一套错误的假设，测试会一起错。
 */
import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStatus } from '../../src/shared/types'
import { encodeTaskScopeSegment } from './scope-path'
import { TaskStore } from './task-store'
import { TaskRunStore } from './task-run-store'
import { projectTaskMessages } from './task-message-projector'
import { WorkflowStore } from './workflow-store'
import { TaskMetadataStore } from './task-metadata-store'

const SCOPE = { memberId: 'member-legacy', enterpriseId: 'enterprise-legacy' }
const TASK_ID = 'task-legacy'
const RUN_ID = 'run-legacy'

const roots: string[] = []

after(async () => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** 按 Phase 7 之前的布局手写一棵 v3 数据树。路径全部是字面量，不经过 ScopePath。 */
async function seedLegacyTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sep-legacy-'))
  roots.push(root)
  const owner = join(
    root, 'task-data', 'v3',
    encodeTaskScopeSegment(SCOPE.enterpriseId, 'enterpriseId'),
    encodeTaskScopeSegment(SCOPE.memberId, 'memberId'),
  )
  const taskDir = join(owner, 'tasks', TASK_ID)
  await mkdir(join(taskDir, 'runs'), { recursive: true })

  await writeFile(join(owner, 'tasks.json'), JSON.stringify({
    version: 3,
    owner: SCOPE,
    updatedAt: 1_000,
    tasks: [{
      id: TASK_ID,
      title: '历史任务',
      prompt: '第一轮问题',
      status: TaskStatus.COMPLETED,
      workDir: '/legacy/workspace',
      createdAt: 1_000,
      startedAt: 1_100,
      completedAt: 1_900,
      error: null,
      files: ['a.txt'],
      logs: [{ timestamp: 1_200, message: '生成文件: a.txt', level: 'info' }],
      ownerId: SCOPE.memberId,
      ownerEnterpriseId: SCOPE.enterpriseId,
      subscriptionId: 'employee-legacy',
      activeRunId: null,
    }],
  }), 'utf8')

  await writeFile(join(taskDir, 'runs', `${RUN_ID}.json`), JSON.stringify({
    version: 3,
    id: RUN_ID,
    taskId: TASK_ID,
    owner: SCOPE,
    subscriptionId: 'employee-legacy',
    modelId: 'model-legacy',
    runtimeKey: 'runtime-legacy',
    workspaceDir: '/legacy/workspace',
    sessionDir: join(taskDir, 'sessions', RUN_ID),
    agentDir: join(taskDir, 'agent-runs', RUN_ID),
    sessionId: 'session-legacy',
    sessionFile: null,
    startedAt: 1_100,
    endedAt: 1_900,
    outcome: 'completed',
    error: null,
    prompt: '第一轮问题',
  }), 'utf8')

  const event = (sequence: number, text: string) => JSON.stringify({
    taskId: TASK_ID, runId: RUN_ID, subscriptionId: 'employee-legacy',
    sequence, type: 'text_delta', occurredAt: 1_000 + sequence, data: { text },
  })
  await writeFile(join(taskDir, 'events.jsonl'), `${event(1, '历史')}\n${event(2, '回答')}\n`, 'utf8')

  await writeFile(join(taskDir, 'workflow.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'n1', subscriptionId: 'employee-legacy', dependsOn: [] }],
  }), 'utf8')

  await writeFile(join(taskDir, 'metadata.json'), JSON.stringify({
    version: 1,
    taskId: TASK_ID,
    kind: 'conversation',
    participantSubscriptionIds: ['employee-legacy'],
    currentSubscriptionId: 'employee-legacy',
    createdAt: 1_000,
  }), 'utf8')

  return root
}

describe('旧数据目录可读（第 11 章硬约束）', () => {
  it('reads history written before the Phase 7 data-layer merge', async () => {
    const root = await seedLegacyTree()

    const taskStore = new TaskStore(root)
    await taskStore.initialize()
    const tasks = await taskStore.load(SCOPE)
    assert.equal(tasks.length, 1, '历史任务必须读得出来')
    assert.equal(tasks[0]?.title, '历史任务')
    assert.deepEqual(tasks[0]?.files, ['a.txt'])
    assert.equal(tasks[0]?.logs[0]?.message, '生成文件: a.txt')

    const runStore = new TaskRunStore(root)
    const runs = await runStore.list(SCOPE, TASK_ID)
    assert.equal(runs.length, 1, '历史 run 必须读得出来')
    assert.equal(runs[0]?.id, RUN_ID)
    assert.equal(runs[0]?.outcome, 'completed')
    assert.equal(runs[0]?.sessionId, 'session-legacy')

    const timeline = await runStore.events.getTimeline(SCOPE, TASK_ID, RUN_ID)
    assert.deepEqual(timeline.map(item => item.sequence), [1, 2], '历史事件必须按序号读出来')

    const messages = await projectTaskMessages({
      listRuns: id => runStore.list(SCOPE, id),
      getTimeline: (id, runId) => runStore.events.getTimeline(SCOPE, id, runId),
    }, TASK_ID, '兜底提示')
    assert.deepEqual(messages.map(message => [message.role, message.content]), [
      ['user', '第一轮问题'],
      ['assistant', '历史回答'],
    ], '历史消息必须投影得出来')

    assert.equal((await new WorkflowStore(root).load(SCOPE, TASK_ID))?.nodes.length, 1)
    assert.equal((await new TaskMetadataStore(root).load(SCOPE, TASK_ID))?.kind, 'conversation')
  })

  it('keeps writing where the old readers looked', async () => {
    // 归并之后写入的位置必须与旧布局一致：读旧数据成功还不够，
    // 新写的数据也得落在同一个地方，否则升级一次就分家了。
    const root = await seedLegacyTree()
    const store = new TaskStore(root)
    await store.initialize()
    const before = await store.load(SCOPE)
    await store.save(SCOPE, [...before, { ...before[0]!, id: 'task-new', title: '新任务' }])

    // 换一个全新实例重读同一个目录——只有写在旧位置才读得回来。
    const reopened = new TaskStore(root)
    await reopened.initialize()
    assert.deepEqual((await reopened.load(SCOPE)).map(task => task.id), [TASK_ID, 'task-new'])
  })
})
