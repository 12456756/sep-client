/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function createMediaMockEnvironment(env) {
  /** @type {NodeJS.ProcessEnv} */
  const result = { ...env, SEP_PLAYWRIGHT_MCP: '0' }
  delete result.SEP_MCP_CONFIG
  delete result.ELECTRON_RENDERER_URL
  return result
}

/** @param {URL} url */
function isLocalFileUrl(url) {
  const path = decodeURIComponent(url.pathname)
  // Remote file hosts and UNC paths can access network shares on Windows.
  return url.hostname === '' && path.length > 1 && path.startsWith('/')
    && !path.startsWith('//') && !path.includes('\\')
}

/**
 * Denies every network scheme, including loopback and network-origin blobs.
 * @param {string} url
 * @returns {boolean}
 */
export function isMediaMockRendererRequestAllowed(url) {
  if (typeof url !== 'string' || !url || url !== url.trim()
    || [...url].some(char => {
      const code = char.charCodeAt(0)
      return code < 32 || code === 127
    })) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return isLocalFileUrl(parsed)
    if (parsed.protocol === 'data:') return true
    if (parsed.protocol !== 'blob:') return false
    if (/^null\/[^/?#]+$/.test(parsed.pathname)) return true
    const source = new URL(parsed.pathname)
    return source.protocol === 'file:' && isLocalFileUrl(source)
  } catch {
    return false
  }
}
