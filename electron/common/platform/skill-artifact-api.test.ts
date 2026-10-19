import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { config } from '../config'
import { AuthApiError } from './platform-api'
import { downloadSkillArtifact } from './skill-artifact-api'
import { maxSkillArtifactBytes, type SkillArtifactAvailable } from './skill-artifact-contract'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const bytes = Buffer.from('---\r\nname: example-skill\r\ndescription: Example\r\n---\r\n\r\n# Exact source  \r\n\t')
const digest = createHash('sha256').update(bytes).digest('hex')
const artifact: SkillArtifactAvailable = {
  protocolVersion: 1, capabilityId: 'cap-1', versionId: 'approved-1', approvedContentSha256: 'a'.repeat(64),
  status: 'AVAILABLE', format: 'single-file', installationDirectory: 'example-skill', entryPath: 'SKILL.md',
  entrySha256: digest, artifactSha256: digest, byteLength: bytes.length, fileCount: 1,
  downloadPath: '/client/subscriptions/sub-1/skills/cap-1/versions/approved-1/artifact',
}

function headers(value: SkillArtifactAvailable = artifact): Record<string, string> {
  return { 'Content-Type': value.format === 'zip' ? 'application/zip' : 'text/markdown; charset=utf-8',
    'Content-Length': String(value.byteLength), 'X-SHA256': value.artifactSha256 }
}

describe('skill artifact authenticated download', () => {
  it('returns exact Buffer bytes using only the ordinary access token and configured API prefix', async () => {
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls++
      assert.equal(String(input), `${config.SEP_BASE_URL}${artifact.downloadPath}`)
      assert.equal(init?.method, 'GET')
      assert.deepEqual([...new Headers(init?.headers)], [['authorization', 'Bearer ordinary-access']])
      assert.equal(init?.credentials, 'omit')
      assert.equal(init?.redirect, 'error')
      assert.ok(init?.signal instanceof AbortSignal)
      return new Response(bytes, { headers: headers() })
    }
    const result = await downloadSkillArtifact('sub-1', artifact, 'ordinary-access')
    assert.ok(Buffer.isBuffer(result))
    assert.deepEqual(result, bytes)
    assert.equal(calls, 1)
  })

  it('supports ZIP transport integrity without extracting or installing it', async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
    const descriptor: SkillArtifactAvailable = { ...artifact, format: 'zip', entryPath: 'example-skill/SKILL.md',
      byteLength: zip.length, artifactSha256: createHash('sha256').update(zip).digest('hex'), fileCount: 2 }
    globalThis.fetch = async () => new Response(zip, { headers: headers(descriptor) })
    assert.deepEqual(await downloadSkillArtifact('sub-1', descriptor, 'access'), zip)
  })

  it('rejects invalid/blocked descriptors, IDs, identities and missing tokens before sending any request', async () => {
    globalThis.fetch = async () => { assert.fail('Invalid input must not reach the network') }
    for (const override of [
      { status: 'BLOCKED', reason: 'PACKAGE_REQUIRED' }, { protocolVersion: 2 },
      { downloadPath: '/client/subscriptions/other/skills/cap-1/versions/approved-1/artifact' },
      { downloadPath: '/client/subscriptions/sub-1/skills/other/versions/approved-1/artifact' },
      { downloadPath: '/client/subscriptions/sub-1/skills/cap-1/versions/other/artifact' },
      { capabilityId: 'other' }, { versionId: 'other' }, { apiKey: 'private' },
      { downloadPath: `https://example.com${artifact.downloadPath}` }, { downloadPath: `/api${artifact.downloadPath}` },
      { downloadPath: `${artifact.downloadPath}?token=private` }, { byteLength: maxSkillArtifactBytes + 1 },
    ]) await assert.rejects(downloadSkillArtifact('sub-1', { ...artifact, ...override } as SkillArtifactAvailable, 'access'))
    for (const id of ['', '..', 'a/b', 'a%2fb', 'a'.repeat(129)]) {
      await assert.rejects(downloadSkillArtifact(id, artifact, 'access'))
    }
    for (const token of ['', '  ']) await assert.rejects(downloadSkillArtifact('sub-1', artifact, token))
  })

  for (const status of [401, 403, 404, 409, 500]) {
    it(`propagates HTTP ${status} without a legacy fallback or leaking response secrets`, async () => {
      let calls = 0
      let cancelled = false
      globalThis.fetch = async () => {
        calls++
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(Buffer.from('private-upstream-message')) },
          cancel() { cancelled = true },
        }), { status })
      }
      await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'private-access-token'), error => {
        assert.ok(error instanceof AuthApiError)
        assert.equal(error.statusCode, status)
        assert.doesNotMatch(error.message, /private/)
        return true
      })
      assert.equal(calls, 1)
      assert.equal(cancelled, true)
    })
  }

  it('rejects redirect statuses and already redirected responses', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      globalThis.fetch = async () => new Response(null, { status, headers: { Location: 'https://example.com/private' } })
      await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'), /redirects are forbidden/)
    }
    globalThis.fetch = async () => {
      const response = new Response(bytes, { headers: headers() })
      Object.defineProperty(response, 'redirected', { value: true })
      return response
    }
    await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'), /redirects are forbidden/)
  })

  it('requires matching MIME, length and X-SHA256 headers before reading bytes', async () => {
    const cases = [
      { field: 'Content-Type', value: null }, { field: 'Content-Type', value: 'text/plain' },
      { field: 'Content-Type', value: 'application/zip' }, { field: 'Content-Type', value: 'application/json' },
      { field: 'Content-Length', value: null }, { field: 'Content-Length', value: '0' },
      { field: 'Content-Length', value: String(bytes.length + 1) }, { field: 'Content-Length', value: `${bytes.length}.0` },
      { field: 'Content-Length', value: `${bytes.length}e0` }, { field: 'Content-Length', value: String(maxSkillArtifactBytes + 1) },
      { field: 'X-SHA256', value: null }, { field: 'X-SHA256', value: digest.toUpperCase() },
      { field: 'X-SHA256', value: 'b'.repeat(64) },
    ]
    for (const { field, value } of cases) {
      let cancelled = false
      globalThis.fetch = async () => {
        const responseHeaders = new Headers(headers())
        if (value === null) responseHeaders.delete(field)
        else responseHeaders.set(field, value)
        return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: responseHeaders })
      }
      await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'), /MIME mismatch|content length mismatch|checksum header mismatch/)
      assert.equal(cancelled, true, field)
    }
  })

  it('counts streamed bytes independently of the advertised length and cancels overflow immediately', async () => {
    let cancelled = false
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.enqueue(Buffer.from('extra'))
      },
      cancel() { cancelled = true },
    }), { headers: headers() })
    await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'), /byte limit exceeded/)
    assert.equal(cancelled, true)
  })

  it('accepts multiple chunks only when their exact byte count and actual hash match', async () => {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 5))
        controller.enqueue(bytes.subarray(5))
        controller.close()
      },
    }), { headers: headers() })
    assert.deepEqual(await downloadSkillArtifact('sub-1', artifact, 'access'), bytes)
  })

  it('rejects a truncated body, wrong actual hash, empty body and non-200 success status', async () => {
    for (const body of [bytes.subarray(0, bytes.length - 1), Buffer.alloc(bytes.length)]) {
      globalThis.fetch = async () => new Response(body, { headers: headers() })
      await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'), /body length mismatch|SHA256 mismatch/)
    }
    globalThis.fetch = async () => new Response(null, { headers: headers() })
    await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'), /body is missing/)
    globalThis.fetch = async () => new Response(bytes, { status: 206, headers: headers() })
    await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'), /response status/)
  })

  it('propagates network and stream errors without retrying', async () => {
    for (const duringStream of [false, true]) {
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        if (!duringStream) throw new Error('Network unavailable')
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Stream interrupted')) } }), { headers: headers() })
      }
      await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'), /Network unavailable|Stream interrupted/)
      assert.equal(calls, 1)
    }
  })

  for (const baseUrl of ['https://api.example.com', 'https://api.example.com/api', 'https://api.example.com/custom/v2/']) {
    it(`retains the configured API prefix ${baseUrl}`, () => {
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { downloadSkillArtifact } from ${JSON.stringify(new URL('./skill-artifact-api.ts', import.meta.url).href)};
        const bytes = Buffer.from(${JSON.stringify([...bytes])});
        globalThis.fetch = async (input, init) => {
          assert.equal(String(input), ${JSON.stringify(baseUrl.replace(/\/+$/, '') + artifact.downloadPath)});
          assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ordinary-access');
          return new Response(bytes, { headers: ${JSON.stringify(headers())} });
        };
        assert.deepEqual(await downloadSkillArtifact('sub-1', ${JSON.stringify(artifact)}, 'ordinary-access'), bytes);
      `], { env: { ...process.env, SEP_BASE_URL: baseUrl }, stdio: 'pipe' })
    })
  }

  it('blocks real HTTP redirects before a second endpoint can receive the access token', async t => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.writeHead(302, { Location: '/capture' })
      response.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const realFetch = globalThis.fetch
    globalThis.fetch = async (_input, init) => realFetch(`http://127.0.0.1:${address.port}${artifact.downloadPath}`, init)
    await assert.rejects(downloadSkillArtifact('sub-1', artifact, 'access'))
    assert.equal(requests, 1)
  })
})
