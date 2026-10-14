import { z } from 'zod'

// SEP mock-only contract, mirrored from backend/src/shared/media-gateway.dto.ts.
export const SEP_MEDIA_MOCK_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC'
export const SEP_MEDIA_MOCK_PNG_SHA256 = 'fa12251425fce59deb3c6f022d074c26e0ad5ce5edb1e58ec50350c3f85de426'
export const SEP_MEDIA_MOCK_PNG_BYTES = 69
export const SEP_MEDIA_JSON_BUDGET = 64 * 1024
export const SEP_MEDIA_CONTENT_BUDGET = 64 * 1024
export const SEP_MEDIA_MOCK_PROFILE_IDS = [
  'mock-sync', 'mock-async', 'mock-partial', 'mock-failed', 'mock-unknown',
  'mock-expired', 'mock-no-price', 'mock-budget', 'mock-no-cancel',
] as const

export const sepMediaGatewayIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const hashSchema = z.string().regex(/^[a-fA-F0-9]{64}$/)
const dateSchema = z.string().datetime({ offset: true }).refine(value => Date.parse(value) >= 0)
const positiveInteger = z.number().int().positive()
const mockProfileIdSchema = z.enum(SEP_MEDIA_MOCK_PROFILE_IDS)
const executionModeSchema = z.enum(['sync-response', 'async-query'])
const operationSchema = z.enum(['generate', 'edit'])

export function sepMediaMockExecutionMode(profileId: string): 'sync-response' | 'async-query' {
  return ['mock-sync', 'mock-unknown', 'mock-expired'].includes(profileId) ? 'sync-response' : 'async-query'
}

export const sepMediaGatewayProfileSchema = z.object({
  profileId: mockProfileIdSchema,
  configVersion: z.literal('mock-v1'),
  executionMode: executionModeSchema,
  operations: z.array(operationSchema).min(1).max(2).refine(values => new Set(values).size === values.length),
  capabilities: z.object({
    supportsReferenceImage: z.literal(true),
    sizes: z.tuple([z.literal('1x1')]),
    maxOutputs: z.number().int().min(1).max(4),
  }).strict(),
}).strict().refine(value => value.executionMode === sepMediaMockExecutionMode(value.profileId))

export const sepMediaGatewayProfilesSchema = z.object({
  mock: z.literal(true),
  protocolVersion: z.literal(1),
  persistence: z.literal('database'),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
  referenceFixtureSha256: z.literal(SEP_MEDIA_MOCK_PNG_SHA256),
  referenceFixtureBase64: z.literal(SEP_MEDIA_MOCK_PNG_BASE64),
  profiles: z.array(sepMediaGatewayProfileSchema).max(9).refine(values => new Set(values.map(value => value.profileId)).size === values.length),
}).strict()

export const sepMediaGatewayParametersSchema = z.object({
  size: z.literal('1x1'), count: z.number().int().min(1).max(4),
}).strict()

const quoteRequestBaseSchema = z.object({
  profileId: mockProfileIdSchema,
  configVersion: z.literal('mock-v1'),
  operation: operationSchema,
  referenceIds: z.array(sepMediaGatewayIdSchema).max(4),
  creativeBrief: z.string().trim().min(1).max(4000),
  parameters: sepMediaGatewayParametersSchema,
}).strict()

function validReferences(value: z.infer<typeof quoteRequestBaseSchema>): boolean {
  return (value.operation !== 'edit' || value.referenceIds.length > 0)
    && new Set(value.referenceIds).size === value.referenceIds.length
}

export const sepMediaGatewayQuoteRequestSchema = quoteRequestBaseSchema.refine(validReferences)
export const sepMediaGatewayRequestSchema = quoteRequestBaseSchema.extend({
  clientRequestId: sepMediaGatewayIdSchema,
  quoteId: sepMediaGatewayIdSchema,
}).refine(validReferences)

export const sepMediaGatewayLocalParametersSchema = z.object({
  aspectRatio: z.literal('1:1'),
  size: z.literal('1x1').optional(),
  count: z.number().int().min(1).max(4),
}).strict()
export const sepMediaGatewayRequestHashSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const sepMediaGatewayReferenceSchema = z.object({
  mock: z.literal(true), referenceId: sepMediaGatewayIdSchema, expiresAt: dateSchema,
  mimeType: z.literal('image/png'), byteLength: positiveInteger.max(5 * 1024 * 1024),
  sha256: hashSchema, width: positiveInteger.max(4096), height: positiveInteger.max(4096),
}).strict()

export const sepMediaGatewayQuoteSchema = z.object({
  mock: z.literal(true), quoteId: sepMediaGatewayIdSchema, expiresAt: dateSchema,
  semanticSha256: hashSchema, pricingStatus: z.enum(['quoted', 'unavailable']),
  amountCny: z.string().regex(/^\d+\.\d{6}$/).nullable(),
  pricingVersion: z.literal('mock-v1'), billingStatus: z.literal('MOCK_NOT_CHARGED'),
}).strict().refine(value => (value.pricingStatus === 'quoted') === (value.amountCny !== null))

export const sepMediaGatewayOutputSchema = z.object({
  outputId: sepMediaGatewayIdSchema, kind: z.literal('image'), mimeType: z.literal('image/png'),
  byteLength: positiveInteger.max(SEP_MEDIA_CONTENT_BUDGET),
  width: positiveInteger.max(32_768), height: positiveInteger.max(32_768),
  sha256: hashSchema, expiresAt: dateSchema.nullable(),
}).strict()

export const sepMediaGatewayErrorCodeSchema = z.enum([
  'MEDIA_MOCK_DISABLED', 'MEDIA_FORBIDDEN', 'MEDIA_NOT_FOUND', 'UNSUPPORTED_MEDIA_PARAMETERS',
  'INVALID_REFERENCE', 'REFERENCE_EXPIRED', 'QUOTE_EXPIRED', 'CONFIG_CHANGED',
  'IDEMPOTENCY_CONFLICT', 'PRICE_UNAVAILABLE', 'BUDGET_EXCEEDED', 'RESULT_EXPIRED',
  'CANCEL_UNSUPPORTED', 'MEDIA_RATE_LIMITED', 'MEDIA_STORAGE_UNAVAILABLE',
  'UPSTREAM_FAILED', 'SUBMISSION_UNKNOWN', 'OUTPUT_FAILED', 'INVALID_PARAMETER',
])

export const sepMediaGatewayReceiptSchema = z.object({
  mock: z.literal(true), receiptId: sepMediaGatewayIdSchema, clientRequestId: sepMediaGatewayIdSchema,
  profileId: mockProfileIdSchema, configVersion: z.literal('mock-v1'), executionMode: executionModeSchema,
  status: z.enum(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']),
  pollAfterMs: z.number().int().nonnegative().max(86_400_000).nullable(),
  outputs: z.array(sepMediaGatewayOutputSchema).max(4), billingStatus: z.literal('MOCK_NOT_CHARGED'),
  errorCode: sepMediaGatewayErrorCodeSchema.nullable(),
  outputErrors: z.array(z.object({ index: z.number().int().min(0).max(3), code: sepMediaGatewayErrorCodeSchema }).strict()).max(4),
  recovery: z.object({ canQuery: z.boolean(), canCancel: z.boolean(), canDownload: z.boolean() }).strict(),
}).strict().refine(value => value.executionMode === sepMediaMockExecutionMode(value.profileId))

// Error messages and metadata are deliberately discarded, including unknown codes.
export const sepMediaGatewayHttpErrorSchema = z.object({
  error: z.object({ code: z.union([sepMediaGatewayErrorCodeSchema, z.enum([
    'AUTH_REQUIRED', 'UNAUTHORIZED', 'PERMISSION_DENIED', 'FORBIDDEN', 'RATE_LIMITED', 'REQUEST_BODY_TOO_LARGE',
  ])]) }),
})

export type SepMediaGatewayReceipt = z.infer<typeof sepMediaGatewayReceiptSchema>
export type SepMediaGatewayHttpErrorCode = z.infer<typeof sepMediaGatewayHttpErrorSchema>['error']['code']
