import { createHash } from 'node:crypto'
import type { LocalMediaJob } from '../electron/domain/media'
import type { RealReceiptFixture } from './real-receipt-fixture'

// Synthetic protocol data ONLY. Never presented as evidence of real generation or approval.
export function memoryReceiptFixture(): RealReceiptFixture {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
  const bytes = Buffer.from(pngBase64, 'base64')
  const owner = { enterpriseId: 'local-test-enterprise', memberId: 'local-test-member' }
  const jobs = (['generate', 'edit'] as const).map((operation): LocalMediaJob => {
    const parameters = { aspectRatio: '1:1', size: '1024x1024', count: 1, quality: 'medium' }
    const referenceHashes = operation === 'edit' ? [createHash('sha256').update(bytes).digest('hex')] : []
    const creativeBrief = 'Synthetic local protocol acceptance; no model or network.'
    const requestHash = createHash('sha256').update(JSON.stringify({ profileId: 'local-test-profile', configVersion: 'v1',
      operation, creativeBrief, parameters: { size: parameters.size, count: 1 }, references: referenceHashes })).digest('hex')
    return { version: 1, owner, jobId: `local-test-${operation}`, taskId: 'local-test-task', runId: `local-test-run-${operation}`,
      subscriptionId: 'local-test-subscription', clientRequestId: `local-test-request-${operation}`, requestHash,
      input: { profileId: 'local-test-profile', operation, localAssetIds: operation === 'edit' ? ['local-test-reference'] : [], creativeBrief, parameters },
      profile: { profileId: 'local-test-profile', configVersion: 'v1', kind: 'image', displayName: 'Synthetic local protocol',
        executionMode: 'sync-response', operations: ['generate', 'edit'],
        capabilities: { referenceImage: true, cancel: false, recoverByRequestId: true },
        allowedAspectRatios: ['1:1'], allowedSizes: ['1024x1024'], maxCount: 1 },
      request: { clientRequestId: `local-test-request-${operation}`, requestHash, quoteId: `local-test-quote-${operation}`,
        profileId: 'local-test-profile', configVersion: 'v1', operation,
        referenceIds: operation === 'edit' ? ['local-test-upload'] : [], referenceHashes, creativeBrief, parameters },
      quote: { quoteId: `local-test-quote-${operation}`, requestHash, expiresAt: 1,
        status: 'quoted', amount: '0', currency: 'CNY', authorized: true, budgetAuthorized: true, allowUnknownCost: false },
      approval: 'automatic', receiptId: `local-test-receipt-${operation}`, submission: 'RECEIPTED', generationStatus: 'SUCCEEDED',
      trackingStatus: 'STOPPED', saveStatus: 'PENDING', billingStatus: 'SETTLED',
      outputs: [{ outputId: `local-test-output-${operation}`, mime: 'image/png', size: bytes.length, width: 1, height: 1,
        sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: null }],
      recovery: { canQuery: true, canCancel: false, canDownload: true },
      nextPollAt: 0, attempts: 0, error: null, createdAt: 1, updatedAt: 1 }
  })
  return { version: 1, baseUrl: 'http://127.0.0.1:1/api', employmentToken: 'local-harness-test-token', owner,
    task: { taskId: 'local-test-task', subscriptionId: 'local-test-subscription' }, jobs,
    provenance: { kind: 'external-receipt-adoption', provesPiFlow: false,
      approvals: jobs.map(job => ({ jobId: job.jobId, kind: 'fixture-automatic', source: 'Synthetic test data, no manual approval.' })) },
    memoryProtocol: { pngBase64 } }
}
