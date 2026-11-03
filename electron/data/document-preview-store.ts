import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
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

  async getDeliveryPath(scope: TaskOwnerScope, taskId: string, nodeId: string, deliverableId: string) {
    const delivery = await this.getDelivery(scope, taskId, nodeId, deliverableId)
    if (!delivery || delivery.status !== 'completed') return null
    return resolveExistingFile(delivery.workspace, delivery.file.path)
  }

  async getConversationPath(scope: TaskOwnerScope, task: TaskReadView, fileId: string) {
    if (task.ownerId !== scope.memberId || task.ownerEnterpriseId !== scope.enterpriseId ||
      task.workType.state !== 'resolved' || task.workType.kind !== 'conversation' || !task.workDir) return null
    const path = task.files.find((_file, index) => `${task.id}-file-${index}` === fileId)
    return path ? resolveExistingFile(task.workDir, path) : null
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

async function resolveExistingFile(workspace: string, filePath: string): Promise<string> {
  const workspacePath = resolve(workspace)
  const root = await realpath(workspacePath)
  const lexical = [workspacePath, root]
    .map(base => relative(base, resolve(base, filePath)))
    .find(path => path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  if (!lexical) throw new Error('UNSAFE_PATH')
  const requested = resolve(root, lexical)
  const segments = lexical.split(sep)
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment)
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || (index === segments.length - 1 ? !entry.isFile() : !entry.isDirectory())) throw new Error('UNSAFE_PATH')
  }
  const info = await lstat(requested)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('UNSAFE_PATH')
  const actual = await realpath(requested)
  const inside = relative(root, actual)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('UNSAFE_PATH')
  return actual
}
