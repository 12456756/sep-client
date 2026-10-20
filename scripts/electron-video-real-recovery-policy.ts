import { createHash } from 'node:crypto'
import { z } from 'zod'
import { localVideoJobSchema, videoScopeSchema } from '../electron/domain/video-media'
import { videoRuntimeSchema } from '../src/shared/video-media'

export const recoveryFixtureSchema = z.object({
  version: z.literal(1),
  tasks: z.array(z.object({
    scope: videoScopeSchema, taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    job: localVideoJobSchema, runtime: videoRuntimeSchema,
  }).strict()).length(2),
}).strict().superRefine((value, context) => {
  if (new Set(value.tasks.map(item => item.taskId)).size !== 2) context.addIssue({ code: 'custom', message: 'Duplicate original tasks.' })
  for (const item of value.tasks) {
    if (JSON.stringify(item.job.scope) !== JSON.stringify(item.scope) || item.job.taskId !== item.taskId ||
      item.job.executionMode !== 'real' || item.job.saveStatus !== 'SAVED' || item.job.submission !== 'RECEIPTED' ||
      item.job.receipt?.mock !== false || item.job.receipt.status !== 'SUCCEEDED' || item.job.receipt.billingStatus !== 'SETTLED' ||
      item.job.receipt.outputs.length !== 1 || item.runtime.executionMode !== 'real' || !item.runtime.executionAvailable ||
      !item.runtime.profiles.some(profile => profile.profileId === item.job.request.profileId && profile.configVersion === item.job.request.configVersion)) {
      context.addIssue({ code: 'custom', message: 'Original saved and settled video required.' })
    }
  }
})
export type RecoveryFixture = z.infer<typeof recoveryFixtureSchema>

export function recoveryIdentity(job: z.infer<typeof localVideoJobSchema>) {
  return { jobId: job.jobId, taskId: job.taskId, clientRequestId: job.request.clientRequestId,
    receiptId: job.receipt?.receiptId, saveStatus: job.saveStatus, billingStatus: job.receipt?.billingStatus,
    generationStatus: job.receipt?.status,
    immutableSha256: createHash('sha256').update(JSON.stringify({ version: job.version, scope: job.scope,
      taskId: job.taskId, jobId: job.jobId, executionMode: job.executionMode, request: job.request, quote: job.quote,
      receipt: job.receipt, createdAt: job.createdAt })).digest('hex'),
    outputs: job.receipt!.outputs.map(output => ({ outputId: output.outputId, sha256: output.sha256,
      byteLength: output.byteLength, durationSeconds: output.durationSeconds, width: output.width, height: output.height })) }
}
