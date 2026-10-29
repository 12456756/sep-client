import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { arrangementMediaRequirementSchema } from './arrangement-plan'
import { normalizePlannerMediaContract } from './arrangement-planner-media'
import { resolveArrangementMediaSpec } from './arrangement-media-spec'

test('planner normalization preserves hard requirements and proposed specs without defaults', () => {
  const requirement = { id: 'video', kind: 'video', operation: 'text-to-video', specRevision: 2,
    requiredSpec: { durationSeconds: 8, aspectRatio: '9:16', audio: false },
    proposedSpec: { resolution: '8k', frameRate: 29.97 },
    parameterSources: { durationSeconds: 'user', aspectRatio: 'user', audio: 'user', resolution: 'model', frameRate: 'model' },
    generationMethod: 'ai-generated' }
  const normalized = normalizePlannerMediaContract({ mediaRequirements: [requirement] })
  assert.deepEqual(arrangementMediaRequirementSchema.parse((normalized.mediaRequirements as unknown[])[0]), requirement)
  const resolved = resolveArrangementMediaSpec(arrangementMediaRequirementSchema.parse(requirement), {})
  assert.deepEqual(resolved, { protocolVersion: 3, specRevision: 2,
    requestedSpec: { resolution: '8k', frameRate: 29.97, durationSeconds: 8, aspectRatio: '9:16', audio: false },
    parameterSources: requirement.parameterSources })
  assert.equal(Object.hasOwn(resolved!.requestedSpec, 'outputFormat'), false)
})

test('hard requirements override suggestions but explicit tool conflicts are rejected', () => {
  const requirement = arrangementMediaRequirementSchema.parse({ id: 'video', kind: 'video', operation: 'text-to-video',
    specRevision: 1, requiredSpec: { audio: false, durationSeconds: 8 }, proposedSpec: { durationSeconds: 4, resolution: '8k' } })
  assert.equal(resolveArrangementMediaSpec(requirement, {})?.requestedSpec.durationSeconds, 8)
  assert.throws(() => resolveArrangementMediaSpec(requirement, { requestedSpec: { durationSeconds: 4 } }), /规格/)
  assert.throws(() => resolveArrangementMediaSpec(requirement, { specRevision: 2 }), /版本/)
  assert.throws(() => resolveArrangementMediaSpec(requirement, { parameters: { durationSeconds: 4 } }), /规格/)
  assert.throws(() => resolveArrangementMediaSpec(requirement, { parameters: { resolution: '720p' }, requestedSpec: { resolution: '8k' } }), /规格/)
  assert.equal(resolveArrangementMediaSpec(requirement, { requestedSpec: { frameRate: 29.97 }, parameterSources: { frameRate: 'user' } })?.parameterSources.frameRate, 'user')
})

test('legacy requirements remain legacy and media kind rejects unrelated spec fields', () => {
  assert.equal(resolveArrangementMediaSpec(arrangementMediaRequirementSchema.parse({ id: 'v', kind: 'video', operation: 'text-to-video', preferred: { durationSeconds: 4 } }), {}), undefined)
  assert.equal(arrangementMediaRequirementSchema.safeParse({ id: 'v', kind: 'video', operation: 'text-to-video', specRevision: 1, requiredSpec: { quality: 'ultra' } }).success, false)
  assert.equal(arrangementMediaRequirementSchema.safeParse({ id: 'i', kind: 'image', operation: 'generate', specRevision: 1, proposedSpec: { durationSeconds: 8 } }).success, false)
  assert.equal(arrangementMediaRequirementSchema.safeParse({ id: 'v', kind: 'video', operation: 'text-to-video', requiredSpec: { apiKey: 'secret' } }).success, false)
})
