import { createHash } from 'node:crypto'
import { basename, extname, relative, resolve } from 'node:path'
import { supportsDocumentPreview } from '../../src/shared/document-preview'
import type { TaskReadView } from '../../src/shared/types'
import type { WorkPlanStorePort } from './work-plan-store'
import type { ArrangementCheckpointStorePort } from './arrangement-checkpoint-store'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { readDeliveryPreviewFile, readWorkspaceFile } from './arrangement-delivery-files'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'

export class DocumentPreviewStore {
  private readonly paths: ScopePath
  constructor(root: string, private readonly plans: WorkPlanStorePort, private readonly checkpoints: ArrangementCheckpointStorePort) {
    this.paths = new ScopePath(root)
  }

  async getDelivery(scope: TaskOwnerScope, taskId: string, nodeId: string, deliverableId: string) {
    const [plan, checkpoint] = await Promise.all([this.plans.get(scope, taskId), this.checkpoints.get(scope, taskId)])
    if (!plan || plan.mode === 'conversation' || !checkpoint || checkpoint.planHash !== plan.planHash) return null
    const planned = plan.nodes.find(node => node.id === nodeId)?.deliverables?.find(file => file.id === deliverableId)
    const node = checkpoint.state.nodes.find(node => node.nodeId === nodeId)
    const file = node?.delivery?.finalFiles.find(file => file.id === deliverableId)
    if (!planned || !node || !file || file.path !== planned.path || file.format !== planned.format) return null
    return { status: node.status, file, workspace: plan.workspace.path ?? '' }
  }

  read(scope: TaskOwnerScope, taskId: string, file: FinalDeliveryFile, workspace: string) {
    return readDeliveryPreviewFile(workspace, file, this.paths.taskDir(scope, taskId))
  }

  async readConversation(scope: TaskOwnerScope, task: TaskReadView, fileId: string) {
    if (task.ownerId !== scope.memberId || task.ownerEnterpriseId !== scope.enterpriseId ||
      task.workType.state !== 'resolved' || task.workType.kind !== 'conversation' || !task.workDir) return null
    const path = task.files.find((_file, index) => `${task.id}-file-${index}` === fileId)
    if (!path) return null
    const format = extname(path).slice(1).toLowerCase()
    if (!supportsDocumentPreview(format)) return null
    const workspace = resolve(task.workDir)
    const localPath = relative(workspace, resolve(workspace, path))
    const bytes = await readWorkspaceFile(workspace, localPath)
    return { name: basename(path), format, bytes, version: createHash('sha256').update(bytes).digest('hex') }
  }
}
