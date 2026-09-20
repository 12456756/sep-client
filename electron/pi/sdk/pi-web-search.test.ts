import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createWebSearchTool, type WebSearchFetch } from './pi-web-search'

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

describe('web_search tool', () => {
  it('queries the fixed search endpoint and returns parsed results', async () => {
    let requestedUrl = ''
    const fetchImpl: WebSearchFetch = async (input) => {
      requestedUrl = String(input)
      return response(`
        <a rel="nofollow" class="result__a" href="https://example.com/a">Example &amp; One</a>
        <a class="result__snippet">A useful &lt;b&gt;summary&lt;/b&gt;.</a>
        <a rel="nofollow" class="result__a" href="https://example.com/b">Second</a>
        <a class="result__snippet">Second summary</a>
      `)
    }

    const result = await createWebSearchTool({ fetchImpl }).execute(
      'call-1',
      { query: 'pi coding agent', maxResults: 2 },
      undefined,
    )

    assert.match(requestedUrl, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/)
    assert.equal(new URL(requestedUrl).searchParams.get('q'), 'pi coding agent')
    assert.equal(result.details?.query, 'pi coding agent')
    assert.equal(result.details?.results.length, 2)
    assert.deepEqual(result.details?.results[0], {
      title: 'Example & One',
      url: 'https://example.com/a',
      snippet: 'A useful summary.',
    })
    assert.match(contentText(result), /Example & One/)
  })

  it('throws a tool error for an unsuccessful search response', async () => {
    const fetchImpl: WebSearchFetch = async () => response('upstream unavailable', 503)
    await assert.rejects(
      createWebSearchTool({ fetchImpl }).execute('call-2', { query: 'anything' }, undefined),
      /Web search failed: HTTP 503/,
    )
  })
})

function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? ''
}
