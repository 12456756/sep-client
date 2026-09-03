/**
 * electron/service/workflow-service.ts — 工作流用例
 *
 * 工作流本身就是一个任务，加一份图定义。图的合法性判定是纯逻辑，
 * 归 `domain/workflow-graph.ts`；这里只做编排。
 */
import type { ClientTask } from '../../src/shared/types'
import type { TaskMetadataStore } from '../data/task-metadata-store'
import type { WorkflowStore } from '../data/workflow-store'
import { createWorkflowGraph, type WorkflowGraph } from '../domain/workflow-graph'
import type { TaskManager } from '../runtime/task-manager'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'
import type { EmployeeAuthorizer } from './employee-authorizer'
import type { TaskExecutionPort } from './task-service'

export interface WorkflowServiceDependencies {
  scope: ScopeSource
  taskManager: TaskManager
  taskMetadataStore: TaskMetadataStore
  workflowStore: WorkflowStore
  employees: EmployeeAuthorizer
  execution: () => Promise<TaskExecutionPort>
}

export interface CreateWorkflowInput {
  title: string
  nodes: unknown[]
  prompt?: string | undefined
  workDir?: string | undefined
}

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDependencies) {}

  /** 只校验图，不落任何东西。渲染进程画图时实时调用。 */
  validate(nodes: unknown[]): WorkflowGraph {
    return createWorkflowGraph(nodes as never)
  }

  /**
   * 建工作流任务：校验图 → 授权首节点的员工 → 建任务 → 落图与元数据。
   * 授权在建任务之前，否则会留下一个永远跑不起来的任务。
   */
  async create(input: CreateWorkflowInput): Promise<{ task: ClientTask; graph: WorkflowGraph }> {
    const graph = this.validate(input.nodes)
    const employee = graph.nodes[0]?.subscriptionId
    if (!employee || !await this.deps.employees.authorize(employee)) {
      throw new AppError('INVALID_ARGUMENT')
    }
    const task = await this.deps.taskManager.createTask(
      input.title,
      input.prompt ?? input.title,
      input.workDir,
      employee,
    )
    const scope = requireScope(this.deps.scope)
    await this.deps.workflowStore.save(scope, task.id, graph)
    await this.deps.taskMetadataStore.save(scope, {
      version: 1,
      taskId: task.id,
      kind: 'workflow',
      participantSubscriptionIds: [...new Set(graph.nodes.map(node => node.subscriptionId))],
      currentSubscriptionId: employee,
      createdAt: Date.now(),
    })
    return { task, graph }
  }

  async get(taskId: string): Promise<WorkflowGraph> {
    await this.requireTask(taskId)
    const graph = await this.deps.workflowStore.load(requireScope(this.deps.scope), taskId)
    if (!graph) throw new AppError('NOT_FOUND', { message: '未找到该工作流。' })
    return graph
  }

  /** 启动：任务与图都必须在，然后走与普通任务同一条执行路径。 */
  async start(taskId: string): Promise<void> {
    await this.requireTask(taskId)
    if (!await this.deps.workflowStore.load(requireScope(this.deps.scope), taskId)) {
      throw new AppError('INVALID_STATE', { message: '需要有效的工作流定义。' })
    }
    await (await this.deps.execution()).executeTask(taskId)
  }

  private async requireTask(taskId: string): Promise<ClientTask> {
    const task = await this.deps.taskManager.getTask(taskId)
    if (!task) throw new AppError('NOT_FOUND', { message: '未找到该任务。' })
    return task
  }
}
