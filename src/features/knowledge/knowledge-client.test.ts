import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { KnowledgeClient, documentName, documentPresentation, canManageKnowledge, processingDelay } from './knowledge-client'
import type { KnowledgeRequestInput, KnowledgeResult } from '../../shared/knowledge-contracts'

describe('knowledge UI lifecycle', () => {
  it('shows the replaced file name from the platform originalName field', () => {
    assert.equal(documentName({ id: 'doc', name: '第一版.md', originalName: '第二版.md', status: 'READY', searchable: true }), '第二版.md')
    assert.equal(documentName({ id: 'doc', name: '第一版.md', originalName: '第一版.md', latestVersion: { id: 'v2', originalName: '第二版.md', status: 'READY' }, status: 'READY', searchable: true }), '第二版.md')
    assert.equal(documentName({ id: 'doc', name: '兼容名称.md', status: 'READY', searchable: true }), '兼容名称.md')
  })
  it('cancels locally even when IPC does not settle, and ignores a late result', async () => {
    const cancelled: string[][] = []
    let release!: (value: KnowledgeResult<'search'>) => void
    const delayed = new Promise<KnowledgeResult<'search'>>(resolve => { release = resolve })
    const client = new KnowledgeClient({ requestKnowledge: (() => delayed) as ConstructorParameters<typeof KnowledgeClient>[0]['requestKnowledge'], cancelKnowledgeRequests: async ids => { cancelled.push(ids); return { success: true } } })
    const pending = client.run({ action: 'search', query: '制度', topK: 5 }, 'search')
    client.cancelAll()
    await assert.rejects(pending, /取消/)
    assert.equal(cancelled.flat().length, 1)
    release({ success: true, data: { status: 'NO_MATCH', results: [], actualStrategy: 'LEXICAL', degraded: false, partial: false, durationMs: 1 } })
    assert.equal(client.pendingCount, 0)
  })
  it('replaces an obsolete query without cancelling unrelated operations', async () => {
    const calls: KnowledgeRequestInput[] = []
    const client = new KnowledgeClient({ requestKnowledge: input => { calls.push(input); return new Promise(() => undefined) }, cancelKnowledgeRequests: async () => ({ success: true }) })
    const old = client.run({ action: 'list' }, 'list')
    const other = client.run({ action: 'documents', kbId: 'kb' }, 'docs')
    const current = client.run({ action: 'list', page: 2 }, 'list')
    await assert.rejects(old)
    assert.equal(client.pendingCount, 2)
    client.cancelAll()
    await assert.rejects(other); await assert.rejects(current)
    assert.equal(calls.length, 3)
  })
  it('shows failed replacement and usable old version independently', () => {
    const state = documentPresentation({ id: 'd', status: 'FAILED', searchable: true, latestVersion: { id: 'new', status: 'FAILED', retryable: true }, activeVersion: { id: 'old', status: 'READY' } })
    assert.match(state.label, /失败/); assert.match(state.availability, /可检索/)
    assert.equal(state.retryable, true)
    assert.equal(state.processing, false)
  })
  it('fails closed for missing management permissions and bounds polling delay', () => {
    assert.equal(canManageKnowledge({ canRead: true }), false)
    assert.equal(canManageKnowledge({ canManage: true }), true)
    assert.equal(processingDelay(0), 2000)
    assert.equal(processingDelay(100), 10000)
  })
})
