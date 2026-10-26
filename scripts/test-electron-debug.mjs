import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PROJECT_ROOT, TOOL_VERSION, ensureElectronDebugMcp } from './electron-debug-mcp.mjs'

const port = Number(process.env.SEP_ELECTRON_DEBUG_PORT ?? 9333)
const mainPort = Number(process.env.SEP_ELECTRON_INSPECT_PORT ?? 9334)
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid debug port')
assert.ok(Number.isInteger(mainPort) && mainPort >= 1024 && mainPort <= 65535 && mainPort !== port, 'Invalid inspector port')
const endpoint = 'http://127.0.0.1:' + port
const version = await (await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(5000) })).json()
assert.match(version['User-Agent'], /longsilicon\/.*Electron\//, 'Endpoint must be the real sep-client')
const output = join(PROJECT_ROOT, 'output', 'electron-debug-mcp', 'run-' + Date.now())
await mkdir(output, { recursive: true })
await ensureElectronDebugMcp()
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(PROJECT_ROOT, 'scripts', 'electron-debug-mcp.mjs')], cwd: PROJECT_ROOT, stderr: 'pipe' })
transport.stderr?.on('data', () => {})
const client = new Client({ name: 'sep-client-electron-debug-check', version: '1.0.0' }, { capabilities: {} })
const evidence = { passed: false, toolVersion: TOOL_VERSION, endpoint, checks: [], screenshots: [],
  scope: 'Actual development main/preload/App; no login, credential access or fixture API.' }
let processId
let mainProcessId
let targetId
let originalRemember
let hmrRule
const cssPath = join(PROJECT_ROOT, 'src', 'index.css')

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: { ...(processId ? { processId } : {}), ...args } })
  assert.ok(!result.isError, name + ': ' + result.content.filter(x => x.type === 'text').map(x => x.text).join('\n'))
  return result
}
function json(result) { return JSON.parse(result.content.find(item => item.type === 'text').text) }
async function evaluate(expression) {
  const value = json(await call('evaluate', { targetId, expression }))
  assert.ok(!value.result.exceptionDetails, 'Renderer expression failed')
  return value.result.result.value
}
async function screenshot(name) {
  const focused = json(await call('evaluate_main', { processId: mainProcessId,
    expression: '(() => { const e = process.getBuiltinModule("module").createRequire(process.cwd()+"/package.json")("electron");' +
      'const w = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === ' + JSON.stringify(evidence.identity.url) + ');' +
      'if (!w) throw new Error("Application window missing"); if (w.isMinimized()) w.restore(); w.show();' +
      'e.app.focus({steal:true}); w.focus(); return w.isVisible(); })()' }))
  assert.equal(focused.result.result.value, true, 'Actual native window must be visible')
  await call('cdp_command', { targetId, method: 'Page.bringToFront' })
  await until(async () => await evaluate('document.visibilityState === "visible"'), 'Renderer remains hidden; activate the native application window')
  const result = await call('screenshot', { targetId, format: 'png' })
  const img = result.content.find(item => item.type === 'image')
  assert.equal(img?.mimeType, 'image/png')
  const bytes = Buffer.from(img.data, 'base64')
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  await writeFile(join(output, name), bytes)
  evidence.screenshots.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
async function until(check, message) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(message)
}

try {
  await client.connect(transport)
  evidence.toolCount = (await client.listTools()).tools.length
  const attached = json(await call('attach', { debugPort: port, name: 'sep-client-development-check' }))
  assert.equal(attached.attached, true)
  processId = attached.id
  const target = attached.targets.find(item => item.type === 'page' &&
    /^http:\/\/(localhost|127\.0\.0\.1):/.test(item.url) && !item.url.includes('preview='))
  assert.ok(target, 'Real application page required; workspace preview does not qualify')
  targetId = target.id
  const identity = await evaluate('({url:location.href, platform:window.electronAPI?.platform,' +
    'directoryApi:typeof window.electronAPI?.selectDirectory, loginApi:typeof window.electronAPI?.login,' +
    'loginPage:!!document.querySelector(".login-page"), runtime:typeof window.process})')
  assert.equal(identity.loginPage, true, 'Run this check on the logged-out development app')
  assert.equal(identity.loginApi, 'function')
  assert.equal(identity.directoryApi, 'function')
  assert.equal(identity.runtime, 'undefined')
  evidence.identity = identity
  const mainAttached = json(await call('attach', { debugPort: mainPort, name: 'sep-client-main-inspector' }))
  mainProcessId = mainAttached.id
  const mainIdentity = json(await call('evaluate_main', { processId: mainProcessId,
    expression: 'process.getBuiltinModule("module").createRequire(process.cwd()+"/package.json")("electron").app.getAppPath()' }))
  assert.equal(mainIdentity.result.result.value, PROJECT_ROOT, 'Inspector must belong to this repository')
  evidence.mainInspector = { port: mainPort, appPath: mainIdentity.result.result.value }
  assert.equal((await evaluate('window.electronAPI.setWindowTheme("light")')).success, true)
  evidence.checks.push('real-app-original-preload-and-main-ipc')
  await screenshot('01-login.png')
  evidence.checks.push('mcp-image-content-png')

  const checkbox = '.login-remember-option input'
  originalRemember = await evaluate('document.querySelector("' + checkbox + '").checked')
  await call('click', { targetId, selector: checkbox })
  assert.equal(await evaluate('document.querySelector("' + checkbox + '").checked'), !originalRemember)
  await call('click', { targetId, selector: checkbox })
  assert.equal(await evaluate('document.querySelector("' + checkbox + '").checked'), originalRemember)
  evidence.checks.push('real-react-checkbox-click-and-restore')

  if (await evaluate('!!document.querySelector("[aria-label=\\"选择历史账号\\"]")')) {
    await call('click', { targetId, selector: '[aria-label="选择历史账号"]' })
    await call('wait_for', { targetId, selector: '[role="listbox"]', timeoutMs: 5000 })
    await screenshot('02-account-popup.png')
    await call('press_key', { targetId, key: 'Escape', selector: '#login-email' })
    await call('wait_for', { targetId, hidden: '[role="listbox"]', timeoutMs: 5000 })
    evidence.checks.push('actual-account-popup-open-and-dismiss')
  }
  await call('handle_dialog', { targetId, action: 'dismiss' })
  assert.equal(await evaluate('window.confirm("Electron MCP development verification")'), false)
  await call('handle_dialog', { targetId, clear: true })
  evidence.checks.push('javascript-confirm-dismiss')

  // A harmless custom property exercises a real content change through Vite HMR.
  const cssBefore = await readFile(cssPath)
  const token = 'sep_mcp_hmr_' + Date.now()
  hmrRule = '\n/* ' + token + ' */\n:root { --sep-mcp-hmr-probe: ' + token + '; }\n'
  const before = await evaluate('(async () => {' +
    'window.__sepMcpProbe = {token:' + JSON.stringify(token) + ',updates:[]};' +
    'const hot = (await import("/@vite/client")).createHotContext("/__sep_mcp_probe");' +
    'hot.on("vite:afterUpdate", payload => window.__sepMcpProbe?.updates.push(...payload.updates));' +
    'return performance.timeOrigin; })()')
  await writeFile(cssPath, Buffer.concat([cssBefore, Buffer.from(hmrRule)]))
  await until(async () => await evaluate('window.__sepMcpProbe?.updates.some(update =>' +
    'update.path.includes("index.css")) && getComputedStyle(document.documentElement)' +
    '.getPropertyValue("--sep-mcp-hmr-probe").trim() === ' + JSON.stringify(token)), 'Vite CSS HMR did not arrive')
  assert.equal(await evaluate('window.__sepMcpProbe.token'), token)
  assert.equal(await evaluate('performance.timeOrigin'), before, 'CSS HMR must preserve the document')
  assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--sep-mcp-hmr-probe").trim()'), token)
  await call('click', { targetId, selector: checkbox })
  assert.equal(await evaluate('document.querySelector("' + checkbox + '").checked'), !originalRemember)
  await call('click', { targetId, selector: checkbox })
  await screenshot('03-after-css-hmr.png')
  const cssCurrent = await readFile(cssPath, 'utf8')
  assert.equal(cssCurrent.split(hmrRule).length, 2)
  await writeFile(cssPath, cssCurrent.replace(hmrRule, ''))
  hmrRule = undefined
  await until(async () => await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--sep-mcp-hmr-probe").trim()') === '', 'HMR restore did not arrive')
  assert.deepEqual(await readFile(cssPath), cssBefore, 'Stylesheet content must be restored')
  evidence.hmr = { updates: await evaluate('window.__sepMcpProbe.updates'),
    sameDocument: true, sourceContentUnchanged: true }
  evidence.checks.push('actual-vite-css-hmr-same-document-and-mcp-click')

  await call('reload', { targetId })
  await until(async () => {
    try { return await evaluate('!!document.querySelector(".login-page") && typeof window.electronAPI?.setWindowTheme === "function"') }
    catch { return false }
  }, 'Renderer did not recover after reload')
  assert.equal((await evaluate('window.electronAPI.setWindowTheme("light")')).success, true)
  await screenshot('04-after-reload.png')
  evidence.checks.push('full-renderer-reload-mcp-and-real-ipc-recovered')
  await call('stop_app')
  processId = undefined
  const reattached = json(await call('attach', { debugPort: port, name: 'sep-client-reattach-check' }))
  processId = reattached.id
  assert.ok(reattached.targets.some(item => item.id === targetId))
  await screenshot('05-after-reattach.png')
  evidence.checks.push('mcp-detach-reattach-preserves-app')
  evidence.nativeDialog = 'CDP handle_dialog covers JavaScript dialogs, not OS file pickers.'
  evidence.passed = true
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  if (hmrRule) {
    const current = await readFile(cssPath, 'utf8')
    if (current.includes(hmrRule)) await writeFile(cssPath, current.replace(hmrRule, ''))
  }
  if (processId) {
    try {
      if (originalRemember !== undefined && await evaluate('!!document.querySelector(".login-remember-option input")') &&
        await evaluate('document.querySelector(".login-remember-option input").checked') !== originalRemember) {
        await call('click', { targetId, selector: '.login-remember-option input' })
      }
      await evaluate('delete window.__sepMcpProbe')
      await call('handle_dialog', { targetId, clear: true })
      await call('stop_app')
    } catch (error) { evidence.cleanupError = error.message; evidence.passed = false }
  }
  if (mainProcessId) {
    try { await call('stop_app', { processId: mainProcessId }) }
    catch (error) { evidence.cleanupError = error.message; evidence.passed = false }
  }
  await client.close()
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks, output, failure: evidence.failure?.message }, null, 2))
  if (!evidence.passed) process.exitCode = 1
}
