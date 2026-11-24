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
import { resolveConversationResult } from './conversation-result-file'

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

  async deliverySaveIntents(scope: TaskOwnerScope, taskId: string) {
    const [plan, checkpoint] = await Promise.all([this.plans.get(scope, taskId), this.checkpoints.get(scope, taskId)])
    if (!plan || plan.mode === 'conversation' || !checkpoint || checkpoint.planHash !== plan.planHash) return []
    return checkpoint.state.nodes.flatMap(node => node.status !== 'completed' ? [] : (node.delivery?.finalFiles ?? []).flatMap(file => {
      const planned = plan.nodes.find(item => item.id === node.nodeId)?.deliverables?.find(item => item.id === file.id)
      return file.saveIntent && planned?.path === file.path && planned.format === file.format
        ? [{ nodeId: node.nodeId, deliverableId: file.id, intent: file.saveIntent }] : []
    }))
  }

  async getDeliveryPath(scope: TaskOwnerScope, taskId: string, nodeId: string, deliverableId: string) {
    const delivery = await this.getDelivery(scope, taskId, nodeId, deliverableId)
    if (!delivery || delivery.status !== 'completed') return null
    return (await resolveWorkspaceResult(delivery.workspace, delivery.file.path)).path
  }

  async getConversationPath(scope: TaskOwnerScope, task: TaskReadView, fileId: string) {
    return (await resolveConversationResult(scope, task, fileId))?.path ?? null
  }

  read(scope: TaskOwnerScope, taskId: string, file: FinalDeliveryFile, workspace: string) {
    return readDeliveryPreviewFile(workspace, file, this.paths.taskDir(scope, taskId))
  }

  async readConversation(scope: TaskOwnerScope, task: TaskReadView, fileId: string) {
    const source = await resolveConversationResult(scope, task, fileId)
    if (!source) return null
    const format = extname(source.name).slice(1).toLowerCase()
    if (!supportsDocumentPreview(format)) return null
    const bytes = source.external ? source.bytes : await readWorkspaceFile(source.root, relative(source.root, source.path)).catch((error: unknown) => {
      throw resultFileSystemError(error) ?? error
    })
    return { name: basename(source.path), format, bytes, version: createHash('sha256').update(bytes).digest('hex') }
  }
}
