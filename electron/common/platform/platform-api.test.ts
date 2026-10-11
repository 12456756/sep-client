import { afterEach, describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import * as assert from 'node:assert/strict'
import * as api from './platform-api'
import { config } from '../config'
import { setLogSink, type LogRecord } from '../logger'

const originalFetch = globalThis.fetch
let restoreLogSink: (() => void) | undefined
afterEach(() => { globalThis.fetch = originalFetch; restoreLogSink?.(); restoreLogSink = undefined })
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

  it('resolves web root-relative enterprise and member assets for the Electron renderer', async () => {
    const organization = {
      ...overview,
      enterprise: { ...overview.enterprise, logo: '/api/enterprise/logos/company.png' },
      employees: [{
        ...overview.employees[0]!,
        avatar: '/api/employees/employee.png',
        avatarAsset: {
          id: 'employee:employee-1:default', version: 'v1',
          portraitUrl: '/assets/employees/employee.webp', faceUrl: '/assets/employees/employee-face.webp',
        },
      }],
      departments: [],
      members: [{
        id: 'member-1', userId: 'user-1', name: 'Member', departmentId: null, position: null,
        avatar: '/api/users/avatars/member.png', avatarAsset: null,
      }],
      grants: [],
    }
    globalThis.fetch = async () => response(organization)

    const result = await api.getEnterpriseOrganization('access')
    assert.equal(result.enterprise.logo, 'https://longdaosep.cn/api/enterprise/logos/company.png')
    assert.equal(result.employees[0]?.avatar, 'https://longdaosep.cn/api/employees/employee.png')
    assert.equal(result.employees[0]?.avatarAsset?.faceUrl, 'https://longdaosep.cn/assets/employees/employee-face.webp')
    assert.equal(result.members[0]?.avatar, 'https://longdaosep.cn/api/users/avatars/member.png')
  })

  it('resolves subscription employee assets before they reach the renderer', async () => {
    const subscriptions = [{
      id: 'sub-1', subscriptionId: 'sub-1', employeeId: 'employee-1', name: 'Employee', status: 'ACTIVE',
      templateVersion: 'v1', department: null, allowedModels: [], upgradeAvailable: false,
      template: {
        id: 'employee-1', name: 'Employee', avatar: '/assets/employees/employee.webp',
        avatarAsset: {
          id: 'employee:employee-1:default', version: 'v1',
          portraitUrl: '/assets/employees/employee.webp', faceUrl: '/assets/employees/employee-face.webp',
        },
      },
    }]
    globalThis.fetch = async () => response(subscriptions)

    const result = await api.getSubscriptions('access')
    assert.equal(result[0]?.template.avatar, 'https://longdaosep.cn/assets/employees/employee.webp')
    assert.equal(result[0]?.template.avatarAsset?.faceUrl, 'https://longdaosep.cn/assets/employees/employee-face.webp')
  })

  it('reads platform candidates and preserves access request contracts', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; authorization: string | null }> = []
    const platformPage = {
      items: [{
        employeeId: 'platform-employee-1', name: 'Data Analyst', position: 'Analyst', description: 'Analyzes data',
        functionalCategory: 'TECH', employeeStatus: 'APPROVED', availability: 'AVAILABLE', canApply: true,
        capabilities: [{ id: 'cap-data', name: 'Data analysis', description: 'Analyzes data', type: 'SKILL' }],
        updatedAt: '2026-09-29T08:00:00.000Z',
      }], page: 1, pageSize: 20, total: 1, hasNextPage: false,
    }
    const accessRequest = {
      requestId: 'request-1', status: 'PENDING', targetType: 'PLATFORM_EMPLOYEE',
      employee: { employeeId: 'platform-employee-1', subscriptionId: null, name: 'Data Analyst' },
      requestedCapabilities: ['cap-data'], createdAt: '2026-09-29T08:00:00.000Z', updatedAt: '2026-09-29T08:00:00.000Z',
    }
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get('Authorization') })
      return response(String(input).includes('/platform-employees') ? platformPage : accessRequest, 200)
    }
    const page = await api.getPlatformEmployees('access', { keyword: 'data analysis', capabilityId: 'cap-data', page: 1, pageSize: 20, sort: 'updatedAt_desc' })
    assert.equal(page.items[0]?.employeeId, 'platform-employee-1')
    const created = await api.createEmployeeAccessRequest({ targetType: 'PLATFORM_EMPLOYEE', employeeId: 'platform-employee-1', reason: 'Need data analysis', requestedCapabilities: ['cap-data'] }, 'employee-request-key-1234', 'access')
    assert.equal(created.requestId, 'request-1')
    assert.equal((await api.getEmployeeAccessRequest('request-1', 'access')).status, 'PENDING')
    const listUrl = new URL(calls[0]!.url)
    assert.equal(listUrl.searchParams.get('sort'), 'updatedAt_desc')
    assert.equal(listUrl.searchParams.get('capabilityId'), 'cap-data')
    const requestBody = calls[1]?.body as Record<string, unknown> | undefined
    assert.equal(calls[1]?.method, 'POST')
    assert.equal(requestBody?.targetType, 'PLATFORM_EMPLOYEE')
    assert.equal(requestBody?.employeeId, 'platform-employee-1')
    assert.equal(requestBody?.subscriptionId, undefined)
    assert.equal(calls[0]?.authorization, 'Bearer access')
    assert.equal(calls[1]?.authorization, 'Bearer access')
    assert.equal(calls[2]?.authorization, 'Bearer access')
  })
  it('loads every platform employee page without task search filters and deduplicates IDs', async () => {
    const pages: number[] = []
    const platformEmployee = (employeeId: string) => ({
      employeeId, name: employeeId, position: 'Sales', description: 'Sales proposals',
      employeeStatus: 'APPROVED', availability: 'AVAILABLE', canApply: true,
      capabilities: [{ id: 'cap-proposal', name: 'Proposal writing', description: 'Writes proposals' }],
      updatedAt: '2026-10-08T08:00:00.000Z',
    })
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      const page = Number(url.searchParams.get('page'))
      pages.push(page)
      assert.equal(url.pathname.endsWith('/client/platform-employees'), true)
      assert.deepEqual([...url.searchParams.keys()].sort(), ['page', 'pageSize', 'sort'])
      assert.equal(url.searchParams.get('pageSize'), '100')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
      const items = page === 1
        ? Array.from({ length: 100 }, (_, index) => platformEmployee(`employee-${index}`))
        : page === 2 ? [platformEmployee('employee-99'), platformEmployee('employee-100')]
          : [platformEmployee('sales-proposal-expert')]
      return response({ items, page, pageSize: 100, total: 103, hasNextPage: page < 3 })
    }
    const employees = await api.getAllPlatformEmployees('access')
    assert.deepEqual(pages, [1, 2, 3])
    assert.equal(employees.length, 102)
    assert.equal(employees.at(-1)?.employeeId, 'sales-proposal-expert')
    assert.equal(employees.at(-1)?.capabilities[0]?.id, 'cap-proposal')
  })

  it('returns an empty complete platform directory without extra requests', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return response({ items: [], page: 1, pageSize: 100, total: 0, hasNextPage: false })
    }
    assert.deepEqual(await api.getAllPlatformEmployees('access'), [])
    assert.equal(calls, 1)
  })

  it('does not return a partial platform directory if a later page fails', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return calls === 1
        ? response({ items: [], page: 1, pageSize: 100, total: 1, hasNextPage: true })
        : response({ statusCode: 503, message: 'Directory unavailable' }, 503)
    }
    await assert.rejects(() => api.getAllPlatformEmployees('access'), cause => {
      assert.ok(cause instanceof api.AuthApiError)
      assert.equal(cause.statusCode, 503)
      return true
    })
    assert.equal(calls, 2)
  })

  for (const targetType of ['PLATFORM_EMPLOYEE', 'ENTERPRISE_SUBSCRIPTION'] as const) {
    it(`sends a trusted platform Origin when applying for ${targetType}`, async () => {
      const request: api.EmployeeAccessRequestInput = {
        targetType,
        ...(targetType === 'PLATFORM_EMPLOYEE' ? { employeeId: 'employee-1' } : { subscriptionId: 'subscription-1' }),
        reason: 'Need data analysis', requestedCapabilities: ['cap-data'],
      }
      const key = 'employee-request-key-1234'
      let calls = 0
      globalThis.fetch = async (input, init) => {
        calls++
        assert.equal(String(input), `${config.SEP_BASE_URL}/client/employee-access-requests`)
        assert.equal(init?.method, 'POST')
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('Origin'), 'https://longdaosep.cn')
        assert.equal(headers.get('Authorization'), 'Bearer access')
        assert.equal(headers.get('Content-Type'), 'application/json')
        assert.equal(headers.get('Idempotency-Key'), key)
        assert.deepEqual(JSON.parse(String(init?.body)), request)
        return response({
          requestId: 'request-1', status: 'PENDING', targetType,
          employee: { employeeId: 'employee-1', subscriptionId: request.subscriptionId ?? null, name: 'Data Analyst' },
          requestedCapabilities: ['cap-data'], createdAt: '2026-10-08T08:00:00.000Z', updatedAt: '2026-10-08T08:00:00.000Z',
        }, 201)
      }
      assert.equal((await api.createEmployeeAccessRequest(request, key, 'access')).status, 'PENDING')
      assert.equal(calls, 1)
    })
  }
  it('preserves employee application rejections without retrying the write', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return response({ statusCode: 403, message: 'Origin not allowed. CSRF protection.' }, 403)
    }
    await assert.rejects(() => api.createEmployeeAccessRequest({
      targetType: 'PLATFORM_EMPLOYEE', employeeId: 'employee-1', reason: 'Need data analysis',
    }, 'employee-request-key-1234', 'access'), cause => {
      assert.ok(cause instanceof api.AuthApiError)
      assert.equal(cause.statusCode, 403)
      assert.equal(cause.message, 'Origin not allowed. CSRF protection.')
      return true
    })
    assert.equal(calls, 1)
  })
  it('uploads full source and reuses caller-owned idempotency key unchanged', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    const request = { capabilityId: 'cap-1', parentVersionId: 'published-1', content: '---\r\nname: skill\r\n---\r\n\r\n# Source  \r\n\t', changeSummary: 'Update' }
    const key = '902a70ec-b23d-4ec0-82c8-73450fe778a9'
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls++
      assert.match(String(input), /\/enterprise\/skill-versions$/)
      assert.equal(init?.method, 'POST')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), key)
      assert.equal(new Headers(init?.headers).get('Origin'), config.SEP_WEB_ORIGIN)
      assert.equal(new Headers(init?.headers).get('Referer'), config.SEP_WEB_ORIGIN + '/')
      assert.deepEqual(JSON.parse(String(init?.body)), request)
      return response({ ...version, content: request.content }, 201)
    }
    for (let i = 0; i < 2; i++) assert.equal((await api.createPersonalSkillVersion(request, key, 'access')).content, request.content)
    assert.equal(calls, 2)
    const responseLogs = logs.filter(record => record.message === 'personal skill upload response received')
    const resultLogs = logs.filter(record => record.message === 'personal skill upload result validated')
    assert.equal(responseLogs.length, 2)
    assert.equal(resultLogs.length, 2)
    for (const record of responseLogs) {
      assert.equal(record.scope, 'platform-api')
      assert.equal(record.message, 'personal skill upload response received')
      assert.equal(record.level, 'info')
      assert.deepEqual(record.fields, { method: 'POST', path: '/enterprise/skill-versions', statusCode: 201, ok: true, idempotencyKey: key })
    }
    for (const record of resultLogs) {
      assert.equal(record.level, 'info')
      assert.deepEqual(record.fields, {
        idempotencyKey: key, versionId: version.id, capabilityId: version.capabilityId,
        parentVersionId: version.parentVersionId, scope: 'PERSONAL',
        reviewStatus: 'PENDING_ENTERPRISE_REVIEW', enterpriseId: version.enterpriseId,
        submittedAt: version.submittedAt,
      })
    }
    assert.doesNotMatch(JSON.stringify(logs), /Bearer access|# Source/)
  })

  for (const scenario of [
    { name: 'separate Web and API domains', baseUrl: 'https://api.example.com/api', webOrigin: 'https://web.example.com', expected: 'https://web.example.com' },
    { name: 'local Web and API ports', baseUrl: 'http://127.0.0.1:3001/api', webOrigin: '', expected: 'http://127.0.0.1:3000' },
  ]) {
    it(`uses the configured Web source headers for ${scenario.name}`, () => {
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { createPersonalSkillVersion } from ${JSON.stringify(new URL('./platform-api.ts', import.meta.url).href)};
        globalThis.fetch = async (input, init) => {
          assert.equal(String(input), ${JSON.stringify(scenario.baseUrl + '/enterprise/skill-versions')});
          const headers = new Headers(init.headers);
          assert.equal(headers.get('Origin'), ${JSON.stringify(scenario.expected)});
          assert.equal(headers.get('Referer'), ${JSON.stringify(scenario.expected + '/')});
          return new Response(JSON.stringify(${JSON.stringify({ ...version, content: 'source' })}), { status: 201 });
        };
        await createPersonalSkillVersion({ capabilityId: 'cap-1', parentVersionId: 'published-1', content: 'source' }, 'web-source-key-01', 'access');
      `], { env: { ...process.env, SEP_BASE_URL: scenario.baseUrl, SEP_WEB_ORIGIN: scenario.webOrigin }, stdio: 'pipe' })
    })
  }

  it('logs the actual current review state returned by an idempotent upload retry', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    globalThis.fetch = async () => response({ ...version, status: 'ENTERPRISE_REJECTED', rejectionReason: 'private-review-comment', content: 'private-skill-source' }, 201)
    const saved = await api.createPersonalSkillVersion({ capabilityId: 'cap-1', parentVersionId: 'published-1', content: 'private-skill-source' }, 'retry-request-key-01', 'private-access-token')
    assert.equal(saved.status, 'ENTERPRISE_REJECTED')
    assert.equal(logs.find(record => record.message === 'personal skill upload result validated')?.fields.reviewStatus, 'ENTERPRISE_REJECTED')
    assert.doesNotMatch(JSON.stringify(logs), /private-review-comment|private-skill-source|private-access-token/)
  })

  it('does not log a validated upload result when HTTP 201 contains an invalid version response', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    globalThis.fetch = async () => response({ message: 'private-response' }, 201)
    await assert.rejects(() => api.createPersonalSkillVersion({ capabilityId: 'cap-1', parentVersionId: 'published-1', content: 'private-skill-source' }, 'invalid-response-key-01', 'private-access-token'))
    assert.equal(logs.find(record => record.message === 'personal skill upload response received')?.fields.statusCode, 201)
    assert.equal(logs.some(record => record.message === 'personal skill upload result validated'), false)
    assert.doesNotMatch(JSON.stringify(logs), /private-response|private-skill-source|private-access-token/)
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

  it('trims only changeSummary before enforcing its length limit', async () => {
    const request = { capabilityId: 'cap-1', parentVersionId: 'published-1', content: ' source \r\n\t', changeSummary: '  ' + 'x'.repeat(2000) + '  ' }
    globalThis.fetch = async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { ...request, changeSummary: 'x'.repeat(2000) })
      return response({ ...version, content: request.content }, 201)
    }
    assert.equal((await api.createPersonalSkillVersion(request, 'trim-summary-key-01', 'access')).content, request.content)
  })

  it('rejects incomplete or mismatched submission receipts without logging private response values', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    const request = { capabilityId: 'cap-1', parentVersionId: 'published-1', content: 'private-skill-source' }
    const receipt = { ...version, content: request.content }
    for (const fields of [
      { id: '' }, { scope: 'ENTERPRISE' }, { status: 'PERSONAL_ACTIVE' },
      { submittedAt: null }, { enterpriseId: null }, { ownerId: null }, { content: undefined },
      { capabilityId: 'wrong-capability' }, { parentVersionId: 'wrong-parent' },
      { content: 'private-wrong-source' },
    ]) {
      globalThis.fetch = async () => response({ ...receipt, ...fields }, 201)
      await assert.rejects(() => api.createPersonalSkillVersion(request, 'invalid-receipt-key-01', 'private-access-token'))
    }
    assert.equal(logs.filter(record => record.message === 'personal skill upload result invalid').length, 10)
    assert.equal(logs.some(record => record.message === 'personal skill upload result validated'), false)
    assert.doesNotMatch(JSON.stringify(logs), /private-skill-source|private-wrong-source|private-access-token|wrong-capability|wrong-parent/)
  })

  it('logs a non-JSON submission receipt as a response parsing failure', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    globalThis.fetch = async () => new Response('private-invalid-response', { status: 201 })
    await assert.rejects(() => api.createPersonalSkillVersion({ capabilityId: 'cap-1', parentVersionId: 'published-1', content: 'source' }, 'invalid-json-key-01', 'access'))
    const record = logs.find(record => record.message === 'personal skill upload result invalid')
    assert.equal(record?.fields.phase, 'response-json')
    assert.doesNotMatch(JSON.stringify(logs), /private-invalid-response/)
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

  it('logs the HTTP status of personal submission queries without response contents', async () => {
    const logs: LogRecord[] = []
    restoreLogSink = setLogSink(record => logs.push(record))
    for (const statusCode of [200, 403, 503]) {
      globalThis.fetch = async () => response(statusCode === 200 ? [version] : { statusCode, message: 'private-query-error' }, statusCode)
      if (statusCode === 200) await api.listSkillVersions({ capabilityId: 'cap-1' }, 'private-access-token')
      else await assert.rejects(() => api.listSkillVersions({ capabilityId: 'cap-1' }, 'private-access-token'))
    }
    const records = logs.filter(record => record.message === 'skill version query response received')
    assert.deepEqual(records.map(record => record.fields.statusCode), [200, 403, 503])
    assert.deepEqual(records.map(record => record.level), ['info', 'warn', 'warn'])
    assert.doesNotMatch(JSON.stringify(logs), /private-query-error|private-access-token/)
  })

  it('aborts a stalled skill version query using the caller signal', async () => {
    const controller = new AbortController()
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.signal, controller.signal)
      return new Promise<Response>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      })
    }
    const pending = api.listSkillVersions({ capabilityId: 'cap-1' }, 'access', controller.signal)
    controller.abort(new DOMException('Confirmation timed out', 'TimeoutError'))
    await assert.rejects(pending, { name: 'TimeoutError' })
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

  for (const status of [400, 401, 403, 404, 409, 429, 500]) {
    it(`retains the platform ${status} error and does not retry writes automatically`, async () => {
      const logs: LogRecord[] = []
      restoreLogSink = setLogSink(record => logs.push(record))
      let calls = 0
      const error = { statusCode: status, message: 'Platform rejection', requestId: 'req-1', timestamp: '2026-09-16', path: '/api/enterprise/skill-versions' }
      globalThis.fetch = async () => { calls++; return response(error, status) }
      await assert.rejects(() => api.createPersonalSkillVersion({ capabilityId: 'cap', parentVersionId: 'v', content: 'text' }, 'valid-key-1234567', 'access'), cause => {
        assert.ok(cause instanceof api.AuthApiError)
        assert.deepEqual(cause.error, error)
        return true
      })
      assert.equal(calls, 1)
      assert.equal(logs.length, 1)
      assert.equal(logs[0]?.level, 'warn')
      assert.equal(logs[0]?.fields.statusCode, status)
      assert.equal(logs[0]?.fields.ok, false)
      assert.doesNotMatch(JSON.stringify(logs), /Platform rejection|Bearer access|"content"/)
    })
  }

})
