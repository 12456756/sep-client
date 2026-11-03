import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ConversationService, type ConversationServiceDependencies } from './conversation-service'

test('scheduled work cannot be admitted through continuation or employee switching', async () => {
  const service = new ConversationService({
    scope: { currentScope: () => ({ memberId: 'member', enterpriseId: 'enterprise' }) },
    taskManager: { async getTask() { return { id: 'task', subscriptionId: 'employee', status: 'pending', scheduledOrigin: { definitionId: 'schedule', occurrenceId: 'run' } } } },
    employees: { async authorize() { assert.fail('scheduled control must be rejected before authorization') } },
    execution: async () => { assert.fail('scheduled control must not call runtime') },
  } as unknown as ConversationServiceDependencies)
  await assert.rejects(service.continue({ taskId: 'task', prompt: 'run now', confirmRecovery: true }), { code: 'INVALID_STATE' })
  await assert.rejects(service.switchEmployee('task', 'other'), { code: 'INVALID_STATE' })
})
