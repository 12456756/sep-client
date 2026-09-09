/**
 * electron/data/workflow-store.ts — 工作流图的读写
 *
 * 原来 33 行、自己拼路径、原子写没有任何保护（方案 1.3 节）。
 * 现在路径走 `scope-path.ts`、写走 `atomic-file.ts`，与 task-store 同一套语义。
 */
import type { WorkflowGraph } from '../domain/workflow-graph'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'

function parseGraph(value: unknown): WorkflowGraph | null {
  const graph = value as WorkflowGraph | null
  return graph?.version === 1 && Array.isArray(graph.nodes) ? graph : null
}

export class WorkflowStore {
  private readonly paths: ScopePath

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async save(scope: TaskOwnerScope, taskId: string, graph: WorkflowGraph): Promise<void> {
    await writeJsonAtomic(this.paths.workflowFile(scope, taskId), graph)
  }

  async load(scope: TaskOwnerScope, taskId: string): Promise<WorkflowGraph | null> {
    return readJsonWithBackup(this.paths.workflowFile(scope, taskId), parseGraph)
  }
}
