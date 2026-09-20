import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import * as api from './platform-api'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const version = {
  id: 'psv_opaque-id', capabilityId: 'cap-1', parentVersionId: 'published-1',
  enterpriseId: 'enterprise-1', ownerId: 'user-1', scope: 'PERSONAL', version: '0.0.0-personal.hash',
  status: 'PENDING_ENTERPRISE_REVIEW', submittedAt: '2026-09-16T09:00:00.000Z',
  enterpriseReviewedAt: null, rejectionReason: null, changeSummary: null,
  createdAt: '2026-09-16T09:00:00.000Z', updatedAt: '2026-09-16T09:00:00.000Z',
}
const overview = {
  enterprise: { id: 'enterprise-1', name: 'Integration', logo: null },
  permissions: { grantVisibility: 'SELF', departmentGrantInheritance: 'DIRECT_DEPARTMENT_ONLY', personalReportingSupported: false },
  statistics: { employeeCount: 2, subscriptionCount: 3, activeEmployeeCount: 1, currentUserAvailableEmployeeCount: 1 },
  employees: [{ employeeId: 'employee-1', subscriptionId: 'sub-1', name: 'Employee', avatar: null, position: 'Analysis', description: 'Description', status: 'ACTIVE', employeeStatus: 'APPROVED', endDate: null, active: true, currentUserCanUse: true }],
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('SEP 2026-09-16 supplemental API contract', () => {
  it('reads organization and overview without enterpriseId or field remapping', async () => {
    const organization = { ...overview, departments: [], members: [{ id: 'member-1', userId: 'user-1', name: 'Member', departmentId: null, position: null, avatar: null }], grants: [] }
    const urls: string[] = []
    globalThis.fetch = async (input, init) => {
      const url = String(input); urls.push(url)
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
      return response(url.endsWith('/organization') ? organization : overview)
    }
    assert.deepEqual(await api.getEnterpriseOrganization('access'), organization)
    assert.deepEqual(await api.getEnterpriseOverview('access'), overview)
    assert.match(urls[0]!, /\/enterprise\/organization$/)
    assert.match(urls[1]!, /\/enterprise\/overview$/)
  })

  it('uploads full source and reuses caller-owned idempotency key unchanged', async () => {
    const request = { capabilityId: 'cap-1', parentVersionId: 'published-1', content: '---\r\nname: skill\r\n---\r\n\r\n# Source  \r\n\t', changeSummary: 'Update' }
    const key = '902a70ec-b23d-4ec0-82c8-73450fe778a9'
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls++
      assert.match(String(input), /\/enterprise\/skill-versions$/)
      assert.equal(init?.method, 'POST')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), key)
      assert.deepEqual(JSON.parse(String(init?.body)), request)
      return response({ ...version, content: request.content }, 201)
    }
    for (let i = 0; i < 2; i++) assert.equal((await api.createPersonalSkillVersion(request, key, 'access')).content, request.content)
    assert.equal(calls, 2)
  })

  it('requires valid save inputs and does not send ownership or state from callers', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return response(version) }
    const request = { capabilityId: 'cap', parentVersionId: 'v', content: 'text' }
    for (const invalid of [{ ...request, content: '' }, { ...request, content: 'x'.repeat(500001) }, { ...request, ownerId: 'other' }, { ...request, capabilityId: 'x'.repeat(129) }]) {
      await assert.rejects(async () => api.createPersonalSkillVersion(invalid, 'valid-key-1234567', 'access'))
    }
    await assert.rejects(async () => api.createPersonalSkillVersion(request, '', 'access'))
    assert.equal(calls, 0)
  })

  it('lists versions using required capabilityId and optional status, preserving review metadata', async () => {
    globalThis.fetch = async input => {
      const url = new URL(String(input))
      assert.equal(url.pathname.endsWith('/enterprise/skill-versions'), true)
      assert.equal(url.searchParams.get('capabilityId'), 'cap/with & characters')
      assert.equal(url.searchParams.get('status'), 'ENTERPRISE_REJECTED')
      return response([{ ...version, status: 'ENTERPRISE_REJECTED', rejectionReason: 'Add acceptance criteria' }])
    }
    const result = await api.listSkillVersions({ capabilityId: 'cap/with & characters', status: 'ENTERPRISE_REJECTED' }, 'access')
    assert.equal(result[0]?.rejectionReason, 'Add acceptance criteria')
    await assert.rejects(async () => api.listSkillVersions({ capabilityId: '' }, 'access'))
  })

  it('preserves review pagination and sends review decisions to the encoded version URL', async () => {
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST') {
        assert.match(String(input), /\/skill-versions\/psv_a%2Fb\/review$/)
        assert.deepEqual(JSON.parse(String(init.body)), { decision: 'REJECT', comment: 'Please revise' })
        return response({ ...version, status: 'ENTERPRISE_REJECTED', rejectionReason: 'Please revise' }, 201)
      }
      const url = new URL(String(input))
      assert.equal(url.searchParams.get('page'), '2')
      assert.equal(url.searchParams.get('limit'), '10')
      return response({ total: 1, page: 2, limit: 10, items: [version] })
    }
    assert.deepEqual(await api.listSkillVersionReviews('access', { page: 2, limit: 10 }), { total: 1, page: 2, limit: 10, items: [version] })
    assert.equal((await api.reviewSkillVersion('psv_a/b', { decision: 'REJECT', comment: 'Please revise' }, 'access')).status, 'ENTERPRISE_REJECTED')
    await assert.rejects(async () => api.reviewSkillVersion('v', { decision: 'REJECT' }, 'access'))
    await assert.rejects(async () => api.listSkillVersionReviews('access', { limit: 101 }))
  })

  it('preserves published baseline and personal review metadata in employee skills', async () => {
    const published = { ...version, id: 'published-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' }
    const data = { subscriptionId: 'sub-1', canManage: true, skills: [{
      capability: { id: 'cap-1', name: 'Skill', description: '', type: 'SKILL' },
      currentVersion: published, latestPublishedVersion: published,
      versions: [published, version], upgradeAvailable: false,
    }] }
    globalThis.fetch = async () => response(data)
    assert.deepEqual(await api.getEmployeeSkills('employee-1', 'access'), data)
  })

  it('rejects malformed supplemental responses rather than fabricating empty data', async () => {
    globalThis.fetch = async () => response({ ...overview, statistics: { employeeCount: '2' } })
    await assert.rejects(() => api.getEnterpriseOverview('access'))
    globalThis.fetch = async () => response({ ...overview, departments: [], members: [], grants: 'invalid' })
    await assert.rejects(() => api.getEnterpriseOrganization('access'))
    globalThis.fetch = async () => response({ items: [] })
    await assert.rejects(() => api.listSkillVersions({ capabilityId: 'cap' }, 'access'))
  })

  it('keeps unknown platform response fields and accepts empty directories', async () => {
    const data = { ...overview, employees: [], departments: [], members: [], grants: [], futureField: 'unchanged' }
    globalThis.fetch = async () => response(data)
    assert.deepEqual(await api.getEnterpriseOrganization('access'), data)
  })

  it('sends an approval without a comment and omits unspecified review filters', async () => {
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), { decision: 'APPROVE' })
        return response({ ...version, status: 'ENTERPRISE_APPROVED' }, 201)
      }
      assert.equal(new URL(String(input)).search, '')
      return response({ total: 0, page: 1, limit: 20, items: [] })
    }
    assert.equal((await api.listSkillVersionReviews('access')).total, 0)
    assert.equal((await api.reviewSkillVersion('psv_opaque', { decision: 'APPROVE' }, 'access')).status, 'ENTERPRISE_APPROVED')
  })

  for (const status of [400, 401, 403, 404, 409, 500]) {
    it(`retains the platform ${status} error and does not retry writes automatically`, async () => {
      let calls = 0
      const error = { statusCode: status, message: 'Platform rejection', requestId: 'req-1', timestamp: '2026-09-16', path: '/api/enterprise/skill-versions' }
      globalThis.fetch = async () => { calls++; return response(error, status) }
      await assert.rejects(() => api.createPersonalSkillVersion({ capabilityId: 'cap', parentVersionId: 'v', content: 'text' }, 'valid-key-1234567', 'access'), cause => {
        assert.ok(cause instanceof api.AuthApiError)
        assert.deepEqual(cause.error, error)
        return true
      })
      assert.equal(calls, 1)
    })
  }
})
