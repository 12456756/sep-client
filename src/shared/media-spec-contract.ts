import { z } from 'zod'
import { imageAspectRatio } from './media-spec'

const positive = z.number().finite().positive().max(Number.MAX_SAFE_INTEGER)
const pixels = positive.int()
const token = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
const ratio = z.string().max(32).regex(/^[1-9]\d*:[1-9]\d*$/).refine(value =>
  value.split(':').every(part => Number.isSafeInteger(Number(part))))
const size = z.string().max(64).regex(/^[1-9]\d*x[1-9]\d*$/).refine(value => imageAspectRatio(value) !== undefined)
const dimensions = { width: pixels.optional(), height: pixels.optional(), aspectRatio: ratio.optional() }

function validateDimensions(value: { size?: string; width?: number; height?: number; aspectRatio?: string }, context: z.RefinementCtx): void {
  const parsed = value.size?.split('x').map(Number)
  if (parsed && (value.width !== undefined && parsed[0] !== value.width || value.height !== undefined && parsed[1] !== value.height)) {
    context.addIssue({ code: 'custom', path: ['size'], message: 'Pixel size conflicts with explicit dimensions.' })
  }
  const width = value.width ?? parsed?.[0], height = value.height ?? parsed?.[1]
  if (width !== undefined && height !== undefined && value.aspectRatio !== undefined) {
    const [a, b] = value.aspectRatio.split(':').map(Number)
    if (BigInt(width) * BigInt(b) !== BigInt(height) * BigInt(a)) context.addIssue({ code: 'custom', path: ['aspectRatio'], message: 'Aspect ratio conflicts with explicit dimensions.' })
  }
}

/** New requests carry decisions, never platform defaults or capability membership rules. */
export const imageRequestedSpecSchema = z.object({
  ...dimensions, size: size.optional(), count: pixels.optional(), quality: token.optional(),
  outputFormat: z.string().max(96).regex(/^image\/[a-zA-Z0-9][a-zA-Z0-9.+-]*$/).optional(),
}).strict().superRefine(validateDimensions)

export const videoRequestedSpecSchema = z.object({
  ...dimensions, durationSeconds: positive.optional(), resolution: token.optional(),
  frameRate: positive.optional(), audio: z.boolean().optional(),
  outputFormat: z.string().max(96).regex(/^video\/[a-zA-Z0-9][a-zA-Z0-9.+-]*$/).optional(),
}).strict().superRefine(validateDimensions)

export const mediaParameterSourceSchema = z.enum(['user', 'model', 'upstream'])
export const mediaParameterSourcesSchema = z.partialRecord(z.enum([
  'width', 'height', 'aspectRatio', 'size', 'count', 'quality', 'durationSeconds', 'resolution', 'frameRate', 'audio', 'outputFormat',
]), mediaParameterSourceSchema)
export const mediaSpecMetadataSchema = z.object({
  protocolVersion: z.literal(3), specRevision: positive.int(), parameterSources: mediaParameterSourcesSchema,
}).strict()

export type ImageRequestedSpec = z.infer<typeof imageRequestedSpecSchema>
export type VideoRequestedSpec = z.infer<typeof videoRequestedSpecSchema>
export type MediaParameterSources = z.infer<typeof mediaParameterSourcesSchema>
export type MediaSpecMetadata = z.infer<typeof mediaSpecMetadataSchema>

/** New trusted requests treat an explicitly undefined optional field as omitted. Historical objects are not rewritten. */
export function omitUndefinedMediaFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T
}

/** Public diagnostic scalars; transport bodies, prompts and arbitrary reason text are excluded. */
export interface MediaSpecFailureContext {
  businessCode?: string
  field?: string
  stage?: string
  recovery?: string
  source?: string
  requestedValue?: string | number | boolean
  reasonCode?: string
  alternatives?: Array<ImageRequestedSpec | VideoRequestedSpec>
  submissionState?: string
  billingState?: string
  retryable?: boolean
}

export const MEDIA_SPEC_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  MISSING_SPEC: '生成规格尚未确定，请补充方案或确认需求',
  SPEC_CONFLICT: '生成规格相互矛盾，请核对尺寸、比例和明确要求',
  UPGRADE_REQUIRED: '当前媒体协议无法表达这套规格，需要升级平台或客户端',
  ADAPTER_UNAVAILABLE: '当前媒体通道尚未完成适配',
  ADAPTER_FIELD_UNMAPPED: '当前适配器无法传递指定规格字段',
  PRICE_UNAVAILABLE: '无法取得这套规格的可靠报价',
  UPSTREAM_SPEC_UNSUPPORTED: '上游明确不支持这套规格，请核对原因并重新选择方案',
  OUTPUT_SPEC_MISMATCH: '实际产物与约定规格不一致，请查看实际结果和费用状态',
})

export function isMediaSpecError(code: string): boolean {
  return Object.hasOwn(MEDIA_SPEC_ERROR_MESSAGES, code)
}

/** Exact values and omissions must agree; only ratio reduction is an equivalent conversion. */
export function mediaSpecsEqual(requested: Record<string, unknown>, effective: Record<string, unknown>): boolean {
  const normalized = (spec: Record<string, unknown>): string => JSON.stringify(Object.keys(spec).filter(key => spec[key] !== undefined).sort().map(key => {
    const value = key === 'aspectRatio' && typeof spec[key] === 'string' && ratio.safeParse(spec[key]).success
      ? imageAspectRatio((spec[key] as string).replace(':', 'x')) : spec[key]
    return [key, value]
  }))
  return normalized(requested) === normalized(effective)
}
