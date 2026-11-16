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
  const registry = new ConnectorRegistry({ dingtalk: async () => provider('dingtalk'), feishu: async () => provider('feishu'), wecom: async () => provider('wecom'), tmeet: async () => provider('tmeet') })
  const service = new ConnectorService({ currentScope: () => scope }, async () => registry)
  assert.equal((await service.state('feishu')).id, 'feishu')
  await service.connect('feishu'); await service.disconnect('dingtalk')
  assert.deepEqual(calls, ['state:feishu:person', 'connect:feishu:person', 'disconnect:dingtalk:person'])
  scope = null
  await assert.rejects(service.connect('feishu'))
  assert.equal(calls.length, 3)
})
