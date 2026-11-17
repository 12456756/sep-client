import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { MediaAssetView, MediaTaskView } from '../../shared/media'
import { savedConversationImages } from './conversation-media'
import { groupConversationResults } from './conversation-results'
import { buildConversationReplies } from './conversation-transcript'
import type { WorkItem } from './types'

const work = {
  id: 'task', lastRunId: 'run', deliverables: [],
  messages: [{ id: 'reply', role: 'employee', runId: 'run', content: 'Generated and saved.', createdAt: 1 }],
} as unknown as WorkItem

const saved: MediaAssetView = {
  localAssetId: 'saved-image', taskId: 'task', jobId: 'job', outputId: 'output', source: 'output',
  mime: 'image/png', size: 100, width: 1024, height: 1024, status: 'SAVED',
}

function view(saveStatus: MediaTaskView['jobs'][number]['saveStatus'], assets: MediaAssetView[]): MediaTaskView {
  return {
    capabilities: null, unavailableReason: null, selectedReferenceIds: [], archived: false, assets,
    jobs: [{ jobId: 'job', taskId: 'task', runId: 'run', profileId: 'image', operation: 'generate', parameters: {},
      generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus, billingStatus: 'SETTLED',
      error: null, createdAt: 1, updatedAt: 2, assets, canCancelUpstream: false }],
  }
}

test('saved media becomes a previewable result when no ordinary task files exist', () => {
  const results = savedConversationImages(work.id, view('SAVED', [saved]))
  const groups = groupConversationResults(work, buildConversationReplies(work, false), results)
  assert.equal(groups.size, 1)
  const [result] = groups.get('reply:run') ?? []
  assert.equal(result?.file.sourceArtifact?.artifactId, saved.localAssetId)
  assert.deepEqual(result?.request, { taskId: work.id, assetId: saved.localAssetId })
  assert.equal(result?.file.path, '')
})

test('generation success alone does not publish unsaved images and partial saves retain only saved assets', () => {
  const unsaved = { ...saved, localAssetId: 'unsaved-image', status: 'SAVE_FAILED' as const }
  const replies = buildConversationReplies(work, false)
  const failed = savedConversationImages(work.id, view('SAVE_FAILED', [unsaved]))
  assert.equal(groupConversationResults(work, replies, failed).size, 0)
  const partial = savedConversationImages(work.id, view('SAVE_FAILED', [saved, unsaved]))
  const groups = groupConversationResults(work, replies, partial)
  assert.deepEqual(groups.get('reply:run')?.map(result => result.file.id), [saved.localAssetId])
})
