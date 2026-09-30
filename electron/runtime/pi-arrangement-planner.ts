import { join } from 'node:path'
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
    const { planningId, modelId, draft, employees, plannerEmployees, signal, onProgress } = input
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
      const plannerEmployee = selectPlannerEmployee(plannerEmployees ?? employees, this.options, modelId)
      const prompt = buildArrangementPlannerPrompt(draft, employees)
      const workerEvents: TaskExecutionEvent[] = []

      // A planner returns JSON, never executes tools. Even a non-compliant gateway
      // must not turn unexpected tool calls into an unbounded agent loop.
      let rejectToolCall!: (error: AppError) => void
      const invalidToolCall = new Promise<never>((_resolve, reject) => { rejectToolCall = reject })
      const worker = this.createWorker(planningId, plannerEmployee, modelId, event => {
        if (event.type === 'tool_execution_start') {
          rejectToolCall(new AppError('PLANNING_FAILED', {
            message: '自动编排模型返回了异常工具调用，已停止规划，请重试。',
          }))
          return
        }
        workerEvents.push(event)
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
        const result = parseArrangementPlannerOutput(text, draft, employees)
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

        return result
      } finally {
        if (abortHandler) planningSignal.removeEventListener('abort', abortHandler)
        await worker.dispose()
      }
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

function selectPlannerEmployee(
  employees: readonly ArrangementPlannerEmployee[],
  options: ArrangementPlannerRuntimeOptions,
  modelId: string,
): ArrangementPlannerEmployee {
  const candidate = options.plannerSubscriptionId
    ? employees.find(employee => employee.subscriptionId === options.plannerSubscriptionId)
    : employees.find(employee => employee.status === 'ACTIVE' && employee.allowedModels.includes(modelId))
  if (!candidate || candidate.status !== 'ACTIVE' || !modelId || !candidate.allowedModels.includes(modelId)) {
    throw new Error('No active silicon employee with an allowed model is available for arrangement planning.')
  }
  return candidate
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
