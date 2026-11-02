import { imageRequestedSpecSchema, videoRequestedSpecSchema, mediaParameterSourcesSchema, mediaSpecsEqual, type MediaParameterSources } from '../../src/shared/media-spec-contract'
import type { ArrangementMediaRequirement } from './arrangement-plan'
import { AppError } from '../errors/app-error'

/** Only the versioned contract enters V3; historical preferences retain their original semantics. */
export function resolveArrangementMediaSpec(requirement: ArrangementMediaRequirement, input: Record<string, unknown>): {
  protocolVersion: 3; specRevision: number; requestedSpec: Record<string, unknown>; parameterSources: MediaParameterSources
} | undefined {
  if (requirement.specRevision === undefined) return undefined
  if (input.specRevision !== undefined && input.specRevision !== requirement.specRevision) {
    throw new AppError('SPEC_CONFLICT', { message: '媒体需求版本已变化，请按照当前规划确认规格后继续。' })
  }
  const schema = requirement.kind === 'image' ? imageRequestedSpecSchema : videoRequestedSpecSchema
  const parse = (value: unknown) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new AppError('SPEC_CONFLICT', { message: '媒体规格字段无效或互相冲突，请确认后继续。' })
    return parsed.data as Record<string, unknown>
  }
  const required = requirement.requiredSpec ?? {}
  const proposed = requirement.proposedSpec ?? {}
  const explicit = parse(input.requestedSpec ?? input.parameters ?? {})
  if (input.requestedSpec !== undefined && input.parameters !== undefined && !mediaSpecsEqual(explicit, parse(input.parameters))) {
    throw new AppError('SPEC_CONFLICT', { message: '同一次工具提交包含两套冲突规格，请确认后继续。' })
  }
  const explicitSources = mediaParameterSourcesSchema.safeParse(input.parameterSources ?? {})
  if (!explicitSources.success) throw new AppError('SPEC_CONFLICT', { message: '媒体规格来源无效，请确认后继续。' })
  for (const [key, value] of Object.entries(required)) {
    if (explicit[key] !== undefined && !mediaSpecsEqual({ [key]: value }, { [key]: explicit[key] })) {
      throw new AppError('SPEC_CONFLICT', { message: '工具提交规格与用户明确要求冲突，请保留用户要求后继续。' })
    }
  }
  const requestedSpec = parse({ ...proposed, ...explicit, ...required })
  const parameterSources: MediaParameterSources = {}
  for (const key of Object.keys(requestedSpec) as Array<keyof MediaParameterSources>) {
    parameterSources[key] = Object.hasOwn(required, key) ? 'user' :
      Object.hasOwn(explicit, key) ? explicitSources.data[key] ?? 'model' : requirement.parameterSources?.[key] ?? 'model'
  }
  return { protocolVersion: 3, specRevision: requirement.specRevision, requestedSpec, parameterSources }
}
