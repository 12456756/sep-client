import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMediaMockEnvironment, isMediaMockRendererRequestAllowed } from './electron-media-mock-policy.mjs'

test('copies the parent environment without modifying it', () => {
  const env = Object.freeze({ PATH: '/test/bin', SEP_BASE_URL: 'http://127.0.0.1:3001/api',
    SEP_MCP_CONFIG: '/test/mcp.json', ELECTRON_RENDERER_URL: 'https://example.test', SEP_PLAYWRIGHT_MCP: '1' })
  const before = { ...env }
  const result = createMediaMockEnvironment(env)
  assert.notStrictEqual(result, env)
  assert.deepEqual(env, before)
  assert.deepEqual(result, { PATH: env.PATH, SEP_BASE_URL: env.SEP_BASE_URL, SEP_PLAYWRIGHT_MCP: '0' })
})

test('deletes unsafe configuration keys rather than setting them to undefined', () => {
  for (const value of ['/test/config', '', undefined]) {
    const result = createMediaMockEnvironment({ SEP_MCP_CONFIG: value, ELECTRON_RENDERER_URL: value })
    assert.equal(Object.hasOwn(result, 'SEP_MCP_CONFIG'), false)
    assert.equal(Object.hasOwn(result, 'ELECTRON_RENDERER_URL'), false)
  }
})

test('always disables Playwright MCP and preserves unrelated values', () => {
  for (const value of ['1', 'true', '0', '', undefined]) {
    const result = createMediaMockEnvironment({ SEP_PLAYWRIGHT_MCP: value, OTHER: 'preserved', ABSENT: undefined })
    assert.equal(result.SEP_PLAYWRIGHT_MCP, '0')
    assert.equal(result.OTHER, 'preserved')
    assert.equal(Object.hasOwn(result, 'ABSENT'), true)
  }
  assert.deepEqual(createMediaMockEnvironment({}), { SEP_PLAYWRIGHT_MCP: '0' })
})

test('mutating the returned environment does not change its parent', () => {
  const env = { OTHER: 'parent' }
  const result = createMediaMockEnvironment(env)
  result.OTHER = 'child'
  assert.deepEqual(env, { OTHER: 'parent' })
})

test('allows bundled file pages and static resources', () => {
  for (const url of ['file:///Users/test/out/renderer/index.html', 'file:///C:/app/out/renderer/index.html',
    'file:///app/assets/main.js', 'file:///app/assets/main.css?v=1', 'file:///app/assets/image%20one.png#preview',
    'file://localhost/app/index.html', 'FILE:///app/index.html']) {
    assert.equal(isMediaMockRendererRequestAllowed(url), true, url)
  }
})

test('allows inline data resources', () => {
  for (const url of ['data:image/png;base64,aGVsbG8=', 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
    'data:text/css,body%7Bcolor:red%7D', 'data:text/html,%3Cp%3Elocal%3C/p%3E']) {
    assert.equal(isMediaMockRendererRequestAllowed(url), true, url)
  }
})

test('allows only local-file and null-origin blob resources', () => {
  for (const url of ['blob:file:///app/12345678-1234-1234-1234-123456789abc',
    'blob:file:///C:/app/mock-image', 'blob:null/12345678-1234-1234-1234-123456789abc']) {
    assert.equal(isMediaMockRendererRequestAllowed(url), true, url)
  }
})

test('denies all network requests, including loopback', () => {
  for (const url of ['http://example.test/image.png', 'https://example.test/chat/completions',
    'http://127.0.0.1:3000/', 'http://localhost:3000/', 'http://[::1]:3000/',
    'ws://127.0.0.1/socket', 'wss://example.test/socket', 'ftp://example.test/file',
    'HTTPS://example.test/', '//example.test/file']) {
    assert.equal(isMediaMockRendererRequestAllowed(url), false, url)
  }
})

test('denies remote file hosts and UNC paths, including encoded separators', () => {
  for (const url of ['file://example.test/share/image.png', 'file://127.0.0.1/share/image.png',
    'file:////example.test/share/image.png', 'file:///\\\\example.test/share/image.png',
    'file:///%2fexample.test/share/image.png', 'file:///%5cexample.test/share/image.png',
    'blob:file://example.test/share/image.png', 'blob:file:////example.test/share/image.png']) {
    assert.equal(isMediaMockRendererRequestAllowed(url), false, url)
  }
})

test('denies network-origin and unsupported opaque-origin blobs', () => {
  for (const url of ['blob:https://example.test/image-id', 'blob:http://localhost:3000/image-id',
    'blob:https://example.test/blob:file:///local', 'blob:data:image/png;base64,aGVsbG8=',
    'blob:javascript:alert(1)', 'blob:blob:null/image-id', 'blob:null', 'blob:null/',
    'blob:null//example.test/image-id', 'blob:null/https://example.test/image-id']) {
    assert.equal(isMediaMockRendererRequestAllowed(url), false, url)
  }
})

test('denies malformed, relative, executable and obfuscated URLs', () => {
  for (const url of ['', '/app/index.html', 'not a URL', 'file://', 'file:///', 'file:///app/%zz.png',
    'javascript:alert(1)', 'about:blank', 'https://', ' file:///app/index.html',
    'file:///app/index.html ', 'file:\n///app/index.html', 'blob:\tnull/image-id', 'data:\0image/png,test']) {
    assert.equal(isMediaMockRendererRequestAllowed(url), false, JSON.stringify(url))
  }
})
