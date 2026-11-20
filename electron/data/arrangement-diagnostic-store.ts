import { join } from 'node:path'
import { workDiagnosticRequest, workDiagnosticSchema, type WorkDiagnostic, type WorkDiagnosticRequest } from '../domain/arrangement-diagnostic'
import { readJsonFile, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'

export class ArrangementDiagnosticStore {
  private readonly paths: ScopePath
  constructor(userDataDir: string) { this.paths = new ScopePath(userDataDir) }

  private file(owner: TaskOwnerScope, input: WorkDiagnosticRequest): string {
    const request = workDiagnosticRequest.parse(input)
    const name = 'nodeRunId' in request ? request.nodeRunId : `conversation.${request.runId}`
    return join(this.paths.taskDir(owner, request.taskId), 'failure-diagnostics', `${name}.json`)
  }

  async save(owner: TaskOwnerScope, diagnostic: WorkDiagnostic): Promise<void> {
    const input = 'nodeRunId' in diagnostic
      ? { taskId: diagnostic.taskId, nodeId: diagnostic.nodeId, nodeRunId: diagnostic.nodeRunId }
      : { taskId: diagnostic.taskId, runId: diagnostic.runId }
    await writeJsonAtomic(this.file(owner, input), workDiagnosticSchema.parse(diagnostic), { backup: false })
  }

  async get(owner: TaskOwnerScope, input: WorkDiagnosticRequest): Promise<WorkDiagnostic | null> {
    const { data: diagnostic } = workDiagnosticSchema.safeParse(await readJsonFile(this.file(owner, input)))
    if (!diagnostic || diagnostic.taskId !== input.taskId) return null
    if ('runId' in input) return 'runId' in diagnostic && diagnostic.runId === input.runId ? diagnostic : null
    return 'nodeRunId' in diagnostic && diagnostic.nodeId === input.nodeId && diagnostic.nodeRunId === input.nodeRunId ? diagnostic : null
  }

  exportFile(file: string, diagnostic: WorkDiagnostic): Promise<void> {
    return writeJsonAtomic(file, workDiagnosticSchema.parse(diagnostic), { backup: false, restoreBackupOnFailure: false })
  }
}
