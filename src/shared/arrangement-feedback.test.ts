import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { feedbackMessage, isDraftRevisionConflict, recoverDraftRevisionConflict, responseError } from './arrangement-feedback'

test('recognizes draft conflicts by the IPC code and preserves other error messages', () => {
  const conflict = responseError({ error: { code: 'DRAFT_REVISION_CONFLICT', message: 'Draft updated' } }, 'start')
  assert.equal(isDraftRevisionConflict(conflict), true)
  assert.equal(isDraftRevisionConflict(responseError({ error: { code: 'NETWORK_ERROR', message: 'Draft updated' } }, 'start')), false)
  assert.equal(isDraftRevisionConflict(new Error('Draft updated')), false)
  const network = responseError({ error: { code: 'NETWORK_ERROR', message: 'Check connection' } }, 'start')
  assert.equal(feedbackMessage(network, 'start'), 'Check connection')
})

test('reloads the current draft once after a conflict without resubmitting the operation', async () => {
  let reads = 0
  const failures: unknown[] = []
  const handled = await recoverDraftRevisionConflict(responseError({ error: { code: 'DRAFT_REVISION_CONFLICT' } }, 'start'), async () => { reads++ }, error => failures.push(error))
  assert.equal(handled, true)
  assert.equal(reads, 1)
  assert.equal(failures.length, 0)
  assert.equal(await recoverDraftRevisionConflict(new Error('Other error'), async () => { reads++ }, error => failures.push(error)), false)
  assert.equal(reads, 1)
})

test('reports a failed refresh instead of hiding a real read error', async () => {
  const failure = responseError({ error: { code: 'NETWORK_ERROR', message: 'Check connection' } }, 'read')
  const errors: unknown[] = []
  assert.equal(await recoverDraftRevisionConflict(responseError({ error: { code: 'DRAFT_REVISION_CONFLICT' } }, 'start'), async () => { throw failure }, error => errors.push(error)), true)
  assert.deepEqual(errors, [failure])
})
