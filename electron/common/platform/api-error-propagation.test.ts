import { afterEach, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ClientMonitorApi, ClientMonitorApiError } from './client-monitor-api'
import { KnowledgeApi, KnowledgeApiError } from './knowledge-api'
import { AuthApiError } from './platform-api'
import { downloadSkillArtifact } from './skill-artifact-api'
import type { SkillArtifactAvailable } from './skill-artifact-contract'
import { toEnvelope } from '../../errors/error-mapper'
import { KnowledgeService } from '../../service/knowledge-service'
import type { ApiDiagnostic } from '../../../src/shared/api-diagnostic'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const requestId = 'c49b8f02-2143-4a61-9d62-459c2cb82193'
const hash = createHash('sha256').update('fixture').digest('hex')
const artifact: SkillArtifactAvailable = { protocolVersion: 1, capabilityId: 'cap', versionId: 'version', approvedContentSha256: hash,
  status: 'AVAILABLE', format: 'single-file', installationDirectory: 'example-skill', entryPath: 'SKILL.md', entrySha256: hash,
  artifactSha256: hash, byteLength: 7, fileCount: 1, downloadPath: '/client/subscriptions/sub/skills/cap/versions/version/artifact' }

function evidence(error: unknown): ApiDiagnostic {
  if (error instanceof ClientMonitorApiError || error instanceof KnowledgeApiError) {
    assert.ok(error.diagnostic); return error.diagnostic
  }
  assert.ok(error instanceof AuthApiError && error.error.diagnostic)
  return error.error.diagnostic
}

for (const kind of ['monitor', 'knowledge', 'skill'] as const) {
  function load(fetcher: typeof fetch, signal?: AbortSignal, refreshes: boolean[] = []): Promise<unknown> {
    const getAccessToken = async (force?: boolean) => { refreshes.push(!!force); return 'fixture-credential' }
    if (kind === 'monitor') return new ClientMonitorApi({ fetch: fetcher, getAccessToken }).updateStatus('mirror', { status: 'RUNNING' }, signal)
    if (kind === 'knowledge') return new KnowledgeApi({ fetch: fetcher, getAccessToken }).execute({ requestId, action: 'getBase', kbId: 'kb' }, signal)
    globalThis.fetch = fetcher
    return downloadSkillArtifact('sub', artifact, 'fixture-credential', { signal })
  }

  it(`${kind} keeps conflict reasons, arbitrary JSON and independent IDs without reflecting raw text`, async () => {
    for (const body of ['Stale client run', { error: 'Immutable event conflict' }, { code: 123, reason: 'Unregistered reason', details: [{ field: 'sequence' }] }, null, [false, { message: 'Original reason' }]]) {
      let calls = 0
      await assert.rejects(load(async () => {
        calls++
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 409,
          headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'X-Request-ID': 'sep-id',
            'X-Compute-Request-ID': 'compute-id', 'X-Upstream-Request-ID': 'upstream-id', 'X-Compute-Status': '200', 'Retry-After': '0' } })
      }), error => {
        const diagnostic = evidence(error)
        assert.deepEqual(diagnostic.body, body)
        assert.equal(diagnostic.httpStatus, 409)
        assert.equal(diagnostic.sepRequestId, 'sep-id')
        assert.equal(diagnostic.computeRequestId, 'compute-id')
        assert.equal(diagnostic.upstreamRequestId, 'upstream-id')
        assert.equal(diagnostic.computeStatus, 200)
        assert.ok(error instanceof Error)
        assert.doesNotMatch(error.message, /Stale client run|Immutable event conflict|Unregistered reason|Original reason/)
        if (kind !== 'monitor') assert.deepEqual(toEnvelope(error).diagnostic, diagnostic)
        return true
      })
      assert.equal(calls, 1)
    }
  })

  it(`${kind} does not refresh or invalidate desktop authentication for upstream 401`, async () => {
    let calls = 0
    const refreshes: boolean[] = []
    await assert.rejects(load(async () => {
      calls++
      return Response.json({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } },
        { status: 401, headers: { 'X-SEP-Error-Source': 'upstream' } })
    }, undefined, refreshes), error => {
      assert.equal(evidence(error).source, 'upstream')
      assert.ok(error instanceof ClientMonitorApiError || error instanceof KnowledgeApiError || error instanceof AuthApiError)
      assert.equal(error.isUnauthorized, false)
      if (kind !== 'monitor') {
        const result = toEnvelope(error, { authenticated: true, ...(kind === 'skill' ? { feedbackOperation: 'workRetry' as const } : {}) })
        assert.equal(result.code, 'SERVICE_UNAVAILABLE')
        assert.equal(result.statusCode, 401)
        assert.doesNotMatch(result.message, /重新登录/)
      }
      return true
    })
    assert.equal(calls, 1)
    assert.ok(refreshes.every(force => !force))
  })

  it(`${kind} removes echoed credentials and signed URLs but retains the reason`, async () => {
    await assert.rejects(load(async () => Response.json({ message: 'Rejected fixture-credential', apiKey: 'private-key',
      details: [{ message: 'Cookie: session=private-cookie' }], url: 'https://storage.invalid/?Signature=private-signature' }, { status: 409 })), error => {
      const diagnostic = evidence(error)
      assert.match(diagnostic.message ?? '', /Rejected/)
      assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-credential|private-key|private-cookie|private-signature|storage.invalid/)
      return true
    })
  })

  it(`${kind} preserves partial and oversized error evidence`, async () => {
    let reads = 0
    for (const response of [new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (++reads === 1) controller.enqueue(Buffer.from('Original failure reason'))
      else controller.error(new Error('connection reset fixture-credential'))
    } }), { status: 409 }), new Response('Failure '.repeat(12_000), { status: 409 })]) {
      await assert.rejects(load(async () => response), error => {
        const diagnostic = evidence(error)
        assert.ok(diagnostic.readError || diagnostic.truncated)
        assert.ok(typeof diagnostic.body === 'string')
        assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-credential/)
        return true
      })
      assert.equal(response.body?.locked, false)
    }
  })

  it(`${kind} aborts stalled error bodies without waiting for cancellation acknowledgement`, async () => {
    const controller = new AbortController()
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    let cancelled = false
    const pending = assert.rejects(load(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(Buffer.from('Partial reason')) }, pull() { ready() },
      cancel() { cancelled = true; return new Promise(() => {}) },
    }), { status: 409 }), controller.signal))
    await started
    controller.abort()
    await pending
    assert.equal(cancelled, true)
  })

  it(`${kind} retains network causes without fabricating an HTTP status`, async () => {
    await assert.rejects(load(async () => { throw new TypeError('fetch failed fixture-credential', {
      cause: Object.assign(new Error('TLS failure fixture-credential'), { code: 'ECONNRESET' }),
    }) }), error => {
      const diagnostic = evidence(error)
      assert.equal(diagnostic.httpStatus, undefined)
      assert.match(JSON.stringify(diagnostic.transportError), /TLS failure|ECONNRESET/)
      assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-credential/)
      return true
    })
  })
}

for (const kind of ['monitor', 'knowledge'] as const) {
  it(`${kind} retains token acquisition diagnostics without treating upstream failure as session expiry`, async () => {
    const diagnostic: ApiDiagnostic = { source: 'upstream', httpStatus: 401, code: 'INVALID_API_KEY',
      message: 'Upstream authorization failed', sepRequestId: 'auth-request' }
    const getAccessToken = async (): Promise<string> => {
      throw new AuthApiError({ statusCode: 401, message: 'Authorization failed', requestId: 'auth-request', diagnostic })
    }
    const fetcher: typeof fetch = async () => { assert.fail('must not send a request without a token') }
    const pending = kind === 'monitor'
      ? new ClientMonitorApi({ getAccessToken, fetch: fetcher }).updateStatus('mirror', { status: 'RUNNING' })
      : new KnowledgeApi({ getAccessToken, fetch: fetcher }).execute({ requestId, action: 'getBase', kbId: 'kb' })
    await assert.rejects(pending, error => {
      assert.deepEqual(evidence(error), diagnostic)
      assert.ok(error instanceof ClientMonitorApiError || error instanceof KnowledgeApiError)
      assert.equal(error.statusCode, 401)
      assert.equal(error.isUnauthorized, false)
      assert.doesNotMatch(error.message, /重新登录|Upstream authorization failed/)
      return true
    })
  })
}

it('preserves knowledge degraded results, nullable strategies and sanitized arbitrary diagnostics', async () => {
  for (const status of ['MATCHED', 'NO_MATCH', 'NO_ACCESS', 'NOT_READY'] as const) {
    const diagnostic = { message: 'Embedding rejected fixture-credential', code: 123, details: [{ count: 2, apiKey: 'private-key' }] }
    const api = new KnowledgeApi({ getAccessToken: async () => 'fixture-credential', fetch: async () => Response.json({
      status, results: [], actualStrategy: null, degraded: true, partial: false, durationMs: 1,
      degradationReason: 'QUERY_EMBEDDING_UNAVAILABLE', diagnostic,
    }) })
    const result = await api.execute({ requestId, action: 'search', query: 'policy', topK: 5 })
    assert.equal(result.status, status)
    assert.equal(result.actualStrategy, null)
    assert.equal(result.degradationReason, 'QUERY_EMBEDDING_UNAVAILABLE')
    assert.match(JSON.stringify(result.diagnostic), /Embedding rejected|123|count/)
    assert.doesNotMatch(JSON.stringify(result), /fixture-credential|private-key/)
  }
})

it('does not clear the knowledge service session for upstream authorization failure', async () => {
  let invalidations = 0
  const api = new KnowledgeApi({ getAccessToken: async () => 'fixture-credential', fetch: async () => Response.json({ message: 'Invalid API key' },
    { status: 401, headers: { 'X-SEP-Error-Source': 'upstream' } }) })
  const service = new KnowledgeService({ api, scope: { currentScope: () => ({ memberId: 'member', enterpriseId: 'enterprise' }) },
    onAuthenticationRequired: () => { invalidations++ } })
  await assert.rejects(service.execute({ requestId, action: 'search', query: 'policy', topK: 5 }), error => evidence(error).source === 'upstream')
  assert.equal(invalidations, 0)
})

it('keeps specific skill blocking reasons through operation feedback without downloading another version', async () => {
  for (const [reason, expected] of [['INVALID_ENTRY', /入口文件无效/], ['PACKAGE_REQUIRED', /需要完整技能包/],
    ['PACKAGE_UNAVAILABLE', /技能包暂不可用/], ['PACKAGE_CONTENT_MISMATCH', /批准版本不一致/], ['unknown reason', /暂不允许安装/]] as const) {
    let calls = 0
    globalThis.fetch = async () => { calls++; return Response.json({ error: { code: 'SKILL_ARTIFACT_BLOCKED', reason } }, { status: 409 }) }
    await assert.rejects(downloadSkillArtifact('sub', artifact, 'fixture-credential'), error => {
      const result = toEnvelope(error, { feedbackOperation: 'workRetry', authenticated: true })
      assert.match(result.message, expected)
      assert.doesNotMatch(result.message, /SKILL_ARTIFACT_BLOCKED|unknown reason|409/)
      assert.equal(result.diagnostic?.code, 'SKILL_ARTIFACT_BLOCKED')
      return true
    })
    assert.equal(calls, 1)
  }
})

it('retains the final skill rate-limit diagnostic and actual Retry-After hint when the budget is exhausted', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ code: 'SKILL_QUOTA_EXCEEDED', message: 'Quota unavailable' },
    { status: 429, headers: { 'Retry-After': '301', 'X-Request-ID': 'rate-id' } }) }
  await assert.rejects(downloadSkillArtifact('sub', artifact, 'fixture-credential'), error => {
    assert.ok(error instanceof AuthApiError)
    assert.equal(error.error.retryAfterMs, 301000)
    assert.equal(error.error.requestId, 'rate-id')
    assert.equal(error.error.diagnostic?.code, 'SKILL_QUOTA_EXCEEDED')
    return true
  })
  assert.equal(calls, 1)
})
