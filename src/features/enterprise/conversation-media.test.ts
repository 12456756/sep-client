import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import type { MediaAssetView, MediaJobView, MediaTaskView } from '../../shared/media'
import { groupSavedConversationImages } from './conversation-media'

const asset = (id: string, jobId: string, status: MediaAssetView['status'] = 'SAVED'): MediaAssetView => ({
  localAssetId: id, taskId: 'task-a', jobId, outputId: id, source: 'output', mime: 'image/png',
  size: 12, width: 1024, height: 1024, status,
})

const job = (jobId: string, runId: string, assets: MediaAssetView[]): MediaJobView => ({
  jobId, taskId: 'task-a', runId, profileId: 'image', operation: 'generate', parameters: {},
  generationStatus: 'SUCCEEDED', trackingStatus: 'ACTIVE', saveStatus: 'SAVED', billingStatus: 'SETTLED',
  error: null, createdAt: 1, updatedAt: 2, assets, canCancelUpstream: false,
})

describe('conversation image grouping', () => {
  it('groups only saved output images by run and removes duplicated task assets', () => {
    const saved = asset('asset-a', 'job-a')
    const pending = asset('asset-pending', 'job-a', 'SAVING')
    const reference = { ...asset('reference-a', 'job-a'), source: 'reference' as const }
    const view: MediaTaskView = {
      capabilities: null, unavailableReason: null, selectedReferenceIds: [], archived: false,
      assets: [saved, reference], jobs: [job('job-a', 'run-a', [saved, pending]), job('job-b', 'run-b', [asset('asset-b', 'job-b')])],
    }

    assert.deepEqual([...groupSavedConversationImages('task-a', view)], [
      ['run-a', [saved]],
      ['run-b', [asset('asset-b', 'job-b')]],
    ])
  })

  it('ignores assets from another task', () => {
    const other = { ...asset('asset-other', 'job-other'), taskId: 'task-other' }
    const view: MediaTaskView = { capabilities: null, unavailableReason: null, selectedReferenceIds: [], archived: false,
      assets: [], jobs: [{ ...job('job-other', 'run-other', [other]), taskId: 'task-other' }] }
    assert.equal(groupSavedConversationImages('task-a', view).size, 0)
  })
})
