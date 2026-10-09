import { lookup } from 'node:dns'
import { realpathSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { pathToFileURL } from 'node:url'
import {
  MANIFEST_NAMES, MAX_MANIFEST_BYTES, parseManifest, readBounded,
  validateManifestName, validateManifestSet, verifyStream,
} from './verify-update-manifest.mjs'

export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 120_000
export const MAX_REDIRECTS = 5

function isLoopback(host) {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'))
}

function validateTransport(url, allowLocalHttp) {
  if (url.username || url.password || url.search || url.hash || url.pathname.includes('%')) {
    throw new Error('update URL must not contain credentials, query, fragment or encoded paths')
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && allowLocalHttp && (url.hostname === 'localhost' || isLoopback(url.hostname))) return
  throw new Error('HTTPS is required; --allow-local-http permits only loopback fixture URLs')
}

function hasUnsafeUrlCharacters(value) {
  return value.includes('\\') || Array.from(value).some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 || /\s/.test(character)
  })
}

export function normalizeFeedUrl(value, { allowLocalHttp = false } = {}) {
  // Reject dot segments, encoded paths and backslashes before URL normalization.
  if (typeof value !== 'string' || value.trim() !== value || hasUnsafeUrlCharacters(value)) throw new Error('invalid update base URL')
  const rawPath = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/.exec(value)?.[1] ?? ''
  if (rawPath.includes('%') || rawPath.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('update base URL must not contain dot segments or encoded paths')
  let url
  try { url = new URL(value) } catch { throw new Error('invalid update base URL') }
  validateTransport(url, allowLocalHttp)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

export function validateFeedRequestUrl(value, base, { allowLocalHttp = false } = {}) {
  const url = value instanceof URL ? value : new URL(value, base)
  validateTransport(url, allowLocalHttp)
  if (url.origin !== base.origin) throw new Error('cross-origin redirect/request is forbidden')
  if (!url.pathname.startsWith(base.pathname)) throw new Error('cross-channel redirect/request is forbidden')
  return url
}

function loopbackLookup(host, options, callback) {
  lookup(host, { ...options, all: false }, (error, address, family) => {
    if (error) return callback(error)
    if (!isLoopback(address)) return callback(new Error('local HTTP fixture hostname resolved outside loopback'))
    callback(null, options.all ? [{ address, family }] : address, family)
  })
}

function getResponse(url, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.get(url, {
      signal,
      // Native requests have no cookie jar or authorization header; every request is anonymous.
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
      ...(url.protocol === 'http:' ? { lookup: loopbackLookup } : {}),
    }, resolve)
    request.once('error', reject)
  })
}

async function consumeResponse(initialUrl, base, options, consume) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, allowLocalHttp = false } = options
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    let url = initialUrl
    for (let redirects = 0; ; redirects += 1) {
      validateFeedRequestUrl(url, base, { allowLocalHttp })
      response = await getResponse(url, controller.signal)
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location
        response.destroy()
        if (!location || redirects >= MAX_REDIRECTS) throw new Error('missing redirect location or redirect limit exceeded')
        if (hasUnsafeUrlCharacters(location)) throw new Error('invalid redirect URL')
        url = validateFeedRequestUrl(new URL(location, url), base, { allowLocalHttp })
        continue
      }
      if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}: ${url.pathname}`)
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('encoded update responses are forbidden')
      return await consume(response)
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`update request timed out after ${timeoutMs}ms`, { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    response?.destroy()
  }
}

function contentLength(response) {
  const value = response.headers['content-length']
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('invalid HTTP Content-Length')
  return Number(value)
}

export async function verifyUpdateFeed(baseUrl, { manifestName, requireAllPlatforms = false, ...options } = {}) {
  if (manifestName) validateManifestName(manifestName)
  const base = normalizeFeedUrl(baseUrl, options)
  const manifests = []
  for (const name of manifestName ? [manifestName] : MANIFEST_NAMES) {
    const manifest = await consumeResponse(new URL(name, base), base, options, async response => {
      const length = contentLength(response)
      if (length !== undefined && length > MAX_MANIFEST_BYTES) throw new Error('manifest exceeds maximum size')
      return parseManifest(await readBounded(response), name)
    })
    manifests.push({ name, manifest })
  }
  validateManifestSet(manifests, { requireAllPlatforms })
  const results = []
  for (const { name, manifest } of manifests) {
    const files = []
    for (const file of manifest.files) {
      const integrity = await consumeResponse(new URL(file.url, base), base, options, async response => {
        const length = contentLength(response)
        if (length !== undefined && length !== file.size) throw new Error(`${file.url}: HTTP size mismatch (expected ${file.size}, received ${length})`)
        return verifyStream(response, file)
      })
      files.push(integrity)
    }
    results.push({ name, version: manifest.version, files })
  }
  return results
}

export async function main(args = process.argv.slice(2)) {
  const usage = 'usage: node scripts/test-update-feed.mjs <base-url> [--allow-local-http] [--manifest latest.yml|latest-mac.yml] [--require-all-platforms]'
  let baseUrl
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--allow-local-http' && !options.allowLocalHttp) options.allowLocalHttp = true
    else if (arg === '--require-all-platforms' && !options.requireAllPlatforms) options.requireAllPlatforms = true
    else if (arg === '--manifest' && !options.manifestName) options.manifestName = validateManifestName(args[++index])
    else if (!arg.startsWith('--') && !baseUrl) baseUrl = arg
    else throw new Error(usage)
  }
  if (!baseUrl) throw new Error(usage)
  const results = await verifyUpdateFeed(baseUrl, options)
  for (const result of results) console.log(`verified anonymous feed ${result.name}: ${result.version}, ${result.files.length} artifacts (HTTP 200 + size + SHA512)`)
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    console.error(`update feed verification failed: ${error.message}`)
    process.exitCode = 1
  }
}
