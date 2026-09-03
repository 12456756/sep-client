/**
 * electron/runtime/event-pipeline.ts — 事件串行化 + drain() + 派生状态（C6）
 *
 * 三件事都是"从事件流里长出来的"，所以在一处：
 *   1. **串行化**：同一 taskId 的事件严格按到达顺序处理（不变式 I4）。
 *   2. **drain()**：等到该 task 的事件链真正排空。C6 的一半——原来 `startRun` 只
 *      `await this.eventChains.get(taskId)` 一次，那不是屏障：等待期间接上来的新事件
 *      不在这次等待里，于是"run 结束时事件已落盘"根本不成立。
 *   3. **派生状态**：`text_delta` 累积成助手回复；`tool_execution_start/end` 维护
 *      in-flight 的副作用工具。后者是 C3 / 不变式 I7 的依据——停机时每个还没收到
 *      `tool_execution_end` 的副作用调用都必须产出一条 `SIDE_EFFECT_UNKNOWN`，
 *      否则下次启动无法判定副作用是否已发生。
 *
 * C6 的另一半在错误处理上：链条错误此前被 `prior.catch(() => undefined)` 完全吞掉，
 * 事件既没落盘、没到渲染进程，也没有任何日志。现在错误交回调用方**并且**记 error。
 */
import type { TaskExecutionEvent } from '../../src/shared/types'
import { hasSideEffects } from '../common/constants'
import { describeError } from '../common/redact'
import { logger } from '../common/logger'

const log = logger.child('event-pipeline')

/** drain 的轮数上限。只为防跑飞的事件流把停机拖死，正常情况下一两轮就空了。 */
const MAX_DRAIN_ROUNDS = 1_000

export interface PendingSideEffect {
  toolName: string
  startedAt: number
}

export interface EventPipelineOptions {
  /** 每条事件的实际处理。串行化由本类保证，这里只管一条。 */
  handle: (event: TaskExecutionEvent) => Promise<void>
}

export class EventPipeline {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly responses = new Map<string, string>()
  private readonly inFlightSideEffects = new Map<string, Map<string, PendingSideEffect>>()

  constructor(private readonly options: EventPipelineOptions) {}

  /** 按 taskId 串行处理。返回的 promise 会带回处理错误（C6：不再吞）。 */
  enqueue(event: TaskExecutionEvent): Promise<void> {
    const prior = this.chains.get(event.taskId) ?? Promise.resolve()
    const operation = prior.catch(() => undefined).then(() => this.options.handle(event))
    const chain = operation.then(() => undefined)
    this.chains.set(event.taskId, chain)
    // chain 是 operation 的分支，不接就是一条未处理拒绝；但错误本身要记下来
    // ——事件落盘失败此前完全无痕（C6）。
    void chain
      .catch((error: unknown) => {
        log.error('failed to persist task event', {
          taskId: event.taskId,
          runId: event.runId,
          type: event.type,
          cause: describeError(error),
        })
      })
      .finally(() => {
        if (this.chains.get(event.taskId) === chain) this.chains.delete(event.taskId)
      })
    return operation
  }

  /**
   * 等到该 task 的事件链真正排空。循环到链表项消失为止——链条 settle 时自己会把
   * map 项删掉，所以"取不到链"就等于排空了。
   */
  async drain(taskId: string): Promise<void> {
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
      const chain = this.chains.get(taskId)
      if (!chain) return
      await chain.catch(() => undefined)
    }
    log.warn('event chain did not drain', { taskId })
  }

  // ── 从事件流派生的 per-run 状态 ─────────────────────────────────────────────

  /** 累积 `text_delta`。整段回复在 run 收尾时作为助手消息落进对话上下文。 */
  appendResponse(runId: string, text: string): void {
    this.responses.set(runId, `${this.responses.get(runId) ?? ''}${text}`)
  }

  /** 取出并清掉累积的回复。 */
  takeResponse(runId: string): string | undefined {
    const response = this.responses.get(runId)
    this.responses.delete(runId)
    return response
  }

  /** 记下一个开始执行的副作用工具。非副作用工具不记——它们不需要 SIDE_EFFECT_UNKNOWN。 */
  sideEffectStarted(runId: string, toolId: string, toolName: string, startedAt: number): void {
    if (!hasSideEffects(toolName)) return
    let pending = this.inFlightSideEffects.get(runId)
    if (!pending) {
      pending = new Map()
      this.inFlightSideEffects.set(runId, pending)
    }
    pending.set(toolId, { toolName, startedAt })
  }

  /** 收到 `tool_execution_end`：这次调用的结果已知，不再是 in-flight。 */
  sideEffectEnded(runId: string, toolId: string): void {
    this.inFlightSideEffects.get(runId)?.delete(toolId)
  }

  /** 仍然 in-flight 的副作用调用。停机与失败收尾时逐条产出 SIDE_EFFECT_UNKNOWN（I7）。 */
  pendingSideEffects(runId: string): [string, PendingSideEffect][] {
    return Array.from(this.inFlightSideEffects.get(runId) ?? [])
  }

  /** run 收尾：丢掉它的派生状态，避免长驻进程里无限积累。 */
  forgetRun(runId: string): void {
    this.responses.delete(runId)
    this.inFlightSideEffects.delete(runId)
  }
}
