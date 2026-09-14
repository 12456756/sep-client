import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ArrangementService } from './arrangement-service'
import type { ArrangementDraft } from '../domain/arrangement-plan'
import type { TaskOwnerScope } from '../data/scope-path'

const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

function serviceDeps(extra: Record<string, unknown>) {
  return {
    scope: { currentScope: () => scope },
    workPlans: { async save() {}, async get() { return null } },
    taskMetadata: { async save() {}, async load() { return null } },
    taskManager: { async createTask() { return { id: 'task-a', workDir: null } }, async getTask() { return null } },
    execution: async () => ({ async executeTask() {} }),
    ...extra,
  } as never
}

function draft(): Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    schemaVersion: 1, mode: 'manual', status: 'editing', title: 'Report', goal: 'Build report',
    confirmedInputs: [], sharedSkillIds: [], conversation: null,
    nodes: [{ id: 'n1', subscriptionId: 'sub-a', modelId: 'model-a', title: 'Collect', instruction: 'Collect', expectedOutput: 'data', dependsOn: [], skillIds: [], requiresUserConfirmation: false }],
    workspace: { mode: 'shared', path: null }, permissions: { preset: 'read-only' }, lastPlanning: null,
  }
}

function employee(allowedModels = ['model-a']) {
  return {
    id: 'sub-a', subscriptionId: 'sub-a', employeeId: 'employee-a', name: 'Employee', status: 'ACTIVE' as const,
    templateVersion: '1.0.0', template: { id: 'employee-a', name: 'Employee', avatar: null },
    department: null, allowedModels, upgradeAvailable: false,
  }
}

describe('ArrangementService', () => {
  it('loads a confirmed plan from the current task scope', async () => {
    const plan = { id: 'task-a', title: 'Report' }
    const service = new ArrangementService(serviceDeps({
      workPlans: { async save() {}, async get() { return plan } },
    }))

    assert.deepEqual(await service.getPlan('task-a'), plan)
  })

  it('preflights subscription availability and node model allow-list', async () => {
    let stored: ArrangementDraft | null = null
    const service = new ArrangementService(serviceDeps({
      drafts: {
        async list() { return stored ? [stored] : [] },
        async get() { return stored },
        async create(_scope: TaskOwnerScope, input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { stored = { ...input, id: 'draft-a', owner: scope, revision: 1, createdAt: 1, updatedAt: 1 }; return stored },
        async update() { throw new Error('not used') },
        async delete() { return false },
      },
      employees: { async list() { return [employee()] } } as never,
    }))
    await service.createDraft(draft())
    const result = await service.preflightDraft('draft-a', 1)
    assert.equal(result.canStart, true)
    assert.equal(result.blockingIssues.length, 0)
  })

  it('reports model mismatch without trusting renderer values', async () => {
    let stored: ArrangementDraft | null = null
    const service = new ArrangementService(serviceDeps({
      drafts: {
        async list() { return [] }, async get() { return stored },
        async create(_scope: TaskOwnerScope, input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { stored = { ...input, id: 'draft-a', owner: scope, revision: 1, createdAt: 1, updatedAt: 1 }; return stored },
        async update() { throw new Error('not used') }, async delete() { return false },
      },
      employees: { async list() { return [employee(['model-a'])] } } as never,
    }))
    await service.createDraft({ ...draft(), nodes: [{ ...draft().nodes[0]!, modelId: 'model-b' }] })
    const result = await service.preflightDraft('draft-a', 1)
    assert.deepEqual(result.modelIssues, ['n1:model-not-allowed'])
  })

  it('freezes a validated draft into a work plan before optional execution', async () => {
    let stored: ArrangementDraft | null = null
    let createdTask = false
    const deps = serviceDeps({
      drafts: {
        async list() { return [] },
        async get() { return stored },
        async create(_scope: TaskOwnerScope, input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { stored = { ...input, id: 'draft-a', owner: scope, revision: 1, createdAt: 1, updatedAt: 1 }; return stored },
        async update(_scope: TaskOwnerScope, _id: string, _revision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { stored = { ...patch, id: 'draft-a', owner: scope, revision: 2, createdAt: 1, updatedAt: 2 }; return stored },
        async delete() { return false },
      },
      employees: { async list() { return [employee(['model-a'])] } },
      taskManager: { async createTask() { createdTask = true; return { id: 'task-a', workDir: null } }, async getTask() { return { id: 'task-a', workDir: null } } },
      workPlans: { async save(_scope: TaskOwnerScope, plan: unknown) { assert.equal((plan as { id: string }).id, 'task-a') }, async get() { return null } },
    })
    const service = new ArrangementService(deps)
    await service.createDraft(draft())
    const result = await service.confirmDraft('draft-a', 1, 'idempotency-a')
    assert.equal(result.plan.id, 'task-a')
    assert.equal(createdTask, true)
  })

  it('does not start the same confirmed task twice', async () => {
    let stored: ArrangementDraft | null = null
    let savedPlan: unknown = null
    let starts = 0
    const deps = serviceDeps({
      drafts: {
        async list() { return [] },
        async get() { return stored },
        async create(_scope: TaskOwnerScope, input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { stored = { ...input, id: 'draft-a', owner: scope, revision: 1, createdAt: 1, updatedAt: 1 }; return stored },
        async update(_scope: TaskOwnerScope, _id: string, revision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { stored = { ...patch, id: 'draft-a', owner: scope, revision: revision + 1, createdAt: 1, updatedAt: 2 }; return stored },
        async delete() { return false },
      },
      employees: { async list() { return [employee(['model-a'])] } },
      taskManager: { async createTask() { return { id: 'task-a', workDir: null, status: 'pending', activeRunId: null } }, async getTask() { return { id: 'task-a', workDir: null, status: 'pending', activeRunId: starts ? 'run-a' : null } } },
      workPlans: { async save(_scope: TaskOwnerScope, plan: unknown) { savedPlan = plan }, async get() { return savedPlan } },
      execution: async () => ({ async executeTask() { starts += 1 } }),
    })
    const service = new ArrangementService(deps)
    await service.createDraft(draft())
    await service.confirmAndStart('draft-a', 1, 'same-key')
    await service.confirmAndStart('draft-a', 1, 'same-key')
    assert.equal(starts, 1)
  })
})
