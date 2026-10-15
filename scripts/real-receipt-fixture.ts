import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { LocalMediaJob } from '../electron/domain/media'
import { mediaId } from '../electron/common/platform/media-contract'

const jobHead = z.object({
  version: z.literal(1), jobId: mediaId, taskId: mediaId, runId: mediaId,
  subscriptionId: mediaId, clientRequestId: mediaId,
  owner: z.object({ enterpriseId: z.string().min(1), memberId: z.string().min(1) }).strict(),
  approval: z.enum(['manual', 'automatic']), submission: z.literal('RECEIPTED'), receiptId: mediaId,
  generationStatus: z.literal('SUCCEEDED'), saveStatus: z.literal('PENDING'),
  trackingStatus: z.literal('STOPPED'),
  input: z.object({ operation: z.enum(['generate', 'edit']) }).passthrough(),
  outputs: z.array(z.object({ outputId: mediaId, mime: z.literal('image/png'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive(),
    width: z.number().int().positive(), height: z.number().int().positive(),
    expiresAt: z.number().int().nonnegative().nullable(),
  }).strict()).length(1),
}).passthrough()
const approvalSchema = z.object({ jobId: mediaId,
  kind: z.enum(['fixture-automatic', 'recorded-automatic', 'recorded-manual']),
  source: z.string().min(1).max(1000), recordSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(value => value.kind === 'fixture-automatic' || !!value.recordSha256)
const schema = z.object({
  version: z.literal(1), baseUrl: z.string(), employmentToken: z.string().min(8).max(16_384).regex(/^[A-Za-z0-9._~+/-]+=*$/),
  owner: z.object({ enterpriseId: z.string().min(1), memberId: z.string().min(1) }).strict(),
  task: z.object({ taskId: mediaId, subscriptionId: mediaId }).strict(),
  provenance: z.object({ kind: z.literal('external-receipt-adoption'), provesPiFlow: z.literal(false),
    approvals: z.array(approvalSchema).length(2),
  }).strict(),
  jobs: z.array(jobHead).length(2),
  // Only accepted with a separate explicit test flag and a non-routable local base URL.
  memoryProtocol: z.object({ pngBase64: z.string().min(1).max(1024 * 1024) }).strict().optional(),
}).strict()

export type RealReceiptFixture = Omit<z.infer<typeof schema>, 'jobs'> & { jobs: LocalMediaJob[] }

export function parseRealReceiptFixture(raw: unknown, memoryTest = false): RealReceiptFixture {
  try {
    const fixture = schema.parse(raw)
    const url = new URL(fixture.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/api' || url.href !== fixture.baseUrl
      || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error()
    if (memoryTest !== !!fixture.memoryProtocol || (memoryTest && (fixture.baseUrl !== 'http://127.0.0.1:1/api'
      || fixture.employmentToken !== 'local-harness-test-token'))) throw new Error()
    if (new Set(fixture.jobs.map(job => job.jobId)).size !== 2
      || new Set(fixture.jobs.map(job => job.clientRequestId)).size !== 2
      || new Set(fixture.jobs.map(job => job.receiptId)).size !== 2
      || new Set(fixture.jobs.map(job => job.input.operation)).size !== 2
      || new Set(fixture.provenance.approvals.map(item => item.jobId)).size !== 2) throw new Error()
    for (const job of fixture.jobs) {
      const approval = fixture.provenance.approvals.find(item => item.jobId === job.jobId)
      if (!approval || (approval.kind === 'recorded-manual' ? job.approval !== 'manual' : job.approval !== 'automatic')
        || job.taskId !== fixture.task.taskId || job.subscriptionId !== fixture.task.subscriptionId
        || job.owner.enterpriseId !== fixture.owner.enterpriseId || job.owner.memberId !== fixture.owner.memberId
        || (job.outputs[0].expiresAt !== null && job.outputs[0].expiresAt <= Date.now())) throw new Error()
    }
    const { employmentToken, ...publicFields } = fixture
    if (JSON.stringify(publicFields).includes(employmentToken)) throw new Error()
    // Full, strict LocalMediaJob validation is deliberately performed by the real MediaStore.saveJob.
    return fixture as unknown as RealReceiptFixture
  } catch { throw new Error('INVALID_PRIVATE_RECEIPT_FIXTURE') }
}

export async function readRealReceiptFixture(path: string, memoryTest = false): Promise<RealReceiptFixture> {
  try {
    if (!isAbsolute(path)) throw new Error()
    const parent = await lstat(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700
      || parent.uid !== process.getuid?.()) throw new Error()
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== parent.uid
        || stat.size === 0 || stat.size > 4 * 1024 * 1024) throw new Error()
      return parseRealReceiptFixture(JSON.parse(await handle.readFile('utf8')), memoryTest)
    } finally { await handle.close() }
  } catch { throw new Error('INVALID_PRIVATE_RECEIPT_FIXTURE') }
}

export function receiptGetPaths(fixture: RealReceiptFixture): Set<string> {
  const root = '/api/gateway/v1/media/real/requests'
  return new Set(fixture.jobs.flatMap(job => [
    `${root}/${job.receiptId}`, `${root}/by-client-id/${job.clientRequestId}`,
    ...job.outputs.map(output => `${root}/${job.receiptId}/outputs/${output.outputId}/content`),
  ]))
}

export function isReceiptGetAllowed(fixture: RealReceiptFixture, url: URL, method: string): boolean {
  return method === 'GET' && url.origin === new URL(fixture.baseUrl).origin && !url.username && !url.password
    && !url.search && !url.hash && receiptGetPaths(fixture).has(url.pathname)
}
