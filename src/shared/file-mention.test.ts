import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttachmentView } from './attachment-contracts'
import { distinguishSameNameMentions, fileMentionQuery, moveFileMentions, resolveMentionAttachments } from './file-mention'

const file = (id: string, byte: string): AttachmentView => ({ attachmentId: id, sha256: byte.repeat(64), displayName: '报表.xlsx', mediaType: 'text/plain', byteLength: 1, importSource: 'picker', extractionStatus: 'ready', warnings: [] })
const first = file('first', 'a'), second = file('second', 'b')

test('matches Chinese and full-width mentions without activating emails, URLs or code', () => {
  assert.deepEqual(fileMentionQuery('对比＠报表及后文', 5), { start: 2, end: 5, query: '报表' })
  for (const text of ['name@example.com', 'https://example.test/@someone', '`@token', '~~~ts\n@token']) assert.equal(fileMentionQuery(text, text.length), null)
})

test('remaps an insertion and drops only the reference that the edit intersects', () => {
  const before = '看@报表.xlsx 和 @报表.xlsx'
  const marks = [{ start: 1, end: 9, attachment: first }, { start: 12, end: 20, attachment: second }]
  assert.deepEqual(moveFileMentions(before, `先${before}`, marks).map(mark => mark.start), [2, 13])
  assert.deepEqual(moveFileMentions(before, before.replace('报表', '表'), marks).map(mark => mark.attachment.attachmentId), ['second'])
})

test('keeps only intended attachments and distinguishes same-name references in file order', () => {
  const text = '@报表.xlsx 和 @报表.xlsx'
  const marks = [{ start: 0, end: 8, attachment: second }, { start: 11, end: 19, attachment: first }]
  assert.equal(distinguishSameNameMentions(text, marks, [first, second]), '@报表.xlsx（本轮附件 2） 和 @报表.xlsx（本轮附件 1）')
  const only = new Set([second.attachmentId])
  assert.deepEqual(resolveMentionAttachments([first, second], [], only).items, [first])
  assert.equal(resolveMentionAttachments([first], marks, only).invalid, true)
  assert.deepEqual(resolveMentionAttachments([first, second], [...marks, marks[0]], only).items, [first, second])
})

test('does not repeat referenced files as ordinary attachments', () => {
  const mark = { start: 0, end: 8, attachment: second }
  const files = [first, second]
  assert.deepEqual(resolveMentionAttachments(files, [mark], new Set()), { invalid: false, items: files, unreferenced: [first] })
  assert.deepEqual(resolveMentionAttachments(files, [], new Set()).unreferenced, files)
  assert.deepEqual(resolveMentionAttachments(files, [], new Set([second.attachmentId])).unreferenced, [first])
  const stale = { ...mark, attachment: { ...second, sha256: first.sha256 } }
  assert.deepEqual(resolveMentionAttachments(files, [stale], new Set()).unreferenced, files)
})
