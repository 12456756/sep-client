import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Subscription } from '../../src/shared/types'
import { EmployeeAuthorizer, type SessionTokens } from './employee-authorizer'
import { EmployeeDirectory } from './employee-directory'

function harness() {
  const subscription: Subscription = { id: 'sub', subscriptionId: 'sub', employeeId: 'employee', name: 'Researcher',
    status: 'ACTIVE', templateVersion: '1', template: { id: 'template', name: 'Researcher', avatar: null },
    allowedModels: ['model'], department: null, upgradeAvailable: false }
  let instances = [subscription], fetches = 0, skillVersion = 1, loggedIn = true
  const session: SessionTokens = { async getValidAccessToken() { return 'test-only' },
    getMeta: () => loggedIn ? { enterpriseId: 'enterprise', memberId: 'member' } : null }
  const directory = new EmployeeDirectory(async () => { fetches++; return instances }, 60000)
  const authorizer = new EmployeeAuthorizer(session, directory, {
    async prepare() { return { skillPaths: [`/skills/version-${skillVersion}`] } }, invalidate() {},
  }, 'http://gateway.invalid')
  return { authorizer, subscription, fetches: () => fetches, setInstances: (value: Subscription[]) => { instances = value },
    changeSkills: () => { skillVersion++ }, logout: () => { loggedIn = false; authorizer.clear() } }
}

test('scheduled authorization refreshes directory within TTL and loads current skills on every start', async () => {
  const h = harness()
  const first = await h.authorizer.authorizeScheduled('sub', 'model')
  h.changeSkills()
  const second = await h.authorizer.authorizeScheduled('sub', 'model')
  assert.equal(h.fetches(), 2)
  assert.deepEqual(first.additionalSkillPaths, ['/skills/version-1'])
  assert.deepEqual(second.additionalSkillPaths, ['/skills/version-2'])
  assert.equal(second.employeeProfile?.name, 'Researcher')
})

test('scheduled preflight rejects revoked employee grants even while the previous directory is cached', async () => {
  const h = harness()
  await h.authorizer.validateScheduled('sub', 'model')
  h.setInstances([])
  await assert.rejects(h.authorizer.authorizeScheduled('sub', 'model'), { code: 'EMPLOYEE_UNAVAILABLE' })
  assert.equal(h.fetches(), 2)
})

test('scheduled preflight distinguishes revoked model grants from unavailable employees', async () => {
  const h = harness()
  h.setInstances([{ ...h.subscription, allowedModels: ['other-model'] }])
  await assert.rejects(h.authorizer.validateScheduled('sub', 'model'), { code: 'MODEL_NOT_ALLOWED' })
})

test('scheduled preflight classifies a signed-out user as authentication required', async () => {
  const h = harness()
  h.logout()
  await assert.rejects(h.authorizer.validateScheduled('sub', 'model'), { code: 'AUTH_REQUIRED' })
  assert.equal(h.fetches(), 0)
})
