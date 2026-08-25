import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  getEmploymentToken,
  getSubscriptions,
  refreshAccessToken,
  searchKnowledgeBases,
} from './auth-api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('SEP auth API contracts', () => {
  it('sends only the refresh token to the access refresh endpoint', async () => {
    let request: { url: string; init?: RequestInit } | undefined
    globalThis.fetch = async (input, init) => {
      request = { url: String(input), init }
      return Response.json({
        accessToken: 'access_2',
        accessTokenExpiresIn: 3600,
        user: { id: 'member_1', email: 'member@example.com', name: 'Member' },
        enterprise: { id: 'enterprise_1', name: 'Enterprise' },
      })
    }

    await refreshAccessToken('refresh_1')

    assert.match(request?.url ?? '', /\/client\/auth\/refresh$/)
    assert.equal(request?.init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(request?.init?.body)), { refreshToken: 'refresh_1' })
  })

  it('uses subscriptionId and parses employmentToken', async () => {
    let body: unknown
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({
        employmentToken: 'employment_1',
        expiresIn: 900,
        employment: { id: 'sub_1', name: 'Employee', templateId: 'employee_1', status: 'ACTIVE' },
      })
    }

    const result = await getEmploymentToken({ refreshToken: 'refresh_1', subscriptionId: 'sub_1' })

    assert.deepEqual(body, { refreshToken: 'refresh_1', subscriptionId: 'sub_1' })
    assert.equal(result.employmentToken, 'employment_1')
  })

  it('prefers the subscriptions endpoint and normalizes the authorized model list', async () => {
    const urls: string[] = []
    globalThis.fetch = async input => {
      urls.push(String(input))
      return Response.json([{
        subscriptionId: 'sub_1',
        employeeId: 'employee_1',
        name: 'Employee',
        status: 'ACTIVE',
        templateVersion: '1.2.3',
        template: { id: 'employee_1', name: 'Employee', avatar: null },
        department: null,
        allowedModels: ['gpt-4o-mini', 42],
      }])
    }

    const result = await getSubscriptions('access_1')

    assert.match(urls[0], /\/client\/subscriptions$/)
    assert.deepEqual(result[0].allowedModels, ['gpt-4o-mini'])
    assert.equal(result[0].subscriptionId, 'sub_1')
    assert.equal(result[0].employeeId, 'employee_1')
  })

  it('falls back to the legacy instances endpoint only when subscriptions is missing', async () => {
    const urls: string[] = []
    globalThis.fetch = async input => {
      urls.push(String(input))
      if (urls.length === 1) return new Response('', { status: 404 })
      return Response.json([{
        id: 'sub_legacy', employeeId: 'employee_1', name: 'Employee', status: 'ACTIVE', templateVersion: '1.0.0',
        template: { id: 'employee_1', name: 'Employee', avatar: null }, department: null, allowedModels: ['model-a'],
      }])
    }

    const result = await getSubscriptions('access_1')

    assert.match(urls[0], /\/client\/subscriptions$/)
    assert.match(urls[1], /\/client\/instances$/)
    assert.equal(result[0].subscriptionId, 'sub_legacy')
  })
})

describe('SEP knowledge-base API contracts', () => {
  it('trims identifiers and clamps unsafe search parameters', async () => {
    let body: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ query: 'policy', subscriptionId: 'sub_1', strategy: 'lexical', durationMs: 1, count: 0, results: [] })
    }

    await searchKnowledgeBases('access_1', {
      query: '  policy  ',
      subscriptionId: '  sub_1  ',
      topK: Number.NaN,
      scoreThreshold: 12,
      strategy: 'unexpected' as 'auto',
    })

    assert.deepEqual(body, {
      query: 'policy',
      subscriptionId: 'sub_1',
      topK: 5,
      scoreThreshold: 1,
      strategy: 'auto',
    })
  })

  it('rejects blank search requests before making a network call', async () => {
    let requests = 0
    globalThis.fetch = async () => {
      requests += 1
      return Response.json({})
    }

    await assert.rejects(
      () => searchKnowledgeBases('access_1', { query: ' ', subscriptionId: 'sub_1' }),
      /query and subscription ID are required/,
    )
    assert.equal(requests, 0)
  })
})
