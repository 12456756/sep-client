import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationPermissionKey, readConversationPermission, saveConversationPermission } from './conversation-permission-preference'

test('new conversation preferences persist only the selected preset and isolate each account and enterprise', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const key = conversationPermissionKey({ enterpriseId: 'company', memberId: 'member' })
  assert.ok(key)
  assert.equal(readConversationPermission(storage, key), 'workspace-edit')
  assert.equal(saveConversationPermission(storage, key, 'full-local'), true)
  assert.equal(values.get(key), 'full-local')
  assert.equal(readConversationPermission(storage, key), 'full-local')
  assert.equal(readConversationPermission(storage, conversationPermissionKey({ enterpriseId: 'company', memberId: 'other' })), 'workspace-edit')
  assert.equal(readConversationPermission(storage, conversationPermissionKey({ enterpriseId: 'other', memberId: 'member' })), 'workspace-edit')
})

test('invalid and unavailable preference storage falls back without granting elevated access', () => {
  const key = conversationPermissionKey({ enterpriseId: 'company', memberId: 'member' })
  const storage = {
    getItem: () => '{"preset":"full-local","fullFileAccess":true}',
    setItem: () => { throw new Error('write blocked') },
  }
  assert.equal(readConversationPermission(storage, key), 'workspace-edit')
  assert.equal(readConversationPermission(null, key), 'workspace-edit')
  assert.equal(saveConversationPermission(storage, key, 'read-only'), false)
  assert.equal(saveConversationPermission(storage, conversationPermissionKey({ enterpriseId: '', memberId: 'member' }), 'full-local'), false)
})
