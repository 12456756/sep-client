import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { knowledgeRequestSchema, knowledgeDocumentSchema, knowledgeSearchResponseSchema, knowledgeBasePageSchema, knowledgePreviewSchema, knowledgeGrantPageSchema, restoreKnowledgeFilename } from './knowledge-contracts'

const requestId = 'c49b8f02-2143-4a61-9d62-459c2cb82193'
describe('knowledge contracts', () => {
  it('restores only reversible filename mojibake and preserves valid names', () => {
    const original = '\u77e5\u8bc6\u5e93\u9a8c\u6536v1.md'
    for (const corrupted of [Buffer.from(original).toString('latin1')]) {
      const doc = knowledgeDocumentSchema.parse({ id: 'doc', name: corrupted, originalName: corrupted, filename: corrupted, status: 'READY', searchable: true })
      assert.equal(doc.originalName, original)
      assert.equal(doc.name, original)
      assert.equal(doc.filename, original)
      assert.equal(knowledgeDocumentSchema.parse(doc).originalName, original)
    }
    for (const name of [original, 'caf\u00e9.md', 'M\u00fcnchen.txt', '\u4e2d\u00c3\u00a9.md', 'a\ufffd.md', 'literal%20name.md']) {
      assert.equal(knowledgeDocumentSchema.parse({ id: 'doc', originalName: name, status: 'READY', searchable: true }).originalName, name)
    }
  })
  it('accepts explicit preview text/content variants but rejects missing or invalid bodies and version locks', () => {
    const base = { page: 1, pageSize: 20, total: 1, versionId: 'v1' }
    for (const field of ['text', 'content']) {
      const result = knowledgePreviewSchema.parse({ ...base, items: [{ chunkId: 'chunk', [field]: 'body' }] })
      assert.equal(result.items[0].content, 'body')
    }
    for (const item of [{}, { text: 1 }, { content: null }, { content: 1, text: 'body' }]) {
      assert.equal(knowledgePreviewSchema.safeParse({ ...base, items: [item] }).success, false)
    }
    assert.equal(knowledgePreviewSchema.safeParse({ ...base, versionId: undefined, items: [] }).success, false)
  })
  it('accepts member-based search and rejects subscription credentials and invalid ranges', () => {
    assert.ok(knowledgeRequestSchema.safeParse({ requestId, action: 'search', query: '报销标准', topK: 5 }).success)
    for (const extra of [{ subscriptionId: 'old' }, { knowledgeBaseIds: [] }, { knowledgeBaseIds: ['kb', 'kb'] }, { query: 'x'.repeat(1001) }, { topK: 21 }, { accessToken: 'secret' }]) {
      assert.equal(knowledgeRequestSchema.safeParse({ requestId, action: 'search', query: '报销标准', ...extra }).success, false)
    }
  })
  it('restores a Latin-1 decoded UTF-8 filename for display', () => {
    const original = '\u77e5\u8bc6\u5e93\u9a8c\u6536v1.pdf'
    const corrupted = Buffer.from(original).toString('latin1')
    assert.equal(restoreKnowledgeFilename(corrupted), original)
  })
  it('requires bounded safe files, a valid idempotency key and a fresh precondition for document mutations', () => {
    const request = { requestId, action: 'replaceDocument', kbId: 'kb', docId: 'doc', etag: '"revision-1"', idempotencyKey: requestId,
      file: { filename: '制度.md', bytes: new Uint8Array([65]) } }
    assert.ok(knowledgeRequestSchema.safeParse(request).success)
    for (const file of [{ filename: '../secret.md', bytes: new Uint8Array([65]) }, { filename: `bad${String.fromCharCode(0)}.md`, bytes: new Uint8Array([65]) }, { filename: 'a.py', bytes: new Uint8Array([65]) }, { filename: 'a.md', bytes: new Uint8Array() }, { filename: 'a.md', bytes: new Uint8Array(10 * 1024 * 1024 + 1) }]) {
      assert.equal(knowledgeRequestSchema.safeParse({ ...request, file }).success, false)
    }
    assert.equal(knowledgeRequestSchema.safeParse({ requestId, action: 'getBase', kbId: `bad${String.fromCharCode(0)}id` }).success, false)
    assert.equal(knowledgeRequestSchema.safeParse({ ...request, etag: undefined }).success, false)
    assert.equal(knowledgeRequestSchema.safeParse({ ...request, idempotencyKey: 'x' }).success, false)
  })
  it('keeps an active old version searchable when its replacement fails', () => {
    const doc = knowledgeDocumentSchema.parse({ id: 'doc', name: '制度.md', status: 'FAILED', searchable: true,
      activeVersion: { id: 'old', status: 'READY' }, latestVersion: { id: 'new', status: 'FAILED', retryable: true } })
    assert.equal(doc.searchable, true)
    assert.equal(doc.latestVersion?.retryable, true)
  })
  it('does not treat malformed search or permission responses as empty success', () => {
    assert.equal(knowledgeSearchResponseSchema.safeParse({ results: [] }).success, false)
    assert.equal(knowledgeBasePageSchema.safeParse({ items: [], total: 0 }).success, false)
    assert.ok(knowledgeSearchResponseSchema.safeParse({ status: 'NO_MATCH', results: [], actualStrategy: 'LEXICAL', degraded: false, partial: false, durationMs: 12 }).success)
  })
  it('normalizes platform grants that identify the member only in the nested member object', () => {
    const result = knowledgeGrantPageSchema.parse({ page: 1, pageSize: 20, total: 1, items: [{
      id: 'grant-1', member: { memberId: 'member-1', name: '张三' }, grantedBy: { name: '管理员' }, grantedAt: '2026-10-20T08:00:00.000Z',
    }] })
    assert.equal(result.items[0].memberId, 'member-1')
    assert.equal(result.items[0].member?.name, '张三')
  })
})
