import { z } from 'zod'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'
import type { ArrangementDraft } from '../../domain/arrangement-plan'

const draftId = z.string().min(1)
const taskId = z.string().min(1)
const revision = z.number().int().positive()
const mode = z.enum(['conversation', 'auto', 'manual'])
const permissionPreset = z.enum(['read-only', 'workspace-edit', 'full-local'])
const commandPolicy = z.enum(['disabled', 'restricted', 'confirm-each'])
const approvalMode = z.enum(['confirm-each', 'auto-approve'])

const participant = z.object({ subscriptionId: z.string().min(1), modelId: z.string().min(1) })
const node = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1).optional(),
  subscriptionId: z.string().min(1),
  modelId: z.string().min(1),
  title: z.string(),
  instruction: z.string(),
  expectedOutput: z.string(),
  dependsOn: z.array(z.string()),
  skillIds: z.array(z.string()),
  requiresUserConfirmation: z.boolean(),
})
const workspace = z.object({ mode: z.literal('shared'), path: z.string().nullable() })
const permissions = z.object({
  preset: permissionPreset,
  allowedPaths: z.array(z.string()).optional(),
  deniedPaths: z.array(z.string()).optional(),
  commandPolicy: commandPolicy.optional(),
  allowWithoutApproval: z.boolean().optional(),
  approvalMode: approvalMode.optional(),
})
const draftDocument = z.object({
  schemaVersion: z.literal(1),
  mode,
  status: z.enum(['editing', 'planning', 'planning-failed', 'awaiting-employee', 'ready', 'preflight-failed', 'confirmed']),
  title: z.string(),
  goal: z.string(),
  confirmedInputs: z.array(z.string()),
  sharedSkillIds: z.array(z.string()),
  conversation: z.object({
    participants: z.array(participant),
    activeSubscriptionId: z.string().nullable(),
  }).nullable(),
  nodes: z.array(node),
  intentAnalysis: z.object({
    summary: z.string(),
    steps: z.array(z.object({
      id: z.string().min(1), title: z.string(), requiredCapabilities: z.array(z.string()), requiredCapabilityIds: z.array(z.string()).optional(), dependsOn: z.array(z.string()),
    })),
  }).nullable().optional(),
  unresolvedSteps: z.array(z.object({
    stepId: z.string().min(1), reason: z.string(), requiredCapabilities: z.array(z.string()), requiredCapabilityIds: z.array(z.string()).optional(),
  })).optional(),
  candidateMatches: z.array(z.object({
    stepId: z.string().min(1), employeeId: z.string().min(1), subscriptionId: z.string().nullable(),
    source: z.enum(['enterprise', 'platform']), name: z.string(), rationale: z.string(),
    canExecute: z.literal(false), canApply: z.literal(true),
  })).optional(),
  employeeAccessRequests: z.array(z.object({
    requestId: z.string().min(1), stepId: z.string().min(1), employeeId: z.string().min(1),
    subscriptionId: z.string().nullable(), source: z.enum(['enterprise', 'platform']), name: z.string(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']), requestedCapabilities: z.array(z.string()),
    createdAt: z.string(), updatedAt: z.string(), message: z.string().optional(),
  })).optional(),
  workspace,
  permissions,
  lastPlanning: z.object({
    planningId: z.string(),
    status: z.enum(['planning', 'ready', 'failed', 'cancelled']),
    message: z.string().nullable(),
  }).nullable(),
})

const createInput = draftDocument.omit({ schemaVersion: true, status: true }).extend({
  schemaVersion: z.literal(1).optional(),
})
const updateInput = z.object({
  draftId,
  expectedRevision: revision,
  document: draftDocument.omit({ schemaVersion: true, status: true }).extend({ schemaVersion: z.literal(1).optional() }),
})
const confirmInput = z.object({ draftId, expectedRevision: revision, idempotencyKey: z.string().min(1).max(256) })
const planInput = z.object({ draftId, expectedRevision: revision, modelId: z.string().min(1) })
const cancelPlanInput = z.object({ draftId, planningId: z.string().min(1) })
const requestEmployeeAccessInput = z.object({ draftId, expectedRevision: revision, stepId: z.string().min(1), employeeId: z.string().min(1) })
const getEmployeeAccessRequestInput = z.object({ draftId, requestId: z.string().min(1) })

export const arrangementRoutes = [
  route(INVOKE_CHANNELS.ARRANGE_GET_CONTEXT, NO_INPUT, async ctx => ({
    success: true,
    context: await ctx.arrangements.context(),
  })),
  route(INVOKE_CHANNELS.ARRANGE_GET_PLAN, taskId, async (ctx, id) => ({
    success: true,
    plan: await ctx.arrangements.getPlan(id),
  })),
  route(INVOKE_CHANNELS.ARRANGE_LIST_DRAFTS, NO_INPUT, async ctx => ({
    success: true,
    drafts: await ctx.arrangements.listDrafts(),
  })),
  route(INVOKE_CHANNELS.ARRANGE_CREATE_DRAFT, createInput, async (ctx, input) => {
    const draft = await ctx.arrangements.createDraft({
      ...input,
      schemaVersion: 1,
      status: 'editing',
    } as Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>)
    return { success: true, draft }
  }),
  route(INVOKE_CHANNELS.ARRANGE_GET_DRAFT, draftId, async (ctx, id) => ({
    success: true,
    draft: await ctx.arrangements.getDraft(id),
  })),
  route(INVOKE_CHANNELS.ARRANGE_UPDATE_DRAFT, updateInput, async (ctx, input) => ({
    success: true,
    draft: await ctx.arrangements.updateDraft(
      input.draftId,
      input.expectedRevision,
      input.document as Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>,
    ),
  })),
  route(INVOKE_CHANNELS.ARRANGE_DELETE_DRAFT, draftId, async (ctx, id) => ({
    success: true,
    deleted: await ctx.arrangements.deleteDraft(id),
  })),
  route(INVOKE_CHANNELS.ARRANGE_VALIDATE_DRAFT, draftId, async (ctx, id) => ({
    success: true,
    validation: await ctx.arrangements.validateDraft(id),
  })),
  route(INVOKE_CHANNELS.ARRANGE_PREFLIGHT_DRAFT, z.object({ draftId, expectedRevision: revision }), async (ctx, input) => ({
    success: true,
    preflight: await ctx.arrangements.preflightDraft(input.draftId, input.expectedRevision),
  })),
  route(INVOKE_CHANNELS.ARRANGE_CONFIRM_DRAFT, confirmInput, async (ctx, input) => ({
    success: true,
    ...(await ctx.arrangements.confirmDraft(input.draftId, input.expectedRevision, input.idempotencyKey)),
  })),
  route(INVOKE_CHANNELS.ARRANGE_CONFIRM_AND_START, confirmInput, async (ctx, input) => ({
    success: true,
    ...(await ctx.arrangements.confirmAndStart(input.draftId, input.expectedRevision, input.idempotencyKey)),
  })),
  route(INVOKE_CHANNELS.ARRANGE_PLAN_DRAFT, planInput, async (ctx, input) => ({
    success: true,
    ...(await ctx.arrangements.startPlanning(input.draftId, input.expectedRevision, input.modelId)),
  })),
  route(INVOKE_CHANNELS.ARRANGE_CANCEL_PLAN, cancelPlanInput, async (ctx, input) => ({
    success: true,
    ...(await ctx.arrangements.cancelPlanning(input.draftId, input.planningId)),
  })),
  route(INVOKE_CHANNELS.ARRANGE_REQUEST_EMPLOYEE_ACCESS, requestEmployeeAccessInput, async (ctx, input) => ({
    success: true,
    draft: await ctx.arrangements.requestEmployeeAccess(input.draftId, input.expectedRevision, input.stepId, input.employeeId),
  })),
  route(INVOKE_CHANNELS.ARRANGE_GET_EMPLOYEE_ACCESS_REQUEST, getEmployeeAccessRequestInput, async (ctx, input) => ({
    success: true,
    draft: await ctx.arrangements.getEmployeeAccessRequest(input.draftId, input.requestId),
  })),
]
