import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { encodeTaskScopeSegment, type TaskOwnerScope } from './task-store'
import type { WorkflowGraph } from '../domain/workflow-graph'

export class WorkflowStore {
  constructor(private readonly userDataDir: string) {}

  private file(scope: TaskOwnerScope, taskId: string): string {
    return join(this.userDataDir, 'task-data', 'v3', encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId'), encodeTaskScopeSegment(scope.memberId, 'memberId'), 'tasks', taskId, 'workflow.json')
  }

  async save(scope: TaskOwnerScope, taskId: string, graph: WorkflowGraph): Promise<void> {
    const file = this.file(scope, taskId)
    const temporary = `${file}.${randomUUID()}.tmp`
    await mkdir(join(file, '..'), { recursive: true })
    try {
      await writeFile(temporary, JSON.stringify(graph), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async load(scope: TaskOwnerScope, taskId: string): Promise<WorkflowGraph | null> {
    try {
      const graph = JSON.parse(await readFile(this.file(scope, taskId), 'utf8')) as WorkflowGraph
      return graph?.version === 1 && Array.isArray(graph.nodes) ? graph : null
    } catch { return null }
  }
}
