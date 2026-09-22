import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { externalWebLink } from './external-web-link'

describe('conversation external links', () => {
  it('only allows absolute web URLs without embedded credentials', () => {
    assert.equal(externalWebLink('https://example.com/docs'), 'https://example.com/docs')
    assert.equal(externalWebLink('http://example.com'), 'http://example.com/')
    for (const value of ['javascript:alert(1)', 'file:///C:/private', 'data:text/html,x', 'mailto:a@b.com', '//example.com', '/relative', 'https://user:pass@example.com', 'not a URL']) {
      assert.equal(externalWebLink(value), null, value)
    }
  })
  it('opens links outside the privileged renderer and always denies child windows', () => {
    const source = readFileSync(new URL('../bootstrap/main-window.ts', import.meta.url), 'utf8')
    assert.match(source, /setWindowOpenHandler/)
    assert.match(source, /externalWebLink\(url\)/)
    assert.match(source, /shell\.openExternal\(link\)/)
    assert.match(source, /action: 'deny'/)
  })
})
