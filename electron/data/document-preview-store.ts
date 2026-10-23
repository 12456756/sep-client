import type { WorkPlanStorePort } from './work-plan-store'
import type { ArrangementCheckpointStorePort } from './arrangement-checkpoint-store'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { readDeliveryPreviewFile } from './arrangement-delivery-files'
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
}
