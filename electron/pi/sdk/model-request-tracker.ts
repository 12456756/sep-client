import { modelRequestProgressSchema, type ModelRequestKind, type ModelRequestProgress } from '../../domain/model-request-progress'

export interface ModelRequestEvent {
  type: string
  reason?: string
  willRetry?: boolean
  aborted?: boolean
}

export interface ModelRequestSnapshot {
  kind: ModelRequestKind
  progress: ModelRequestProgress
}

export type PersistModelRequest = (kind: ModelRequestKind) => Promise<ModelRequestProgress>

export class ModelRequestTracker {
  private retryPending = false
  private compactionActive = false
  private recoveryPending = false
  private hasExecutionInCurrentPrompt = false
  private persistFailure: Error | null = null

  constructor(private readonly persist: PersistModelRequest) {}

  get failure(): Error | null { return this.persistFailure }

  startPrompt(): void {
    this.retryPending = false
    this.recoveryPending = false
    this.compactionActive = false
    this.hasExecutionInCurrentPrompt = false
  }

  observe(event: ModelRequestEvent): void {
    if (event.type === 'compaction_start') {
      this.compactionActive = true
      this.retryPending = false
      return
    }
    if (event.type === 'compaction_end') {
      this.compactionActive = false
      // Preflight compaction may recover a historical error before this prompt has executed.
      this.recoveryPending = this.hasExecutionInCurrentPrompt && event.reason === 'overflow' && event.willRetry === true && event.aborted !== true
      return
    }
    if (event.type === 'auto_retry_start' && !this.compactionActive) this.retryPending = true
    if (event.type === 'auto_retry_end') this.retryPending = false
  }

  async prepare(signal?: AbortSignal): Promise<ModelRequestSnapshot> {
    signal?.throwIfAborted()
    if (this.persistFailure) throw this.persistFailure
    const kind: ModelRequestKind = this.compactionActive
      ? 'compaction'
      : this.recoveryPending
        ? 'recovery'
        : this.retryPending ? 'retry' : 'execution'
    let snapshot: ModelRequestProgress
    try {
      snapshot = modelRequestProgressSchema.parse(await this.persist(kind))
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted()
      this.persistFailure = new Error('节点模型请求计数保存失败，已停止发送模型请求。', { cause: error })
      throw this.persistFailure
    }
    signal?.throwIfAborted()
    if (kind === 'execution') this.hasExecutionInCurrentPrompt = true
    if (kind === 'retry') this.retryPending = false
    if (kind === 'recovery') this.recoveryPending = false
    return { kind, progress: snapshot }
  }
}

export function buildModelRequestAwareness(progress: ModelRequestProgress, kind: ModelRequestKind): string {
  const kindText = kind === 'retry' ? '网关自动重试' : kind === 'recovery' ? '上下文恢复后的继续执行' : '正常执行'
  const roundText = progress.countingScope === 'since-resume'
    ? `当前是本节点自恢复统计起点以来第 ${progress.executionRounds} 次执行模型请求，包含本次；本次请求类型：${kindText}。\n此前执行次数未记录，不得将此数当作节点历史总次数；后续恢复继续累计，已有工作和历史结果仍然有效。`
    : `当前是本节点第 ${progress.executionRounds} 次执行模型请求，包含本次；本次请求类型：${kindText}。`
  return `【当前节点执行情况】
${roundText}
此处统计正常执行、工具操作后的继续执行及交付修正；网关自动重试和上下文超限恢复沿用原轮次，上下文压缩单独统计。
该次数仅用于帮助你了解执行过程，不代表剩余预算、截止期限或应当结束任务的信号。

【执行效率与成果要求】
请根据已有工具结果、已获得的资料和已完成的成果继续推进，避免无意义的重复搜索、重复读取和重复执行已经成功完成的操作。
为核实结果、处理页面变化、遵循 skill 或修复问题所必需的操作，应当正常执行。
不得因为请求次数增加而缩减工作范围、减少交付内容、跳过 skill 要求或必要验证，也不得将未完成的工作声明为完成。
只有确认本节点全部工作完成后，才能按照固定节点要求提交最终 JSON。`
}
