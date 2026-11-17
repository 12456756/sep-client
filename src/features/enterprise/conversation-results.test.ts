import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConversationReplies } from './conversation-transcript'
import { groupConversationResults, savedConversationVideos } from './conversation-results'
import type { WorkItem } from './types'
import type { VideoTaskView } from '../../shared/video-host'

test('groups only registered files by reply mention and retains unmentioned files once during a new run', () => {
  const work = { id: 'task', activeRunId: 'new', isActive: true, lastRunId: 'old', currentRunStartedAt: 3,
    messages: [
      { id: 'old-reply', role: 'employee', runId: 'old', content: '文件已保存：销售总结.md，也可参考 other.pdf', createdAt: 1 },
      { id: 'new-user', role: 'user', runId: 'new', content: '继续', createdAt: 3 },
    ], deliverables: [
      { id: 'task-file-0', name: '销售总结.md', format: 'md', path: '成果/task/销售总结.md', note: '' },
      { id: 'task-file-1', name: 'data.csv', format: 'csv', path: '成果/task/data.csv', note: '' },
      { id: 'task-file-2', name: '销售总结.md', format: 'md', path: '成果\\task\\销售总结.md', note: '' },
    ] } as WorkItem
  const groups = groupConversationResults(work, buildConversationReplies(work, false), [])
  assert.deepEqual([...groups].map(([id, results]) => [id, results.map(result => result.file.id)]), [['reply:old', ['task-file-0', 'task-file-1']]])
})

test('uses exact image runs and video submission times without moving old media to the current run', () => {
  const work = { id: 'task', messages: [
    { id: 'first', role: 'user', runId: 'a', content: '一', createdAt: 10 },
    { id: 'second', role: 'user', runId: 'b', content: '二', createdAt: 20 },
  ], deliverables: [] } as unknown as WorkItem
  const image = { file: { id: 'image', name: 'image.png', path: '', note: '' }, runId: 'a', request: { taskId: 'task', assetId: 'image' } }
  const video = { file: { id: 'video', name: 'video.mp4', path: '', note: '' }, createdAt: 15, request: { taskId: 'task', jobId: 'job', outputId: 'video' } }
  const results = groupConversationResults(work, buildConversationReplies(work, false), [image, image, video])
  assert.deepEqual(results.get('reply:a')?.map(result => result.file.id), ['image', 'video'])
  assert.equal(results.has('reply:b'), false)
})

test('retains files when historical messages are unavailable', () => {
  const work = { id: 'task', messages: [], deliverables: [{ id: 'file', name: 'notes.md', path: 'notes.md', note: '' }] } as unknown as WorkItem
  assert.equal(groupConversationResults(work, [], []).get('unassigned')?.length, 1)
})

test('shows verified partial video outputs, excludes unsaved and foreign outputs, and preserves identities', () => {
  const view = { jobs: [
    { taskId: 'task', jobId: 'job', createdAt: 10, saveStatus: 'SAVE_FAILED', savedOutputIds: ['saved'], outputs: [
      { outputId: 'saved', mimeType: 'video/mp4', sha256: 'hash' }, { outputId: 'missing', mimeType: 'video/mp4', sha256: 'hash' },
    ] },
    { taskId: 'other', jobId: 'other', saveStatus: 'SAVED', outputs: [{ outputId: 'foreign', mimeType: 'video/mp4' }] },
  ] } as VideoTaskView
  const results = savedConversationVideos('task', view)
  assert.equal(results.length, 1)
  assert.deepEqual(results[0]?.request, { taskId: 'task', jobId: 'job', outputId: 'saved' })
  assert.equal(results[0]?.createdAt, 10)
})
