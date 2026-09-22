import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpRuntime } from './pi-mcp-client'
import { createPlaywrightMcpServer, loadHostMcpServers, unpackedCliPath } from './pi-playwright-mcp'

describe('bundled Playwright MCP', () => {
  it('uses the bundled CLI, isolated Edge, text snapshots and explicit approvals on Windows', () => {
    const server = createPlaywrightMcpServer('win32')
    assert.equal(server.name, 'playwright')
    assert.equal(server.transport.type, 'stdio')
    if (server.transport.type !== 'stdio') return
    assert.equal(server.transport.command, process.execPath)
    assert.ok(server.transport.args?.[0]?.endsWith('cli.js'))
    assert.ok(server.transport.args?.includes('msedge'))
    assert.ok(server.transport.args?.includes('--isolated'))
    assert.ok(server.transport.args?.includes('--image-responses'))
    assert.ok(server.transport.args?.includes('omit'))
    assert.ok(!server.transport.args?.includes('--no-sandbox'))
    assert.ok(!server.transport.args?.includes('--allow-unrestricted-file-access'))
    assert.deepEqual(server.autoApproveTools, [])
    assert.ok(server.enabledTools?.includes('browser_snapshot'))
    for (const name of ['browser_evaluate', 'browser_run_code', 'browser_file_upload', 'browser_take_screenshot', 'browser_install']) {
      assert.ok(!server.enabledTools?.includes(name))
    }
  })

  it('uses Chrome outside Windows and resolves unpacked CLI paths without shell quoting', () => {
    const server = createPlaywrightMcpServer('linux')
    assert.ok(server.transport.type === 'stdio' && server.transport.args?.includes('chrome'))
    assert.equal(unpackedCliPath('C:\\Program Files\\SEP\\app.asar\\node_modules\\cli.js'),
      'C:\\Program Files\\SEP\\app.asar.unpacked\\node_modules\\cli.js')
    assert.equal(unpackedCliPath('/opt/SEP/app.asar/node_modules/cli.js'), '/opt/SEP/app.asar.unpacked/node_modules/cli.js')
    assert.equal(unpackedCliPath('/repo/cli.js'), '/repo/cli.js')
  })

  it('enables the preset by default; explicit host configuration and disable flag take precedence', async () => {
    assert.equal((await loadHostMcpServers({}))[0]?.name, 'playwright')
    assert.deepEqual(await loadHostMcpServers({ SEP_PLAYWRIGHT_MCP: '0' }), [])
    const root = await mkdtemp(join(tmpdir(), 'sep-playwright-config-'))
    try {
      const path = join(root, 'mcp.json')
      await writeFile(path, '{"servers":[]}')
      assert.deepEqual(await loadHostMcpServers({ SEP_MCP_CONFIG: path }), [])
      await writeFile(path, '{"servers":[{"name":"broken"}]}')
      await assert.rejects(loadHostMcpServers({ SEP_MCP_CONFIG: path }), /MCP configuration/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discovers every allowlisted tool from the real pinned server using the Electron Node runtime', async () => {
    const server = createPlaywrightMcpServer()
    // Exercise Electron 33 / Node 20, not just the developer machine's Node.
    const electronPath = createRequire(import.meta.url)('electron') as string
    assert.equal(server.transport.type, 'stdio')
    if (server.transport.type !== 'stdio') return
    const bridge = await createMcpRuntime([{ ...server, transport: { ...server.transport, command: electronPath } }], process.cwd())
    try {
      assert.deepEqual(bridge.tools.map(tool => tool.name).sort(), server.enabledTools!.map(name => `mcp__playwright__${name}`).sort())
      for (const permission of bridge.permissions.values()) assert.equal(permission, 'confirm-each')
    } finally {
      await bridge.dispose()
    }
  })

  it('ships the pinned server and its CLI dependencies outside asar', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    assert.equal(pkg.dependencies['@playwright/mcp'], '0.0.82')
    assert.ok(pkg.build.asarUnpack.includes('node_modules/@playwright/mcp/**/*'))
    assert.ok(pkg.build.asarUnpack.includes('node_modules/playwright/**/*'))
    assert.ok(pkg.build.asarUnpack.includes('node_modules/playwright-core/**/*'))
  })
})
