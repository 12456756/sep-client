import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, relative } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { supportsDocumentPreview } from '../../src/shared/document-preview'
import type { TaskReadView } from '../../src/shared/types'
import type { WorkPlanStorePort } from './work-plan-store'
import type { ArrangementCheckpointStorePort } from './arrangement-checkpoint-store'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { readDeliveryPreviewFile, readWorkspaceFile } from './arrangement-delivery-files'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'
import { AppError } from '../errors/app-error'
import { resultFileSystemError } from '../errors/result-file-path-error'
import { resolveWorkspaceResult } from './workspace-result-path'

export async function writeWordCopy(path: string, bytes: Uint8Array, format: string): Promise<void> {
  if (!isAbsolute(path)) throw new AppError('INVALID_ARGUMENT')
  const extension = extname(path)
  if (extension && extension.toLowerCase() !== '.' + format) throw new AppError('INVALID_ARGUMENT', { message: '请保留原 Word 文件的扩展名。' })
  try { await writeFile(extension ? path : path + '.' + format, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('INVALID_ARGUMENT', { message: '目标文件已存在，请选择其他名称。' })
    throw new AppError('INTERNAL_ERROR', { message: '无法保存 Word 文件，请检查目标目录权限和可用空间。', cause: error })
  }
}

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
    return (await resolveWorkspaceResult(delivery.workspace, delivery.file.path)).path
  }

  async getConversationPath(scope: TaskOwnerScope, task: TaskReadView, fileId: string) {
    if (task.ownerId !== scope.memberId || task.ownerEnterpriseId !== scope.enterpriseId ||
      task.workType.state !== 'resolved' || task.workType.kind !== 'conversation' || !task.workDir) return null
    const path = task.files.find((_file, index) => `${task.id}-file-${index}` === fileId)
    return path ? (await resolveWorkspaceResult(task.workDir, path)).path : null
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
    const source = await resolveWorkspaceResult(task.workDir, path)
    const bytes = await readWorkspaceFile(source.root, relative(source.root, source.path)).catch((error: unknown) => {
      throw resultFileSystemError(error) ?? error
    })
    return { name: basename(source.path), format, bytes, version: createHash('sha256').update(bytes).digest('hex') }
  }
}
