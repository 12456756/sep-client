import { z } from 'zod'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'
import type { ArrangementDraft } from '../../domain/arrangement-plan'

const draftId = z.string().min(1)
const revision = z.number().int().positive()
const mode = z.enum(['conversation', 'auto', 'manual'])
const permissionPreset = z.enum(['read-only', 'workspace-edit', 'full-local'])
const commandPolicy = z.enum(['disabled', 'restricted', 'confirm-each'])
const approvalMode = z.enum(['confirm-each', 'auto-approve'])

const participant = z.object({ subscriptionId: z.string().min(1), modelId: z.string().min(1) })
const node = z.object({
  id: z.string().min(1),
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
  status: z.enum(['editing', 'planning', 'planning-failed', 'ready', 'preflight-failed', 'confirmed']),
  title: z.string(),
  goal: z.string(),
  confirmedInputs: z.array(z.string()),
  sharedSkillIds: z.array(z.string()),
  conversation: z.object({
    participants: z.array(participant),
    activeSubscriptionId: z.string().nullable(),
  }).nullable(),
  nodes: z.array(node),
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

export const arrangementRoutes = [
  route(INVOKE_CHANNELS.ARRANGE_GET_CONTEXT, NO_INPUT, async ctx => ({
    success: true,
    context: await ctx.arrangements.context(),
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
]
