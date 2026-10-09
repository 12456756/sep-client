import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { resolveWorkType } from './work-type'

const missing = { state: 'missing' as const }
const unavailable = { state: 'unavailable' as const }
const metadata = (kind: 'conversation' | 'arrangement') => ({ state: 'found' as const, value: { kind } })
const plan = (mode: 'conversation' | 'manual' | 'auto') => ({ state: 'found' as const, value: { mode } })
const resolved = (kind: 'conversation' | 'arrangement') => ({ state: 'resolved', kind })

it('resolves authoritative metadata before plans and explicit conversation plans before legacy markers', () => {
  assert.deepEqual(resolveWorkType(metadata('conversation'), plan('manual'), '[SEP_WORKFLOW_TASK]'), resolved('conversation'))
  assert.deepEqual(resolveWorkType(metadata('arrangement'), plan('conversation'), ''), resolved('arrangement'))
  assert.deepEqual(resolveWorkType(unavailable, plan('conversation'), '[SEP_WORK_META]{"kind":"flow"}\nbody'), resolved('conversation'))
  for (const mode of ['auto', 'manual'] as const) assert.deepEqual(resolveWorkType(missing, plan(mode), ''), resolved('arrangement'))
})

it('uses only validated first-line legacy kinds and exact workflow prefixes', () => {
  assert.deepEqual(resolveWorkType(unavailable, unavailable, '[SEP_WORK_META]{"kind":"flow"}\nbody'), resolved('arrangement'))
  assert.deepEqual(resolveWorkType(missing, unavailable, '[SEP_WORK_META]{"kind":"conversation"}\nbody'), resolved('conversation'))
  assert.deepEqual(resolveWorkType(unavailable, missing, 'body\n\n[SEP_WORK_META]{"kind":"flow"}\nignored'), resolved('arrangement'))
  assert.deepEqual(resolveWorkType(unavailable, missing, '[SEP_WORKFLOW_TASK]body'), resolved('arrangement'))
  for (const prompt of ['[SEP_WORK_META]{"kind":"other"}', '[SEP_WORK_META]broken', '[SEP_TASK_PLAN]body', ' [SEP_WORKFLOW_TASK]']) {
    assert.deepEqual(resolveWorkType(unavailable, missing, prompt), unavailable)
  }
})

it('defaults to conversation only with two confirmed missing stores', () => {
  assert.deepEqual(resolveWorkType(missing, missing, 'plain'), resolved('conversation'))
  assert.deepEqual(resolveWorkType(unavailable, missing, 'plain'), unavailable)
  assert.deepEqual(resolveWorkType(missing, unavailable, 'plain'), unavailable)
})
