import { arrangementMediaKindForFormat } from './arrangement-plan'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOperation(value: unknown): unknown {
  if (typeof value !== 'string') return value
  switch (value.trim().toLowerCase()) {
    case 'generate': case 'text-to-image': case 'text_to_image': return 'generate'
    case 'edit': case 'image-to-image': case 'image-edit': return 'edit'
    case 'image-to-video': case 'image_to_video': return 'image-to-video'
    case 'text-to-video': case 'text_to_video': return 'text-to-video'
    default: return value
  }
}

function operationKind(operation: unknown): 'image' | 'video' | undefined {
  if (operation === 'generate' || operation === 'edit') return 'image'
  if (operation === 'image-to-video' || operation === 'text-to-video') return 'video'
  return undefined
}

function singleSource(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value
}

// Compatibility belongs at the model-output boundary, never at IPC or persisted-plan validation.
export function normalizePlannerMediaContract(node: Record<string, unknown>): Record<string, unknown> {
  const result = { ...node }
  const usedIds = new Set(Array.isArray(node.mediaRequirements)
    ? node.mediaRequirements.filter(isRecord).map(requirement => requirement.id) : [])
  let nextId = 1
  if (Array.isArray(node.mediaRequirements)) {
    result.mediaRequirements = node.mediaRequirements.map(value => {
      if (!isRecord(value)) return value
      const requirement: Record<string, unknown> = { ...value, operation: normalizeOperation(value.operation) }
      if (requirement.id === undefined) {
        while (usedIds.has(`media-${nextId}`)) nextId += 1
        requirement.id = `media-${nextId++}`
        usedIds.add(requirement.id)
      }
      if (requirement.kind === undefined && operationKind(requirement.operation)) requirement.kind = operationKind(requirement.operation)
      if (requirement.inputFrom !== undefined) requirement.inputFrom = singleSource(requirement.inputFrom)
      const selection = requirement.inputSelection
      if (isRecord(selection)) {
        if (Object.keys(selection).length === 0) delete requirement.inputSelection
        else if (Object.keys(selection).length === 1 && Object.hasOwn(selection, 'inputFrom') && requirement.inputFrom === undefined) {
          requirement.inputFrom = singleSource(selection.inputFrom)
          requirement.inputSelection = 'single'
        }
      } else if (selection === 'none' && !requirement.inputFrom &&
        (requirement.operation === 'generate' || requirement.operation === 'text-to-video')) delete requirement.inputSelection
      else if (selection === 'specified' && isRecord(requirement.inputFrom)) requirement.inputSelection = 'single'
      else if (selection === 'auto') requirement.inputSelection = 'model'
      return requirement
    })
  }
  const requirements = Array.isArray(result.mediaRequirements) ? result.mediaRequirements.filter(isRecord) : []
  if (Array.isArray(node.deliverables)) {
    result.deliverables = node.deliverables.map(value => {
      if (!isRecord(value)) return value
      const deliverable = { ...value }
      if (isRecord(deliverable.artifact)) deliverable.artifact = {
        ...deliverable.artifact,
        ...(deliverable.artifact.operation !== undefined ? { operation: normalizeOperation(deliverable.artifact.operation) } : {}),
      }
      const kind = typeof deliverable.format === 'string' ? arrangementMediaKindForFormat(deliverable.format) : undefined
      const operations = new Set(requirements.filter(requirement => requirement.kind === kind && operationKind(requirement.operation) === kind)
        .map(requirement => requirement.operation))
      // Infer only an omitted mapping with a single explicit matching operation; preserve workspace/either intent.
      if (kind && operations.size === 1) {
        const operation = [...operations][0]
        if (deliverable.artifact === undefined) deliverable.artifact = { kind, source: 'media-output', operation }
        else if (isRecord(deliverable.artifact) && deliverable.artifact.kind === kind && deliverable.artifact.source === undefined &&
          (deliverable.artifact.operation === undefined || deliverable.artifact.operation === operation)) {
          deliverable.artifact = { ...deliverable.artifact, source: 'media-output', operation }
        }
      }
      return deliverable
    })
  }
  return result
}
