/**
 * 所有任务数据和默认工作区的路径推导。
 *
 * 路径都从认证作用域派生，并在返回前检查仍位于该作用域目录内：
 *
 * ```
 * <userData>/
 * ├── task-data/v3/<ent>/<mem>/
 * │   ├── tasks.json                      任务快照（TaskStore）
 * │   └── tasks/<taskId>/
 * │       ├── runs/<runId>.json           run 记录
 * │       ├── events.jsonl                事件日志（按 task 一个文件）
 * │       ├── sessions/<runId>/           pi 会话目录
 * │       ├── agent-runs/<runId>/         pi agent 目录
 * │       ├── conversation/pi-session/    对话任务的任务级共享会话
 * │       ├── conversation/pi-agent/
 * │       ├── work-plan.json              已确认的安排方案
 * │       ├── arrangement-checkpoint.json 安排执行检查点
 * │       └── metadata.json               任务元数据
 * └── task-workspaces/v1/<ent>/<mem>/<taskId>/   workDir 未指定时的默认工作区
 * ```
 *
 * 任务目录只接收真实 taskId；run、对话会话和安排方案各自使用明确的路径方法。
 */
import { join, resolve, sep } from 'node:path'

/**
 * 数据归属范围。所有持久化路径都从它派生，所以"跨租户读到别人的数据"这件事
 * 在路径层面就被排除了——不是靠查询时过滤。
 */
export interface TaskOwnerScope {
  memberId: string
  enterpriseId: string
}

export class TaskScopeError extends Error {
  constructor(message = 'A valid authenticated task scope is required.') {
    super(message)
    this.name = 'TaskScopeError'
  }
}

const MAX_SCOPE_SEGMENT_LENGTH = 256

function validateScopeSegment(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SCOPE_SEGMENT_LENGTH ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..'
  ) {
    throw new TaskScopeError(`Invalid task scope ${name}.`)
  }
}

/** scope 段编码成路径段。base64url 不含分隔符，所以编码后一定是单层目录名。 */
export function encodeTaskScopeSegment(value: string, name: string): string {
  validateScopeSegment(value, name)
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** run / task 标识符的唯一形状约束。用于路径段，所以不能含分隔符或点号。 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function assertSafeId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new TaskScopeError(`Invalid ${name}.`)
}

export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value)
}

/** 目标必须落在 scope 自己的子树内。防的是构造出来的 `..` 逃逸。 */
function assertContained(root: string, target: string): void {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new TaskScopeError('Task run path escaped its owner scope.')
  }
}

export interface TaskRunPaths {
  taskDir: string
  runFile: string
  sessionDir: string
  agentDir: string
}

export interface ConversationSessionPaths {
  sessionDir: string
  agentDir: string
}

export class ScopePath {
  private readonly taskDataRoot: string
  private readonly workspaceRoot: string

  constructor(userDataDir: string) {
    this.taskDataRoot = join(userDataDir, 'task-data', 'v3')
    this.workspaceRoot = join(userDataDir, 'task-workspaces', 'v1')
  }

  /** v3 数据根。只有初始化时的 mkdir 用得到，其余一律走带 scope 的方法。 */
  dataRoot(): string {
    return this.taskDataRoot
  }

  /** 某个 scope 的数据根。所有 task-data 路径都必须落在它下面。 */
  ownerRoot(scope: TaskOwnerScope): string {
    return join(
      this.taskDataRoot,
      encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId'),
      encodeTaskScopeSegment(scope.memberId, 'memberId'),
    )
  }

  /** scope 级的写串行化键。与目录同源，避免"路径按 scope 编码而锁不按"。 */
  scopeKey(scope: TaskOwnerScope): string {
    return `${encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId')}:${encodeTaskScopeSegment(scope.memberId, 'memberId')}`
  }

  /** 任务快照文件。 */
  taskSnapshotFile(scope: TaskOwnerScope): string {
    return join(this.ownerRoot(scope), 'tasks.json')
  }

  /** 所有任务目录的父目录。崩溃恢复要遍历它。 */
  tasksRoot(scope: TaskOwnerScope): string {
    return join(this.ownerRoot(scope), 'tasks')
  }

  /** 单个任务的目录。**只要 taskId**——不再借位一个假 runId。 */
  taskDir(scope: TaskOwnerScope, taskId: string): string {
    assertSafeId(taskId, 'taskId')
    const ownerRoot = this.ownerRoot(scope)
    const path = join(ownerRoot, 'tasks', taskId)
    assertContained(ownerRoot, path)
    return path
  }

  /** 事件日志。按 task 一个文件，run 靠事件里的 runId 区分。 */
  eventFile(scope: TaskOwnerScope, taskId: string): string {
    return join(this.taskDir(scope, taskId), 'events.jsonl')
  }

  workPlanFile(scope: TaskOwnerScope, taskId: string): string {
    return join(this.taskDir(scope, taskId), 'work-plan.json')
  }

  arrangementCheckpointFile(scope: TaskOwnerScope, taskId: string): string {
    return join(this.taskDir(scope, taskId), 'arrangement-checkpoint.json')
  }

  metadataFile(scope: TaskOwnerScope, taskId: string): string {
    return join(this.taskDir(scope, taskId), 'metadata.json')
  }

  clientMonitorRoot(scope: TaskOwnerScope): string {
    return join(this.ownerRoot(scope), 'client-monitor')
  }

  clientMonitorFile(scope: TaskOwnerScope, taskId: string): string {
    assertSafeId(taskId, 'taskId')
    return join(this.clientMonitorRoot(scope), taskId + '.json')
  }

  arrangementDraftsRoot(scope: TaskOwnerScope): string {
    return join(this.ownerRoot(scope), 'arrangement-drafts')
  }

  arrangementDraftFile(scope: TaskOwnerScope, draftId: string): string {
    assertSafeId(draftId, 'draftId')
    const ownerRoot = this.ownerRoot(scope)
    const path = join(this.arrangementDraftsRoot(scope), `${draftId}.json`)
    assertContained(ownerRoot, path)
    return path
  }

  /** 一个 run 的四个路径。 */
  runPaths(scope: TaskOwnerScope, taskId: string, runId: string): TaskRunPaths {
    assertSafeId(runId, 'runId')
    const ownerRoot = this.ownerRoot(scope)
    const taskDir = this.taskDir(scope, taskId)
    const paths: TaskRunPaths = {
      taskDir,
      runFile: join(taskDir, 'runs', `${runId}.json`),
      sessionDir: join(taskDir, 'sessions', runId),
      agentDir: join(taskDir, 'agent-runs', runId),
    }
    for (const path of Object.values(paths)) assertContained(ownerRoot, path)
    return paths
  }

  /** run 记录所在目录。列举 run 时用。 */
  runsDir(scope: TaskOwnerScope, taskId: string): string {
    return join(this.taskDir(scope, taskId), 'runs')
  }

  /** 对话任务的任务级共享会话。它不属于任何单个 run，所以不经过 runPaths。 */
  conversationSessionPaths(scope: TaskOwnerScope, taskId: string): ConversationSessionPaths {
    const ownerRoot = this.ownerRoot(scope)
    const taskDir = this.taskDir(scope, taskId)
    const paths: ConversationSessionPaths = {
      sessionDir: join(taskDir, 'conversation', 'pi-session'),
      agentDir: join(taskDir, 'conversation', 'pi-agent'),
    }
    for (const path of Object.values(paths)) assertContained(ownerRoot, path)
    return paths
  }

  /**
   * `workDir` 未指定时的默认工作区。注意它在 `task-workspaces/v1` 那棵树下，
   * 不在 `task-data` 里——工作区是 pi 真正干活的地方，可能很大，与数据分开放。
   */
  defaultWorkspaceDir(scope: TaskOwnerScope, taskId: string): string {
    assertSafeId(taskId, 'taskId')
    const ownerRoot = join(
      this.workspaceRoot,
      encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId'),
      encodeTaskScopeSegment(scope.memberId, 'memberId'),
    )
    const path = join(ownerRoot, taskId)
    assertContained(ownerRoot, path)
    return path
  }
}
