import { join } from 'node:path'
import { skillRewriteOutputSchema, splitSkillRewriteSource, type SkillRewriteOutput } from '../../src/shared/skill-rewrite'
import { SKILL_REWRITE_RULES, type SkillRewritePort, type SkillRewriteRuntimeInput } from '../domain/skill-rewrite'
import { PiTaskWorker, type PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import type { TaskWorkerPort } from './run-types'
import { settleWithTimeout } from '../common/with-timeout'
import { AppError } from '../errors/app-error'
import { logger } from '../common/logger'

interface Options {
  gatewayUrl: string
  workspaceRoot: string
  getRefreshToken(): string
  onAuthenticationRequired(): void
  createWorker?: (options: PiTaskWorkerOptions) => TaskWorkerPort
}

export class PiSkillRewriter implements SkillRewritePort {
  constructor(private readonly options: Options) {}

  async rewrite(input: SkillRewriteRuntimeInput, signal: AbortSignal): Promise<SkillRewriteOutput> {
    signal.throwIfAborted()
    let result: SkillRewriteOutput | undefined
    let corrections = 0
    const workerOptions: PiTaskWorkerOptions = {
      context: {
        taskId: input.requestId, runId: input.requestId, subscriptionId: input.subscriptionId,
        modelId: input.modelId, gatewayUrl: this.options.gatewayUrl,
        workspaceDir: this.options.workspaceRoot, agentDir: join(this.options.workspaceRoot, input.requestId, 'agent'),
        sessionDir: join(this.options.workspaceRoot, input.requestId, 'sessions'),
        disableTools: true, disableSkills: true, fixedSystemPrompt: SKILL_REWRITE_RULES,
      },
      getRefreshToken: this.options.getRefreshToken,
      onAuthenticationRequired: this.options.onAuthenticationRequired,
      onApprovalRequest: async () => false,
      onEvent: () => undefined,
      onResponseSettled: async response => {
        signal.throwIfAborted()
        result = undefined
        try {
          if (response.text.length > 200_000 || response.stopReason && response.stopReason !== 'stop') throw new Error('incomplete-response')
          const parsed = skillRewriteOutputSchema.parse(JSON.parse(response.text) as unknown)
          if (splitSkillRewriteSource(parsed.body).metadata) throw new Error('metadata-in-body')
          result = parsed
        } catch {
          if (++corrections > 2 || response.stopReason === 'error' || response.stopReason === 'aborted') {
            throw new AppError('SKILL_REWRITE_FAILED')
          }
          return { continueWith: '输出未通过校验。请按系统约定重新提交完整 JSON，body 只包含完整 Markdown 正文，不含 frontmatter，不使用代码围栏，不执行工具。' }
        }
      },
    }
    const worker = this.options.createWorker?.(workerOptions) ?? new PiTaskWorker(workerOptions)
    let abort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        void settleWithTimeout(worker.abort(), 5_000, 'skill-rewrite-abort')
        reject(new AppError('SKILL_REWRITE_CANCELLED'))
      }
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const material = {
        skillName: input.skillName, body: splitSkillRewriteSource(input.content).body, prompt: input.prompt,
        history: input.history.map(item => ({ ...item, content: splitSkillRewriteSource(item.content).body })),
      }
      await Promise.race([worker.run(JSON.stringify(material)), aborted])
      signal.throwIfAborted()
      if (!result) throw new AppError('SKILL_REWRITE_FAILED')
      return result
    } finally {
      signal.removeEventListener('abort', abort)
      const cleanup = await settleWithTimeout(worker.dispose(), 5_000, 'skill-rewrite-dispose')
      if (!cleanup.ok) logger.child('skill-rewrite').warn('worker cleanup did not finish', { timedOut: cleanup.timedOut })
    }
  }
}
