import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ArrangementService } from './arrangement-service'
import type { ArrangementDraft } from '../domain/arrangement-plan'
import type {
  ArrangementPlannerPort,
  ArrangementPlanningProgress,
  ArrangementPlanningResult,
  ArrangementPlannerEmployee,
} from '../domain/arrangement-planner'
import type { TaskOwnerScope } from '../data/scope-path'
import { AppError } from '../errors/app-error'
import type { EmployeeAccessRequest, EmployeeAccessRequestInput } from '../common/platform/platform-api'

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

function autoDraft(): Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'> {
  return { ...draft(), mode: 'auto', title: 'Initial title', nodes: [] }
}

function employee(allowedModels = ['model-a']) {
  return {
    id: 'sub-a', subscriptionId: 'sub-a', employeeId: 'employee-a', name: 'Employee', status: 'ACTIVE' as const, templateVersion: '1.0.0',
    template: { id: 'employee-a', name: 'Employee', avatar: null },
    department: null, allowedModels, upgradeAvailable: false,
  }
}

function persisted(input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>, revision = 1): ArrangementDraft {
  return {
    ...structuredClone(input), id: 'draft-a', schemaVersion: 1, revision, owner: { ...scope },
    createdAt: 1, updatedAt: revision,
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type PlannerInput = Parameters<ArrangementPlannerPort['plan']>[0]

function planningHarness(plan: (input: PlannerInput) => Promise<ArrangementPlanningResult>) {
  let currentScope: TaskOwnerScope | null = scope
  let stored: ArrangementDraft | null = persisted(autoDraft())
  let plannerCalls = 0
  let taskCreates = 0
  const updates: ArrangementDraft[] = []
  const events: ArrangementPlanningProgress[] = []
  let candidates: ArrangementPlannerEmployee[] = []
  let platformCandidates: ArrangementPlannerEmployee[] = []
  const planner: ArrangementPlannerPort = {
    async plan(input) {
      plannerCalls += 1
      return plan(input)
    },
  }
  const drafts = {
    async list() { return stored ? [structuredClone(stored)] : [] },
    async get() { return stored ? structuredClone(stored) : null },
    async create(_scope: TaskOwnerScope, input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) {
      stored = persisted(input)
      return structuredClone(stored)
    },
    async update(_scope: TaskOwnerScope, _draftId: string, expectedRevision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) {
      assert.equal(stored?.revision, expectedRevision)
      stored = persisted(patch, expectedRevision + 1)
      updates.push(structuredClone(stored))
      return structuredClone(stored)
    },
    async delete() {
      stored = null
      return true
    },
  }
  const service = new ArrangementService(serviceDeps({
    scope: { currentScope: () => currentScope },
    drafts,
    employees: { async list() { return [employee()] } },
    candidateEmployees: { async listEnterprise() { return candidates }, async listPlatform() { return platformCandidates } },
    employeeCapabilities: { async list() { return [] } },
    planner,
    onPlanningEvent(event: ArrangementPlanningProgress) { events.push(event) },
    taskManager: {
      async createTask() { taskCreates += 1; return { id: 'task-a', workDir: null } },
      async getTask() { return null },
    },
  }))
  return {
    service,
    addCandidates(next: ArrangementPlannerEmployee[]) { candidates = next },
    addPlatformCandidates(next: ArrangementPlannerEmployee[]) { platformCandidates = next },
    get stored() { return stored },
    setStored(next: ArrangementDraft | null) { stored = next },
    setScope(next: TaskOwnerScope | null) { currentScope = next },
    plannerCalls: () => plannerCalls,
    taskCreates: () => taskCreates,
    updates,
    events,
  }
}

const plannedNode = {
  id: 'planned-1', subscriptionId: 'sub-a', modelId: 'model-a', title: 'Collect data',
  instruction: 'Collect data', expectedOutput: 'data', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
}

function awaitingEmployeeDraft(): ArrangementDraft {
  return persisted({
    ...autoDraft(),
    status: 'awaiting-employee',
    intentAnalysis: {
      summary: '整理客户反馈',
      steps: [{ id: 'step-1', title: '分析反馈', requiredCapabilities: ['客户分析'], dependsOn: [] }],
    },
    unresolvedSteps: [{ stepId: 'step-1', reason: '缺少客户分析能力', requiredCapabilities: ['客户分析'] }],
    candidateMatches: [{
      stepId: 'step-1', employeeId: 'employee-enterprise', subscriptionId: 'sub-enterprise',
      source: 'enterprise', name: '企业分析员工', rationale: '具备客户分析能力', canExecute: false, canApply: true,
    }],
  })
}

function accessRequest(status: EmployeeAccessRequest['status'] = 'PENDING'): EmployeeAccessRequest {
  return {
    requestId: 'request-a', status, targetType: 'ENTERPRISE_SUBSCRIPTION',
    employee: { employeeId: 'employee-enterprise', subscriptionId: 'sub-enterprise', name: '企业分析员工' },
    requestedCapabilities: ['客户分析'], createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
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
        async update(_scope: TaskOwnerScope, _draftId: string, expectedRevision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { return { ...patch, id: 'draft-a', owner: scope, revision: expectedRevision + 1, createdAt: 1, updatedAt: expectedRevision + 1 } }, async delete() { return false },
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
    let createdTasks = 0
    const deps = serviceDeps({
      drafts: {
        async list() { return [] },
        async get() { return stored },
        async create(_scope: TaskOwnerScope, input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { stored = { ...input, id: 'draft-a', owner: scope, revision: 1, createdAt: 1, updatedAt: 1 }; return stored },
        async update(_scope: TaskOwnerScope, _id: string, revision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { stored = { ...patch, id: 'draft-a', owner: scope, revision: revision + 1, createdAt: 1, updatedAt: 2 }; return stored },
        async delete() { return false },
      },
      employees: { async list() { return [employee(['model-a'])] } },
      taskManager: { async createTask() { createdTasks += 1; return { id: 'task-a', workDir: null, status: 'pending', activeRunId: null } }, async getTask() { return { id: 'task-a', workDir: null, status: 'pending', activeRunId: starts ? 'run-a' : null } } },
      workPlans: { async save(_scope: TaskOwnerScope, plan: unknown) { savedPlan = plan }, async get() { return savedPlan } },
      execution: async () => ({ async executeTask() { starts += 1 } }),
    })
    const service = new ArrangementService(deps)
    await service.createDraft(draft())
    const first = await service.confirmAndStart('draft-a', 1, 'same-key')
    const second = await service.confirmAndStart('draft-a', 1, 'same-key')
    assert.equal(first.plan.id, second.plan.id)
    assert.equal(createdTasks, 1)
    assert.equal(starts, 1)
  })

  it('creates an idempotent employee access request and keeps the draft paused', async () => {
    let stored = awaitingEmployeeDraft()
    const created: Array<{ input: EmployeeAccessRequestInput; key: string }> = []
    let gets = 0
    const deps = serviceDeps({
      drafts: {
        async list() { return [structuredClone(stored)] },
        async get() { return structuredClone(stored) },
        async create() { return structuredClone(stored) },
        async update(_scope: TaskOwnerScope, _draftId: string, expectedRevision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) {
          assert.equal(stored.revision, expectedRevision)
          stored = persisted(patch, expectedRevision + 1)
          return structuredClone(stored)
        },
        async delete() { return false },
      },
      employees: { async list() { return [employee()] }, async refresh() {} },
      employeeAccessRequests: {
        async create(input: EmployeeAccessRequestInput, key: string) {
          created.push({ input, key })
          return accessRequest()
        },
        async get() { gets += 1; return accessRequest() },
      },
    })
    const service = new ArrangementService(deps)

    const first = await service.requestEmployeeAccess('draft-a', 1, 'step-1', 'employee-enterprise')
    const second = await service.requestEmployeeAccess('draft-a', 2, 'step-1', 'employee-enterprise')

    assert.equal(first.status, 'awaiting-employee')
    assert.equal(second.status, 'awaiting-employee')
    assert.equal(created.length, 1)
    assert.match(created[0]!.key, /^[a-f0-9]{64}$/)
    assert.equal(created[0]!.input.targetType, 'ENTERPRISE_SUBSCRIPTION')
    assert.equal(created[0]!.input.subscriptionId, 'sub-enterprise')
    assert.equal(gets, 1)
    assert.equal(second.employeeAccessRequests?.[0]?.requestId, 'request-a')
  })

  it('rejects access requests for a step or employee that is not a candidate', async () => {
    const stored: ArrangementDraft = {
      ...awaitingEmployeeDraft(),
      employeeAccessRequests: [{
        requestId: 'request-a', stepId: 'step-1', employeeId: 'employee-enterprise', subscriptionId: 'sub-enterprise',
        source: 'enterprise', name: '企业分析员工', status: 'PENDING', requestedCapabilities: ['客户分析'],
        createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
      }],
    }
    const service = new ArrangementService(serviceDeps({
      drafts: {
        async list() { return [stored] }, async get() { return stored }, async create() { return stored },
        async update(_scope: TaskOwnerScope, _draftId: string, expectedRevision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { return { ...patch, id: 'draft-a', owner: scope, revision: expectedRevision + 1, createdAt: 1, updatedAt: expectedRevision + 1 } }, async delete() { return false },
      },
      employeeAccessRequests: { async create() { return accessRequest() }, async get() { return accessRequest() } },
    }))

    await assert.rejects(
      () => service.requestEmployeeAccess('draft-a', 1, 'step-1', 'not-a-candidate'),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () => service.requestEmployeeAccess('draft-a', 1, 'missing-step', 'employee-enterprise'),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGUMENT',
    )
  })

  it('refreshes authorized employees after approval without starting planning', async () => {
    const stored: ArrangementDraft = {
      ...awaitingEmployeeDraft(),
      employeeAccessRequests: [{
        requestId: 'request-a', stepId: 'step-1', employeeId: 'employee-enterprise', subscriptionId: 'sub-enterprise',
        source: 'enterprise', name: '企业分析员工', status: 'PENDING', requestedCapabilities: ['客户分析'],
        createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
      }],
    }
    let refreshes = 0
    let planningCalls = 0
    const service = new ArrangementService(serviceDeps({
      drafts: {
        async list() { return [stored] }, async get() { return structuredClone(stored) }, async create() { return stored },
        async update(_scope: TaskOwnerScope, _draftId: string, expectedRevision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) { return { ...patch, id: 'draft-a', owner: scope, revision: expectedRevision + 1, createdAt: 1, updatedAt: expectedRevision + 1 } }, async delete() { return false },
      },
      employees: { async list() { return [employee()] }, async refresh() { refreshes += 1 } },
      planner: { async plan() { planningCalls += 1; return { title: 'unused', nodes: [] } } },
      employeeAccessRequests: { async create() { return accessRequest() }, async get() { return accessRequest('APPROVED') } },
    }))

    await service.getEmployeeAccessRequest('draft-a', 'request-a')

    assert.equal(refreshes, 1)
    assert.equal(planningCalls, 0)
  })

  it('starts auto planning, emits progress, and creates no Task before confirmation', async () => {
    const gate = deferred<ArrangementPlanningResult>()
    const harness = planningHarness(async () => gate.promise)

    const started = await harness.service.startPlanning('draft-a', 1)
    assert.equal(started.status, 'planning')
    assert.equal(harness.stored?.status, 'planning')
    assert.equal(harness.plannerCalls(), 0)
    await eventually(() => harness.plannerCalls() === 1)
    assert.equal(harness.taskCreates(), 0)
    assert.equal(harness.events.some(event => event.type === 'arrangement_planning_started'), true)

    gate.resolve({ title: 'Planned report', nodes: [plannedNode] })
    await eventually(() => harness.stored?.status === 'ready')
  })

  it('loads authorized employee capability summaries into the planner catalog', async () => {
    let seenCapabilities: unknown = null
    const harness = planningHarness(async input => {
      seenCapabilities = input.employees[0]?.capabilities
      return { title: 'Planned report', nodes: [plannedNode] }
    })
    const service = new ArrangementService(serviceDeps({
      scope: { currentScope: () => scope },
      drafts: {
        async get() { return harness.stored ? structuredClone(harness.stored) : null },
        async update(_scope: TaskOwnerScope, _draftId: string, expectedRevision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>) {
          return { ...patch, id: 'draft-a', owner: scope, revision: expectedRevision + 1, createdAt: 1, updatedAt: expectedRevision + 1 }
        },
      },
      employees: { async list() { return [employee()] } },
      employeeCapabilities: { async list() { return [{ id: 'cap-search', name: '联网搜索', description: '检索公开网页信息', type: 'SKILL' }] } },
      planner: { async plan(input: PlannerInput) { return (seenCapabilities = input.employees[0]?.capabilities, { title: 'Planned report', nodes: [plannedNode] }) } },
    }))

    await service.startPlanning('draft-a', 1)
    await eventually(() => Array.isArray(seenCapabilities))
    assert.deepEqual(seenCapabilities, [{ id: 'cap-search', name: '联网搜索', description: '检索公开网页信息', type: 'SKILL' }])
  })

  it('adds deterministic enterprise candidates and does not fall through to platform when enterprise coverage exists', async () => {
    let calls = 0
    const intentAnalysis = {
      summary: 'search current AI news',
      steps: [{ id: 'step-1', title: 'Search news', requiredCapabilities: ['联网搜索'], requiredCapabilityIds: ['cap-search'], dependsOn: [] }],
    }
    const harness = planningHarness(async () => {
      calls += 1
      return {
        title: 'AI news', nodes: [], intentAnalysis,
        unresolvedSteps: [{ stepId: 'step-1', reason: 'missing authorized employee', requiredCapabilities: ['联网搜索'], requiredCapabilityIds: ['cap-search'] }],
      }
    })
    harness.addCandidates([{
      subscriptionId: 'sub-enterprise', employeeId: 'emp-enterprise', name: '企业检索员工', status: 'ACTIVE', allowedModels: [],
      source: 'enterprise', canExecute: false, canApply: true,
      capabilities: [{ id: 'cap-search', name: '联网搜索', description: '检索公开网页信息' }],
    }])
    harness.addPlatformCandidates([{
      subscriptionId: 'platform:emp-market', employeeId: 'emp-market', name: '市场检索员工', status: 'APPROVED', allowedModels: [],
      source: 'platform', canExecute: false, canApply: true,
      capabilities: [{ id: 'cap-search', name: '联网搜索', description: '检索公开网页信息' }],
    }])

    await harness.service.startPlanning('draft-a', 1)
    await eventually(() => harness.stored?.status === 'awaiting-employee')

    assert.equal(calls, 2)
    assert.deepEqual(harness.stored?.candidateMatches?.map(match => [match.source, match.employeeId]), [['enterprise', 'emp-enterprise']])
  })

  it('preserves nodes from all matching passes', async () => {
    let calls = 0
    const intentAnalysis = {
      summary: 'multi-stage analysis',
      steps: [
        { id: 'step-1', title: 'authorized step', requiredCapabilities: ['basic analysis'], dependsOn: [] },
        { id: 'step-2', title: 'enterprise step', requiredCapabilities: ['industry analysis'], dependsOn: ['step-1'] },
        { id: 'step-3', title: 'platform step', requiredCapabilities: ['advanced analysis'], dependsOn: ['step-2'] },
      ],
    }
    const authorizedNode = { ...plannedNode, id: 'authorized-node', stepId: 'step-1' }
    const enterpriseNode = { ...plannedNode, id: 'enterprise-node', stepId: 'step-2', subscriptionId: 'sub-enterprise' }
    const platformNode = { ...plannedNode, id: 'platform-node', stepId: 'step-3', subscriptionId: 'sub-platform' }
    const harness = planningHarness(async input => {
      calls += 1
      if (calls === 1) {
        return {
          title: 'multi-stage analysis', nodes: [authorizedNode], intentAnalysis,
          unresolvedSteps: [
            { stepId: 'step-2', reason: 'missing enterprise employee', requiredCapabilities: ['industry analysis'] },
            { stepId: 'step-3', reason: 'missing platform employee', requiredCapabilities: ['advanced analysis'] },
          ],
        }
      }
      if (calls === 2) {
        assert.deepEqual(input.draft.nodes.map(node => node.id), ['authorized-node'])
        return {
          title: 'multi-stage analysis', nodes: [enterpriseNode], intentAnalysis,
          unresolvedSteps: [{ stepId: 'step-3', reason: 'missing platform employee', requiredCapabilities: ['advanced analysis'] }],
        }
      }
      assert.deepEqual(input.draft.nodes.map(node => node.id), ['authorized-node', 'enterprise-node'])
      return { title: 'multi-stage analysis', nodes: [platformNode], intentAnalysis, unresolvedSteps: [] }
    })
    harness.addCandidates([{ subscriptionId: 'sub-enterprise', employeeId: 'emp-enterprise', name: 'Enterprise', status: 'ACTIVE', allowedModels: [], source: 'enterprise', canExecute: false }])
    harness.addPlatformCandidates([{ subscriptionId: 'sub-platform', employeeId: 'emp-platform', name: 'Platform', status: 'APPROVED', allowedModels: [], source: 'platform', canExecute: false, canApply: true }])

    await harness.service.startPlanning('draft-a', 1)
    await eventually(() => harness.stored?.status === 'ready')

    assert.deepEqual(harness.stored?.nodes.map(node => node.id), ['authorized-node', 'enterprise-node', 'platform-node'])
    assert.deepEqual(harness.stored?.unresolvedSteps, [])
  })

  it('writes the auto-planning result back as a ready draft', async () => {
    const harness = planningHarness(async () => ({ title: 'Planned report', nodes: [plannedNode] }))

    const result = await harness.service.startPlanning('draft-a', 1)
    await eventually(() => harness.stored?.status === 'ready')

    assert.equal(harness.stored?.revision, 3)
    assert.equal(harness.stored?.title, 'Planned report')
    assert.deepEqual(harness.stored?.nodes, [plannedNode])
    assert.deepEqual(harness.events.map(event => event.type), [
      'arrangement_planning_started',
      'arrangement_planning_completed',
    ])
    assert.equal(harness.events[1]?.planningId, result.planningId)
  })

  it('does not overwrite a newer draft revision with a late planning result', async () => {
    const gate = deferred<ArrangementPlanningResult>()
    const harness = planningHarness(async () => gate.promise)
    await harness.service.startPlanning('draft-a', 1)
    await eventually(() => harness.plannerCalls() === 1)

    const newerDraft = persisted({ ...autoDraft(), title: 'User edited title', status: 'editing' }, 3)
    harness.setStored(newerDraft)
    gate.resolve({ title: 'Late generated title', nodes: [plannedNode] })
    await new Promise<void>(resolve => setImmediate(resolve))

    assert.deepEqual(harness.stored, newerDraft)
    assert.equal(harness.updates.length, 1)
    assert.equal(harness.events.some(event => event.type === 'arrangement_planning_completed'), false)
  })

  it('ignores a late planning result after the draft was deleted', async () => {
    const gate = deferred<ArrangementPlanningResult>()
    const harness = planningHarness(async () => gate.promise)
    await harness.service.startPlanning('draft-a', 1)
    await eventually(() => harness.plannerCalls() === 1)

    harness.setStored(null)
    gate.resolve({ title: 'Late generated title', nodes: [plannedNode] })
    await new Promise<void>(resolve => setImmediate(resolve))

    assert.equal(harness.stored, null)
    assert.equal(harness.updates.length, 1)
    assert.equal(harness.events.some(event => event.type === 'arrangement_planning_completed'), false)
  })

  it('keeps the draft editable when a cancelled planner returns late', async () => {
    const gate = deferred<ArrangementPlanningResult>()
    const harness = planningHarness(async () => gate.promise)
    const started = await harness.service.startPlanning('draft-a', 1)
    await eventually(() => harness.plannerCalls() === 1)

    const cancelled = await harness.service.cancelPlanning('draft-a', started.planningId)
    assert.equal(cancelled.cancelled, true)
    gate.resolve({ title: 'Late generated title', nodes: [plannedNode] })
    await eventually(() => harness.stored?.lastPlanning?.status === 'cancelled')

    assert.equal(harness.stored?.status, 'editing')
    assert.equal(harness.stored?.title, 'Initial title')
    assert.deepEqual(harness.stored?.nodes, [])
    assert.equal(harness.events.some(event => event.type === 'arrangement_planning_cancelled'), true)
    assert.equal(harness.events.some(event => event.type === 'arrangement_planning_completed'), false)
  })

  it('marks the draft as planning-failed when the planner rejects', async () => {
    const harness = planningHarness(async () => { throw new Error('provider unavailable') })

    await harness.service.startPlanning('draft-a', 1)
    await eventually(() => harness.stored?.status === 'planning-failed')

    assert.deepEqual(harness.stored?.lastPlanning?.status, 'failed')
    assert.equal(harness.stored?.lastPlanning?.message, '自动编排暂时未能完成，请稍后重试。')
    assert.equal(harness.events.at(-1)?.type, 'arrangement_planning_failed')
  })

  it('passes the selected planner model to the planning runtime', async () => {
    let receivedPlannerModelId: string | undefined
    const harness = planningHarness(async input => {
      receivedPlannerModelId = input.plannerModelId
      return { title: 'Planned report', nodes: [plannedNode] }
    })

    await harness.service.startPlanning('draft-a', 1, 'deepseek-v4.1-flash')
    await eventually(() => harness.stored?.status === 'ready')

    assert.equal(receivedPlannerModelId, 'deepseek-v4.1-flash')
  })

  it('does not reject the detached planning task after authentication is invalidated', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    const harness = planningHarness(async () => {
      harness.setScope(null)
      throw new AppError('AUTH_REQUIRED')
    })
    process.on('unhandledRejection', onUnhandled)
    try {
      await harness.service.startPlanning('draft-a', 1)
      await eventually(() => harness.plannerCalls() === 1)
      await new Promise<void>(resolve => setImmediate(resolve))
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.deepEqual(unhandled, [])
      assert.equal(harness.stored?.status, 'planning')
      assert.equal(harness.events.some(event => event.type === 'arrangement_planning_failed'), false)
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('reports a planner tool-loop failure to the UI instead of leaving the draft planning', async () => {
    const message = '自动编排模型返回了异常工具调用，已停止规划，请重试。'
    const harness = planningHarness(async () => { throw new AppError('PLANNING_FAILED', { message }) })
    await harness.service.startPlanning('draft-a', 1)
    await eventually(() => harness.stored?.status === 'planning-failed')
    assert.equal(harness.stored?.lastPlanning?.message, message)
    assert.equal(harness.events.at(-1)?.type, 'arrangement_planning_failed')
    assert.equal(harness.events.at(-1)?.data.message, message)
    assert.equal(harness.events.some(event => event.type === 'arrangement_planning_completed'), false)
  })

  it('does not let auto-planning change a manual draft', async () => {
    const stored = persisted(draft())
    let plannerCalls = 0
    const service = new ArrangementService(serviceDeps({
      drafts: {
        async list() { return [stored] },
        async get() { return stored },
        async create() { return stored },
        async update() { throw new Error('manual draft should not be updated') },
        async delete() { return false },
      },
      employees: { async list() { return [employee()] } },
      planner: {
        async plan() { plannerCalls += 1; return { title: 'unexpected', nodes: [plannedNode] } },
      },
    }))

    await assert.rejects(
      () => service.startPlanning('draft-a', 1),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_STATE',
    )
    assert.deepEqual(stored, persisted(draft()))
    assert.equal(plannerCalls, 0)
  })
})
