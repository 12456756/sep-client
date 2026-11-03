import { mkdir, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { scheduleInputSchema, type ScheduledSnapshot } from '../../src/shared/scheduled-tasks'
import { scheduledCreationSchema } from '../../src/shared/scheduled-creation'
import { scheduledPlanSchema } from '../domain/scheduled-task'
import { AppError } from '../errors/app-error'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'
import type { WorkPlan } from '../domain/arrangement-plan'
import { sourceFingerprint, validateScheduledSource } from '../domain/scheduled-work-source'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const time = z.number().int().nonnegative()
const issue = z.object({ code: z.string(), message: z.string(), action: z.enum(['retry', 'auth', 'blocked', 'review']), retryAfterMs: z.number().positive().optional() }).strict()
const definition = z.object({
  id, revision: z.number().int().positive(), input: scheduleInputSchema, plan: scheduledPlanSchema.nullable(),
  planInputKey: z.string().nullable(), enabled: z.boolean(), deleted: z.boolean(), nextRunAt: time.nullable(), pausedAt: time.nullable().optional(), createdAt: time, updatedAt: time,
}).strict()
const occurrence = z.object({
  id, definitionId: id, revision: z.number().int().positive(), scheduledAt: time, taskId: id, input: scheduleInputSchema, plan: scheduledPlanSchema,
  status: z.enum(['pending', 'preparing', 'launching', 'running', 'waiting_approval', 'waiting_retry', 'waiting_auth', 'blocked', 'review', 'cancelling', 'completed', 'failed', 'cancelled', 'timed_out', 'missed']),
  firstEligibleAt: time, startDeadline: time, startedAt: time.nullable(), finishedAt: time.nullable(), nextRetryAt: time.nullable(), error: issue.nullable(),
  stopReason: z.enum(['cancelled', 'timed_out']).nullable(),
  attempts: z.array(z.object({ id, number: z.number().int().positive(), startedAt: time, finishedAt: time.nullable(), status: z.enum(['preparing', 'admitted', 'failed', 'completed', 'interrupted']), error: issue.nullable() }).strict()),
}).strict()
const envelope = z.object({ version: z.literal(1), owner: z.object({ memberId: z.string(), enterpriseId: z.string() }).strict(), definitions: z.array(definition), occurrences: z.array(occurrence), creations: z.array(scheduledCreationSchema).optional() }).strict()

export interface ScheduledRepository {
  read(scope: TaskOwnerScope): Promise<ScheduledSnapshot>
  update<T>(scope: TaskOwnerScope, mutate: (snapshot: ScheduledSnapshot) => T): Promise<T>
}

/** One scope snapshot is the transaction boundary; stale backups never authorize replay. */
export class ScheduledTaskStore implements ScheduledRepository {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()
  constructor(userDataDir: string) { this.paths = new ScopePath(userDataDir) }
  file(scope: TaskOwnerScope): string { return join(this.paths.ownerRoot(scope), 'scheduled', 'state.json') }
  async saveTemplate(scope: TaskOwnerScope, plan: WorkPlan): Promise<void> {
    validateScheduledSource(plan, scope)
    const directory = join(this.paths.ownerRoot(scope), 'scheduled', 'templates')
    await mkdir(directory, { recursive: true })
    await writeJsonAtomic(join(directory, `${id.parse(plan.id)}.json`), { version: 1, plan, checksum: sourceFingerprint(plan) }, { durable: true, restoreBackupOnFailure: false })
  }
  async loadTemplate(scope: TaskOwnerScope, templateId: string): Promise<WorkPlan | null> {
    let raw: unknown
    try { raw = JSON.parse(await readFile(join(this.paths.ownerRoot(scope), 'scheduled', 'templates', `${id.parse(templateId)}.json`), 'utf8')) as unknown }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new AppError('PERSISTENCE_ERROR', { message: '定时任务计划副本无法读取，未自动重建或执行。', cause: error })
    }
    try {
      const envelope = z.object({ version: z.literal(1), plan: z.unknown(), checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw)
      const plan = envelope.plan as WorkPlan
      validateScheduledSource(plan, scope)
      if (plan.id !== templateId || sourceFingerprint(plan) !== envelope.checksum) throw new Error('Invalid template identity or checksum')
      return plan
    } catch (cause) { throw new AppError('PERSISTENCE_ERROR', { message: '定时任务计划副本校验失败，未自动恢复旧副本或执行。', cause }) }
  }
  async read(scope: TaskOwnerScope): Promise<ScheduledSnapshot> {
    const directory = join(this.paths.ownerRoot(scope), 'scheduled')
    try {
      const value = envelope.parse(JSON.parse(await readFile(this.file(scope), 'utf8')) as unknown)
      if (value.owner.memberId !== scope.memberId || value.owner.enterpriseId !== scope.enterpriseId
        || new Set(value.definitions.map(item => item.id)).size !== value.definitions.length
        || new Set(value.occurrences.map(item => item.id)).size !== value.occurrences.length
        || new Set(value.creations?.map(item => item.id)).size !== (value.creations?.length ?? 0)) throw new Error('Invalid schedule ownership or IDs')
      return { definitions: value.definitions, occurrences: value.occurrences, ...(value.creations ? { creations: value.creations } : {}) }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        const entries = await readdir(directory).catch((failure: unknown) => {
          if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'ENOENT') return []
          throw failure
        })
        if (!entries.length) return { definitions: [], occurrences: [] }
      }
      throw new AppError('PERSISTENCE_ERROR', { message: '定时任务记录无法读取，已停止自动执行以防重复。请保留现场并检查存储。', cause: error })
    }
  }
  async update<T>(scope: TaskOwnerScope, mutate: (snapshot: ScheduledSnapshot) => T): Promise<T> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const snapshot = await this.read(scope)
      const result = mutate(snapshot)
      const value = envelope.parse({ version: 1, owner: scope, ...snapshot })
      await mkdir(join(this.paths.ownerRoot(scope), 'scheduled'), { recursive: true })
      await writeJsonAtomic(this.file(scope), value, { durable: true, restoreBackupOnFailure: false })
      return structuredClone(result)
    })
  }
  async prepareWorkspace(root: string, executionId: string): Promise<string> {
    const actualRoot = await this.validateWorkspace(root)
    const { realpath } = await import('node:fs/promises')
    const directory = join(actualRoot, `scheduled-${id.parse(executionId)}`)
    await mkdir(directory, { recursive: true })
    if (await realpath(directory) !== directory) throw new AppError('WORKSPACE_INVALID')
    return directory
  }
  async validateWorkspace(root: string): Promise<string> {
    if (!isAbsolute(root)) throw new AppError('WORKSPACE_INVALID')
    const { access, realpath, stat } = await import('node:fs/promises')
    const { constants } = await import('node:fs')
    if (!(await stat(root)).isDirectory()) throw new AppError('WORKSPACE_INVALID')
    await access(root, constants.R_OK | constants.W_OK)
    return realpath(root)
  }
}
