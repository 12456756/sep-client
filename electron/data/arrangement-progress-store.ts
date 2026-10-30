import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { PlanningProgressSnapshot } from '../../src/shared/auto-planning'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'

export interface ArrangementProgressStorePort {
  get(scope: TaskOwnerScope, draftId: string): Promise<PlanningProgressSnapshot | null>
  save(scope: TaskOwnerScope, snapshot: PlanningProgressSnapshot): Promise<void>
  delete(scope: TaskOwnerScope, draftId: string): Promise<void>
}

const owner = z.object({ memberId: z.string(), enterpriseId: z.string() })
const progressSchema = z.object({
  draftId: z.string(), owner, planningId: z.string(), modelId: z.string(), sequence: z.number().int().nonnegative(),
  events: z.array(z.object({
    draftId: z.string(), planningId: z.string(), draftRevision: z.number().int().positive(), occurredAt: z.number(),
    sequence: z.number().int().positive().optional(), owner: owner.optional(),
    type: z.enum(['arrangement_planning_started', 'arrangement_plan_ready', 'arrangement_employee_considering', 'arrangement_employee_selected', 'arrangement_planning_completed', 'arrangement_planning_failed', 'arrangement_planning_cancelled']),
    data: z.object({ subscriptionId: z.string().optional(), employeeId: z.string().optional(), stage: z.string().optional(),
      rationale: z.string().optional(), nodeId: z.string().optional(), title: z.string().optional(), message: z.string().optional(),
      planSummary: z.string().optional(), planSteps: z.array(z.object({ id: z.string(), title: z.string() })).optional() }),
  })).max(128),
})

export class ArrangementProgressStore implements ArrangementProgressStorePort {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()
  private readonly pending = new Map<string, PlanningProgressSnapshot>()
  constructor(userDataDir: string) { this.paths = new ScopePath(userDataDir) }
  async get(scope: TaskOwnerScope, draftId: string): Promise<PlanningProgressSnapshot | null> {
    return readJsonWithBackup(this.paths.arrangementProgressFile(scope, draftId), value => {
      const parsed = progressSchema.safeParse(value)
      return parsed.success && parsed.data.draftId === draftId && parsed.data.owner.memberId === scope.memberId && parsed.data.owner.enterpriseId === scope.enterpriseId ? parsed.data : null
    })
  }
  async save(scope: TaskOwnerScope, snapshot: PlanningProgressSnapshot): Promise<void> {
    const parsed = progressSchema.parse(snapshot)
    if (parsed.owner.memberId !== scope.memberId || parsed.owner.enterpriseId !== scope.enterpriseId) throw new Error('Planning owner mismatch')
    const file = this.paths.arrangementProgressFile(scope, parsed.draftId)
    this.pending.set(file, parsed)
    await this.writes.run(file, async () => {
      if (this.pending.get(file) !== parsed) return
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeJsonAtomic(file, parsed)
      }
      finally { if (this.pending.get(file) === parsed) this.pending.delete(file) }
    })
  }
  async delete(scope: TaskOwnerScope, draftId: string): Promise<void> {
    const file = this.paths.arrangementProgressFile(scope, draftId)
    this.pending.delete(file)
    await this.writes.run(file, async () => {
      await rm(file, { force: true })
      await rm(`${file}.bak`, { force: true })
    })
  }
}
