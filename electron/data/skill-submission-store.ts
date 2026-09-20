import { join } from 'node:path'
import { z } from 'zod'
import type { LocalSkillSubmission } from '../../src/shared/skill-library'
import { idempotencyKeySchema, personalSkillVersionRequestSchema, skillVersionSchema } from '../../src/shared/platform-supplement-contracts'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { WriteChain } from './write-chain'

const recordSchema = z.object({
  idempotencyKey: idempotencyKeySchema, request: personalSkillVersionRequestSchema,
  createdAt: z.string(), uploadedVersion: skillVersionSchema.optional(),
})

/** Durable upload outbox. An uncertain response can be retried after restarting the client. */
export class SkillSubmissionStore {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()
  constructor(userDataDir: string) { this.paths = new ScopePath(userDataDir) }
  private file(scope: TaskOwnerScope): string { return join(this.paths.ownerRoot(scope), 'skill-submissions.json') }
  async list(scope: TaskOwnerScope, capabilityId: string): Promise<LocalSkillSubmission[]> {
    return (await this.read(scope)).filter(item => item.request.capabilityId === capabilityId)
  }
  private async read(scope: TaskOwnerScope): Promise<LocalSkillSubmission[]> {
    return (await readJsonWithBackup(this.file(scope), value => {
      const result = z.array(recordSchema).safeParse(value)
      return result.success ? result.data : null
    })) ?? []
  }
  save(scope: TaskOwnerScope, value: LocalSkillSubmission): Promise<void> {
    const validated = recordSchema.parse(value)
    return this.writes.run(this.file(scope), async () => {
      const current = await this.read(scope)
      const existing = current.find(item => item.idempotencyKey === value.idempotencyKey)
      if (existing && JSON.stringify(existing.request) !== JSON.stringify(validated.request)) throw new Error('同一保存请求不能修改原文，请创建新版本。')
      await writeJsonAtomic(this.file(scope), [...current.filter(item => item.idempotencyKey !== value.idempotencyKey), validated])
    })
  }
}
