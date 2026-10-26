import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConversationSessions } from './conversation-sessions'
import type { AttachmentImportSession } from '../../shared/attachment-contracts'

test('work drafts, reading position and attachments are isolated between works and login lifetimes', () => {
  const firstLogin = createConversationSessions(() => {})
  const a = firstLogin.get('a')
  a.draft = '未发送的说明'; a.scrollTop = 123; a.followsLatest = false
  assert.equal(firstLogin.get('a'), a)
  assert.equal(firstLogin.get('b').draft, '')
  assert.equal(firstLogin.get('b').scrollTop, 0)
  assert.equal(createConversationSessions(() => {}).get('a').draft, '')
  assert.equal(firstLogin.get('a').scrollTop, 123)
})

test('deleting work and tearing down a scope cancel open sessions exactly once', () => {
  const cancelled: string[] = []
  const sessions = createConversationSessions(id => cancelled.push(id))
  sessions.get('a').attachment.session = { sessionId: 'session-a', status: 'open' } as AttachmentImportSession
  sessions.get('b').attachment.session = { sessionId: 'session-b', status: 'open' } as AttachmentImportSession
  sessions.remove('a'); sessions.remove('a'); sessions.clear(); sessions.clear()
  assert.deepEqual(cancelled, ['session-a', 'session-b'])
  assert.equal(sessions.get('a').attachment.session, null)
})

test('StrictMode owner replay preserves open attachments, while real teardown cancels them', async () => {
  const cancelled: string[] = []
  const sessions = createConversationSessions(id => cancelled.push(id))
  const entry = sessions.get('a')
  entry.attachment.session = { sessionId: 'retained', status: 'open' } as AttachmentImportSession
  const replayCleanup = sessions.retainOwner()
  replayCleanup()
  const realCleanup = sessions.retainOwner()
  await Promise.resolve()
  assert.deepEqual(cancelled, [])
  assert.equal(sessions.get('a'), entry)
  assert.equal(entry.attachment.session.sessionId, 'retained')
  realCleanup()
  await Promise.resolve()
  assert.deepEqual(cancelled, ['retained'])
  assert.notEqual(sessions.get('a'), entry)
})

test('late send acceptance updates a reopened conversation and preserves text typed after submission', () => {
  const entry = createConversationSessions(() => {}).get('a')
  let notifications = 0
  const unsubscribe = entry.subscribe(() => { notifications++ })
  entry.setDraft('第一条消息')
  entry.setDraft('正在编辑的下一条')
  entry.acceptSend('第一条消息')
  assert.equal(entry.draft, '正在编辑的下一条')
  assert.equal(entry.attachmentEpoch, 1)
  assert.equal(entry.attachment.session, null)
  entry.acceptSend('正在编辑的下一条')
  assert.equal(entry.draft, '')
  assert.equal(notifications, 4)
  unsubscribe()
  entry.setDraft('已卸载')
  assert.equal(notifications, 4)
})
