import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { logger, type LogFields } from '../common/logger'
import { planningErrorFields, planningFailure, type PlanningPhase } from '../errors/planning-diagnostics'
import { AppError } from '../errors/app-error'
import type { TaskExecutionEvent } from '../../src/shared/types'
import {
  buildArrangementPlannerPrompt,
  parseArrangementPlannerOutput,
  type ArrangementPlannerEmployee,
  type ArrangementPlannerPort,
  type ArrangementPlanningProgress,
  type ArrangementPlanningResult,
} from '../domain/arrangement-planner'
import type { PiAgentRuntime } from '../pi/sdk/pi-agent-runtime'
import { PiTaskWorker, type PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import type { TaskToolPolicy, TaskWorkerPort } from './run-types'

export interface ArrangementPlannerRuntimeOptions {
  gatewayUrl: string
  workspaceRoot: string
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  runtime?: PiAgentRuntime
  createWorker?: (options: PiTaskWorkerOptions) => TaskWorkerPort
  plannerSubscriptionId?: string
  plannerModelId?: string
  additionalSkillPaths?: readonly string[]
  getAgentDir?: (planningId: string) => string
  getSessionDir?: (planningId: string) => string
}

export interface ArrangementPlannerWorkerContext {
  planningId: string
  subscriptionId: string
  modelId: string
  workspaceDir: string
  agentDir: string
  sessionDir: string
}

const PLANNER_POLICY: Omit<TaskToolPolicy, 'workspaceDir'> = {
  allowedTools: [],
  allowedPaths: [],
  deniedPaths: [],
  commandPolicy: 'disabled',
  approvalMode: 'auto-approve',
}

const log = logger.child('arrangement-planner')

/**
 * Runs the arrangement planner in a private Pi session.
 *
 * This is deliberately a runtime adapter: service code only depends on the
 * ArrangementPlannerPort and never sees PiTaskWorker or Pi SDK types.
 */
export class PiArrangementPlanner implements ArrangementPlannerPort {
  private readonly planningControllers = new Map<string, AbortController>()

  constructor(private readonly options: ArrangementPlannerRuntimeOptions) {}

  cancel(planningId: string): void {
    this.planningControllers.get(planningId)?.abort()
  }

  async plan(input: Parameters<ArrangementPlannerPort['plan']>[0]): Promise<ArrangementPlanningResult> {
    const { planningId, draft, employees, plannerEmployees, signal, onProgress } = input
    const context: LogFields = {
      planningId, runId: planningId, draftId: draft.id, draftRevision: draft.revision,
      round: input.diagnosticContext?.round ?? 1,
      employeeScope: input.diagnosticContext?.employeeScope ?? employees[0]?.source ?? 'authorized',
      modelId: input.modelId ?? input.plannerModelId ?? this.options.plannerModelId,
      employeeCount: employees.length, existingNodeCount: draft.nodes.length,
      unresolvedStepCount: draft.unresolvedSteps?.length ?? 0,
    }
    const workerEvents: TaskExecutionEvent[] = []
    let phase: PlanningPhase = 'initialization'
    let phaseStartedAt = Date.now()
    let primaryError = false
    const nextPhase = (next: PlanningPhase, fields: LogFields = {}): void => {
      log.info('planning phase completed', { ...context, phase, elapsedMs: Date.now() - phaseStartedAt, ...fields })
      phase = next
      phaseStartedAt = Date.now()
      log.info('planning phase started', { ...context, phase })
    }
    log.info('planning phase started', { ...context, phase })
    const controller = new AbortController()
    const externalAbortHandler = (): void => controller.abort()
    this.planningControllers.set(planningId, controller)
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', externalAbortHandler, { once: true })
    }

    try {
      const planningSignal = controller.signal
      throwIfAborted(planningSignal)
      const selectedModelId = input.modelId ?? input.plannerModelId ?? this.options.plannerModelId
      const plannerEmployee = selectPlannerEmployee(plannerEmployees ?? employees, this.options, selectedModelId)
      const plannerModelId = selectedModelId ?? plannerEmployee.allowedModels[0] ?? ''
      context.modelId = plannerModelId
      context.subscriptionId = plannerEmployee.subscriptionId
      const prompt = buildArrangementPlannerPrompt(draft, employees)

      // A planner returns JSON, never executes tools. Even a non-compliant gateway
      // must not turn unexpected tool calls into an unbounded agent loop.
      let rejectToolCall!: (error: AppError) => void
      const invalidToolCall = new Promise<never>((_resolve, reject) => { rejectToolCall = reject })
      const worker = this.createWorker(planningId, plannerEmployee, plannerModelId, event => {
        workerEvents.push(event)
        if (event.type === 'tool_execution_start') {
          rejectToolCall(new AppError('PLANNING_FAILED', {
            message: '自动编排模型返回了异常工具调用，已停止规划，请重试。',
            details: { phase: 'provider-request', reason: 'unexpected-tool-call' },
          }))
          return
        }
      })
      let abortHandler: (() => void) | null = null
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortHandler = (): void => {
          void worker.abort().catch(() => undefined)
          reject(createAbortError())
        }
        if (planningSignal.aborted) abortHandler()
        else planningSignal.addEventListener('abort', abortHandler, { once: true })
      })
      let runPromise: Promise<void>
      nextPhase('provider-request', { promptLength: prompt.length })
      try {
        runPromise = worker.run(prompt)
      } catch (error) {
        runPromise = Promise.reject(error)
      }
      // A worker implementation should settle after abort. Keep a rejection
      // handler attached as well so a late SDK rejection cannot become unhandled
      // if the caller's AbortSignal wins the race first.
      void runPromise.catch(() => undefined)

      try {
        await Promise.race([runPromise, abortPromise, invalidToolCall])
        throwIfAborted(planningSignal)
        nextPhase('response-assembly', summarizeWorkerEvents(workerEvents))
        const deltas = workerEvents
          .filter(event => event.type === 'text_delta')
          .map(event => readTextDelta(event.data))
          .filter((value): value is string => value !== null)
          .join('')
        const messageText = workerEvents
          .filter(event => event.type === 'message_end')
          .map(event => readMessageText(event.data))
          .filter((value): value is string => value !== null)
          .join('')
        const text = deltas || messageText
        Object.assign(context, {
          textDeltaLength: deltas.length, messageTextLength: messageText.length,
          responseLength: text.length, responseFingerprint: createHash('sha256').update(text).digest('hex'),
        })
        if (!text.trim()) throw planningFailure('response-assembly', 'empty-response')
        const result = parseArrangementPlannerOutput(text, draft, employees, nextPhase)
        nextPhase('finalization', { nodeCount: result.nodes.length, unresolvedStepCount: result.unresolvedSteps?.length ?? 0 })
        if (result.intentAnalysis) {
          onProgress({
            planningId,
            draftId: draft.id,
            draftRevision: draft.revision,
            type: 'arrangement_plan_ready',
            occurredAt: Date.now(),
            data: {
              stage: 'planning',
              planSummary: result.intentAnalysis.summary,
              planSteps: result.intentAnalysis.steps.map(step => ({ id: step.id, title: step.title })),
            },
          })
        }

        const activeEmployees = employees.filter(employee => employee.status === 'ACTIVE')
        for (const employee of activeEmployees) {
          throwIfAborted(planningSignal)
          onProgress(progressEvent(planningId, draft.id, draft.revision, 'arrangement_employee_considering', employee, {
            stage: 'considering',
          }))
        }

        const selected = new Set<string>()
        for (const node of result.nodes) {
          throwIfAborted(planningSignal)
          if (selected.has(node.subscriptionId)) continue
          const employee = employees.find(candidate => candidate.subscriptionId === node.subscriptionId)
          if (!employee) continue
          selected.add(node.subscriptionId)
          onProgress(progressEvent(planningId, draft.id, draft.revision, 'arrangement_employee_selected', employee, {
            stage: 'selected',
            nodeId: node.id,
            title: node.title,
          }))
        }

        log.info('planning phase completed', { ...context, phase, elapsedMs: Date.now() - phaseStartedAt, nodeCount: result.nodes.length, unresolvedStepCount: result.unresolvedSteps?.length ?? 0 })
        return result
      } catch (error) {
        primaryError = true
        if (isUnsupportedModelError(error)) {
          throw new AppError('PLANNING_FAILED', {
            message: '当前选择的模型未配置在服务端账号组中。请管理员同步可用模型，或选择其他模型后重试。',
            cause: error,
          })
        }
        throw error
      } finally {
        if (abortHandler) planningSignal.removeEventListener('abort', abortHandler)
        await worker.dispose().catch((error: unknown) => {
          log.error('planning cleanup failed', { ...context, ...planningErrorFields(error), phase: 'cleanup' })
          if (!primaryError) {
            phase = 'cleanup'
            throw error
          }
        })
      }
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      const fields = planningErrorFields(error)
      const failurePhase = fields.phase ?? phase
      const details = { ...context, ...summarizeWorkerEvents(workerEvents), ...fields, phase: failurePhase, elapsedMs: Date.now() - phaseStartedAt }
      if (cancelled) log.info('planning cancelled', details)
      else log.error('planning phase failed', details)
      throw error
    } finally {
      if (signal) signal.removeEventListener('abort', externalAbortHandler)
      if (this.planningControllers.get(planningId) === controller) this.planningControllers.delete(planningId)
    }
  }

  private createWorker(
    planningId: string,
    plannerEmployee: ArrangementPlannerEmployee,
    modelId: string,
    onEvent: PiTaskWorkerOptions['onEvent'],
  ): TaskWorkerPort {
    const workspaceDir = this.options.workspaceRoot
    const context: PiTaskWorkerOptions['context'] = {
      taskId: planningId,
      runId: planningId,
      subscriptionId: plannerEmployee.subscriptionId,
      modelId,
      gatewayUrl: this.options.gatewayUrl,
      workspaceDir,
      agentDir: this.options.getAgentDir?.(planningId) ?? join(workspaceDir, '.pi-arrangement-planning', planningId, 'agent'),
      sessionDir: this.options.getSessionDir?.(planningId) ?? join(workspaceDir, '.pi-arrangement-planning', planningId, 'sessions'),
      additionalSkillPaths: this.options.additionalSkillPaths ? [...this.options.additionalSkillPaths] : undefined,
      toolPolicy: {
        ...PLANNER_POLICY,
        allowedPaths: [workspaceDir],
        workspaceDir,
      },
    }

    if (!context.modelId || !plannerEmployee.allowedModels.includes(context.modelId)) {
      throw new Error('The arrangement planner model is not allowed for the selected employee.')
    }

    const workerOptions: PiTaskWorkerOptions = {
      context,
      getRefreshToken: this.options.getRefreshToken,
      onAuthenticationRequired: this.options.onAuthenticationRequired,
      onApprovalRequest: async () => false,
      onEvent,
      runtime: this.options.runtime,
    }
    return this.options.createWorker?.(workerOptions) ?? new PiTaskWorker(workerOptions)
  }
}

function summarizeWorkerEvents(events: readonly TaskExecutionEvent[]): LogFields {
  return {
    eventCount: events.length,
    eventTypes: [...new Set(events.map(event => event.type))],
    textDeltaCount: events.filter(event => event.type === 'text_delta').length,
    messageEndCount: events.filter(event => event.type === 'message_end').length,
    textDeltaLength: events.reduce((length, event) => length + (event.type === 'text_delta' ? readTextDelta(event.data)?.length ?? 0 : 0), 0),
    messageTextLength: events.reduce((length, event) => length + (event.type === 'message_end' ? readMessageText(event.data)?.length ?? 0 : 0), 0),
  }
}

function selectPlannerEmployee(
  employees: readonly ArrangementPlannerEmployee[],
  options: ArrangementPlannerRuntimeOptions,
  modelId?: string,
): ArrangementPlannerEmployee {
  const candidate = options.plannerSubscriptionId
    ? employees.find(employee => employee.subscriptionId === options.plannerSubscriptionId)
    : employees.find(employee => employee.status === 'ACTIVE' && employee.allowedModels.length > 0 && (!modelId || employee.allowedModels.includes(modelId)))
  if (!candidate || candidate.status !== 'ACTIVE' || candidate.allowedModels.length === 0) {
    if (modelId) {
      throw new AppError('MODEL_NOT_ALLOWED', {
        message: '当前选择的模型不属于可用于自动编排的员工，请刷新员工列表后重新选择。',
      })
    }
    throw new Error('No active silicon employee with an allowed model is available for arrangement planning.')
  }
  if (modelId && !candidate.allowedModels.includes(modelId)) {
    throw new AppError('MODEL_NOT_ALLOWED', {
      message: '当前选择的模型不属于可用于自动编排的员工，请刷新员工列表后重新选择。',
    })
  }
  return candidate
}

function isUnsupportedModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message
  const jsonStart = message.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(message.slice(jsonStart)) as unknown
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const value = body as Record<string, unknown>
        if (value.type === 'model_not_found') return true
      }
    } catch {
      return /model_not_found/i.test(message)
    }
  }
  return /model_not_found/i.test(message)
}

function progressEvent(
  planningId: string,
  draftId: string,
  draftRevision: number,
  type: Extract<ArrangementPlanningProgress['type'], 'arrangement_employee_considering' | 'arrangement_employee_selected'>,
  employee: ArrangementPlannerEmployee,
  data: ArrangementPlanningProgress['data'],
): ArrangementPlanningProgress {
  return {
    planningId,
    draftId,
    draftRevision,
    type,
    occurredAt: Date.now(),
    data: {
      ...data,
      subscriptionId: employee.subscriptionId,
      employeeId: employee.employeeId,
    },
  }
}

function readTextDelta(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const text = (data as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

function readMessageText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const message = (data as { message?: unknown }).message
  if (!message || typeof message !== 'object') return null
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === 'object')
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('')
  return text || null
}



function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError()
}


function createAbortError(): DOMException {
  return new DOMException('Arrangement planning was cancelled.', 'AbortError')
}
