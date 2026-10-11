import type { WorkTypeReadResult } from '../../src/shared/types'
import type { JsonReadDiagnostic } from '../data/atomic-file'
import type { TaskMetadata } from '../data/task-metadata-store'
import type { WorkPlan } from '../domain/arrangement-plan'

export function resolveWorkType(
  metadata: JsonReadDiagnostic<Pick<TaskMetadata, 'kind'>>,
  plan: JsonReadDiagnostic<Pick<WorkPlan, 'mode'>>,
  prompt: string,
): WorkTypeReadResult {
  if (metadata.state === 'found') return { state: 'resolved', kind: metadata.value.kind }
  if (plan.state === 'found') return { state: 'resolved', kind: plan.value.mode === 'conversation' ? 'conversation' : 'arrangement' }
  const marker = '[SEP_WORK_META]'
  const markerIndex = prompt.indexOf(marker)
  if (markerIndex !== -1) {
    try {
      const value: unknown = JSON.parse(prompt.slice(markerIndex + marker.length).trim().split('\n', 1)[0]!)
      if (typeof value === 'object' && value !== null && 'kind' in value) {
        if (value.kind === 'conversation' || value.kind === 'flow') {
          return { state: 'resolved', kind: value.kind === 'flow' ? 'arrangement' : 'conversation' }
        }
      }
    } catch {
      // Invalid legacy metadata is not type evidence.
    }
  }
  if (prompt.startsWith('[SEP_WORKFLOW_TASK]')) return { state: 'resolved', kind: 'arrangement' }
  return metadata.state === 'missing' && plan.state === 'missing'
    ? { state: 'resolved', kind: 'conversation' }
    : { state: 'unavailable' }
}
