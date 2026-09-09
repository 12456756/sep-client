import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { getEmployeeSkills, getInstances, getPackageInfo } from './platform-api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SEP auth API contract', () => {
  it('parses the v1 nested capability/currentVersion skill response', async () => {
    const requests: string[] = []
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      return jsonResponse({
        subscriptionId: 'sub-1',
        skills: [{
          capability: { id: 'cap-1', name: 'Order handling' },
          currentVersion: {
            id: 'version-7',
            version: '1.2.0',
            status: 'PLATFORM_APPROVED',
            content: '# Order handling',
          },
          versions: [],
        }],
      })
    }

    const skills = await getEmployeeSkills('employee/1', 'access-token')

    assert.deepEqual(skills, [{
      id: 'cap-1',
      name: 'Order handling',
      currentVersion: '1.2.0',
      status: 'PLATFORM_APPROVED',
      versionId: 'version-7',
      content: '# Order handling',
    }])
    assert.match(requests[0], /\/enterprise\/employees\/employee%2F1\/skills$/)
  })

  it('keeps compatibility with the flat skill response shape', async () => {
    globalThis.fetch = async () => jsonResponse([{
      id: 'legacy-skill',
      name: 'Legacy skill',
      currentVersion: '1.0.0',
      status: 'APPROVED',
      content: '# Legacy',
    }])

    assert.deepEqual(await getEmployeeSkills('employee-1', 'token'), [{
      id: 'legacy-skill',
      name: 'Legacy skill',
      currentVersion: '1.0.0',
      status: 'APPROVED',
      versionId: undefined,
      content: '# Legacy',
    }])
  })

  it('uses subscriptions first and falls back to instances only on 404', async () => {
    const requests: string[] = []
    globalThis.fetch = async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/client/subscriptions')) return jsonResponse({ error: 'not found' }, 404)
      return jsonResponse([{
        id: 'sub-1',
        employeeId: 'employee-1',
        name: 'Commerce',
        status: 'ACTIVE',
        templateVersion: '1.0.0',
        template: { name: 'Commerce', avatar: null },
        allowedModels: ['gpt-4o-mini'],
      }])
    }

    const instances = await getInstances('token')

    assert.deepEqual(instances[0], {
      id: 'sub-1',
      name: 'Commerce',
      status: 'ACTIVE',
      templateVersion: '1.0.0',
      template: { id: 'employee-1', name: 'Commerce', avatar: null },
      department: null,
      allowedModels: ['gpt-4o-mini'],
    })
    assert.equal(requests.length, 2)
    assert.match(requests[0], /\/client\/subscriptions$/)
    assert.match(requests[1], /\/client\/instances$/)
  })

  it('uses the configured default model for legacy instances without allowedModels', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/client/subscriptions')) return jsonResponse({ error: 'not found' }, 404)
      return jsonResponse([{
        id: 'legacy-sub',
        employeeId: 'employee-1',
        name: 'Legacy employee',
        status: 'ACTIVE',
        templateVersion: '1.0.0',
        template: { name: 'Legacy employee', avatar: null },
      }])
    }

    const instances = await getInstances('token')

    assert.deepEqual(instances[0].allowedModels, ['gpt-5.2'])
  })

  it('accepts ZIP-only employee package metadata', async () => {
    globalThis.fetch = async () => jsonResponse({
      version: '1.0.0',
      packageRef: null,
      zipAvailable: true,
      sha256: 'abc',
    })

    assert.deepEqual(await getPackageInfo('sub-1', 'token'), {
      version: '1.0.0', packageRef: null, zipAvailable: true, sha256: 'abc',
    })
  })
})
