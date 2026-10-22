import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { arrangementMediaArtifactIdSchema, isSafeDeliveryPath } from './arrangement-plan'
import type { TaskOwnerScope } from '../data/scope-path'

const localId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const arrangementMediaLinkSchema = z.object({
  version: z.literal(1),
  owner: z.object({ memberId: z.string().min(1).max(256), enterpriseId: z.string().min(1).max(256) }).strict(),
  taskId: localId,
  arrangementRunId: localId,
  nodeId: localId,
  nodeRunId: localId,
  attempt: z.number().int().positive(),
  subscriptionId: z.string().min(1).max(256),
  kind: z.enum(['image', 'video']),
  operation: z.enum(['generate', 'edit', 'image-to-video', 'text-to-video']),
  jobId: localId,
  inputs: z.array(z.object({ artifactId: arrangementMediaArtifactIdSchema, sha256, sourceNodeId: localId.optional() }).strict()),
  outputs: z.array(z.object({
    artifactId: arrangementMediaArtifactIdSchema,
    sha256: sha256.optional(),
    status: z.enum(['pending', 'saving', 'saved', 'save-failed', 'missing', 'expired']),
  }).strict()),
  materializations: z.array(z.object({
    deliverableId: localId,
    path: z.string().min(1).max(1_024).refine(isSafeDeliveryPath),
    sourceArtifactId: arrangementMediaArtifactIdSchema,
    sha256: sha256.optional(),
    status: z.enum(['pending', 'saved', 'missing', 'conflict']),
  }).strict()),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((link, context) => {
  if (link.updatedAt < link.createdAt) context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Media link timestamps cannot move backwards.' })
  if (new Set(link.inputs.map(input => input.artifactId)).size !== link.inputs.length) context.addIssue({ code: 'custom', path: ['inputs'], message: 'Duplicate media input artifact.' })
  if (new Set(link.outputs.map(output => output.artifactId)).size !== link.outputs.length) context.addIssue({ code: 'custom', path: ['outputs'], message: 'Duplicate media output artifact.' })
  const expectedKind = link.operation === 'image-to-video' || link.operation === 'text-to-video' ? 'video' : 'image'
  if (link.kind !== expectedKind) context.addIssue({ code: 'custom', path: ['kind'], message: 'Media operation and output kind do not match.' })
  if (link.operation === 'text-to-video' && link.inputs.length > 0) context.addIssue({ code: 'custom', path: ['inputs'], message: 'Text-to-video generation cannot have image inputs.' })
  if (new Set(link.materializations.map(item => item.deliverableId)).size !== link.materializations.length) context.addIssue({ code: 'custom', path: ['materializations'], message: 'Duplicate media materialization.' })
  for (const output of link.outputs) {
    if (output.status === 'saved' && !output.sha256) context.addIssue({ code: 'custom', path: ['outputs'], message: 'Saved media requires a verified hash.' })
  }
  for (const materialization of link.materializations) {
    const output = link.outputs.find(item => item.artifactId === materialization.sourceArtifactId)
    if (!output || (materialization.sha256 && output.sha256 && materialization.sha256 !== output.sha256) ||
      (materialization.status === 'saved' && (!materialization.sha256 || !output.sha256))) {
      context.addIssue({ code: 'custom', path: ['materializations'], message: 'Materialization must match its source output and verified hash.' })
    }
  }
})

export type ArrangementMediaLink = z.infer<typeof arrangementMediaLinkSchema>

export interface ArrangementMediaLinkStorePort {
  list(scope: TaskOwnerScope, taskId: string): Promise<ArrangementMediaLink[]>
  get(scope: TaskOwnerScope, taskId: string, kind: ArrangementMediaLink['kind'], jobId: string): Promise<ArrangementMediaLink | null>
  upsert(scope: TaskOwnerScope, link: ArrangementMediaLink): Promise<ArrangementMediaLink>
}

export function assertArrangementMediaLinkUpdate(previous: ArrangementMediaLink, next: ArrangementMediaLink): void {
  const stable = ['version', 'owner', 'taskId', 'arrangementRunId', 'nodeId', 'nodeRunId', 'attempt', 'subscriptionId', 'kind', 'operation', 'jobId', 'inputs', 'createdAt'] as const
  if (stable.some(key => !isDeepStrictEqual(previous[key], next[key])) || next.updatedAt < previous.updatedAt) {
    throw new Error('Media job association and original inputs cannot change.')
  }
  for (const before of previous.outputs) {
    const after = next.outputs.find(item => item.artifactId === before.artifactId)
    if (!after || (before.sha256 && after.sha256 !== before.sha256)) throw new Error('Original media output identity cannot change.')
  }
  for (const before of previous.materializations) {
    const after = next.materializations.find(item => item.deliverableId === before.deliverableId)
    if (!after || after.path !== before.path || after.sourceArtifactId !== before.sourceArtifactId ||
      (before.sha256 && after.sha256 !== before.sha256)) throw new Error('Original materialization identity cannot change.')
  }
}
