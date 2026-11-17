import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ConnectorService } from './connector-service'
import { ConnectorRegistry } from '../runtime/connector-registry'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorRuntimePort } from '../domain/connectors'
import type { ConnectorId } from '../../src/shared/connectors'

test('connector service forwards provider ID and authenticated scope for every action', async () => {
  let scope: TaskOwnerScope | null = { enterpriseId: 'company', memberId: 'person' }
  const calls: string[] = []
  const provider = (id: ConnectorId): ConnectorRuntimePort => ({ state: async owner => { calls.push(`state:${id}:${owner.memberId}`); return { id, status: 'disconnected' } }, connect: async owner => { calls.push(`connect:${id}:${owner.memberId}`) }, disconnect: async owner => { calls.push(`disconnect:${id}:${owner.memberId}`) }, cancel: () => {}, binding: async () => undefined })
  const registry = new ConnectorRegistry({ dingtalk: async () => provider('dingtalk'), feishu: async () => provider('feishu'), wecom: async () => provider('wecom'), tmeet: async () => provider('tmeet'), qqmail: async () => provider('qqmail'), kdocs: async () => provider('kdocs'), github: async () => provider('github') })
  const service = new ConnectorService({ currentScope: () => scope }, async () => registry)
  assert.equal((await service.state('feishu')).id, 'feishu')
  await service.connect('feishu'); await service.disconnect('dingtalk')
  assert.deepEqual(calls, ['state:feishu:person', 'connect:feishu:person', 'disconnect:dingtalk:person'])
  await service.connect('kdocs'); await service.disconnect('kdocs')
  assert.deepEqual(calls.slice(-2), ['connect:kdocs:person', 'disconnect:kdocs:person'])
  scope = null
  await assert.rejects(service.connect('feishu'))
  assert.equal(calls.length, 5)
})

test('GitHub credentials require a logged-in member, valid schema and the dedicated connection action', async () => {
  let scope: TaskOwnerScope | null = { enterpriseId: 'company', memberId: 'person' }
  const calls: unknown[] = []
  const credentials = { token: 'github_pat_private_fixture_123456789', readOnly: true }
  const runtime: ConnectorRuntimePort = { state: async () => ({ id: 'github', status: 'disconnected' }), connect: async (owner, input) => { calls.push([owner, input]) }, disconnect: async () => {}, cancel: () => {}, binding: async () => undefined }
  const service = new ConnectorService({ currentScope: () => scope }, async () => ({ provider: async id => { assert.equal(id, 'github'); return runtime }, binding: async () => undefined, cancel: () => {} }))
  await assert.rejects(service.connect('github'))
  await assert.rejects(service.connectGitHub({ ...credentials, token: 'invalid' }))
  assert.equal(calls.length, 0)
  await service.connectGitHub(credentials)
  assert.deepEqual(calls, [[scope, credentials]])
  scope = null
  await assert.rejects(service.connectGitHub(credentials))
  assert.equal(calls.length, 1)
})
