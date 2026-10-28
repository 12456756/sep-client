import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpRuntime } from './pi-mcp-client'
import { prepareCommonSkills } from './common-skills'
import { attachOfficeRuntime, officeMcpServer, withOfficeFileLock, withOfficeFileLocks } from './pi-office-runtime'
import { OFFICE_TOOL_NAME } from './pi-office-policy'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import { buildExtensions } from './pi-coding-agent-adapter'
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import { applicationResourcesDirectory } from '../../data/application-resources'
import * as officeManifest from '../../../resources/office/manifest.json'

describe('built-in Office runtime', () => {
  it('closes an interrupted Office process before allowing another command', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sep-office-abort-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'package.json'), '{"type":"commonjs"}')
    await writeFile(join(root, 'mcp'), `
      const fs = require('node:fs');
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => {
        const m = JSON.parse(line); if (m.id === undefined) return;
        if (m.method === 'tools/call') { fs.writeFileSync('started', 'yes'); return; }
        const result = m.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'office', version: '1' } }
          : { tools: [{ name: 'officecli', inputSchema: { type: 'object' } }] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
      rl.on('close', () => fs.writeFileSync('closed', 'yes'));
    `)
    const base = await createMcpRuntime([], root)
    const attached = await attachOfficeRuntime(base, { skills: [], unavailable: [],
      office: { executable: process.execPath, sha256: '' } }, {
      runId: 'abort-office', modelId: 'm', gatewayUrl: '', workspaceDir: root, agentDir: root, sessionDir: root,
      getAccessToken: async () => '', authorizeTool: async () => true,
      toolPolicy: { allowedTools: ['read', 'write'], allowedPaths: [root], deniedPaths: [],
        workspaceDir: root, commandPolicy: 'disabled', approvalMode: 'auto-approve' },
    })
    t.after(() => attached.runtime.dispose())
    assert.equal(attached.enabled, true)
    const office = attached.runtime.tools.find(tool => tool.name === OFFICE_TOOL_NAME)!
    const controller = new AbortController()
    const pending = office.execute('abort', { command: ['create', 'test.docx'] }, controller.signal)
    for (let attempt = 0; !existsSync(join(root, 'started')); attempt++) {
      assert.ok(attempt < 100, 'Office call did not start')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    controller.abort()
    const result = await pending
    assert.equal(result.details.isError, true)
    assert.ok(existsSync(join(root, 'closed')), 'Office must close before the file lock is released')
    assert.match(result.content.map(item => item.text).join('\n'), /verify|check/i)
    const next = await office.execute('next', { command: ['get', 'test.docx'] }, undefined)
    assert.equal(next.details.isError, true)
    assert.match(next.content[0].text, /closed/i)
  })
  it('cancels a queued file operation without releasing another worker write', async () => {
    let release!: () => void
    const hold = new Promise<void>(done => { release = done })
    let firstStarted!: () => void
    const started = new Promise<void>(done => { firstStarted = done })
    const events: string[] = []
    const first = withOfficeFileLock('test-same-file', undefined, async () => {
      events.push('first'); firstStarted(); await hold; events.push('first-done')
    })
    await started
    const controller = new AbortController()
    const second = withOfficeFileLock('test-same-file', controller.signal, async () => { events.push('second') })
    const rejected = assert.rejects(second, /cancel/)
    controller.abort(new Error('cancel'))
    await rejected
    const third = withOfficeFileLock('test-same-file', undefined, async () => { events.push('third') })
    await withOfficeFileLock('another-file', undefined, async () => { events.push('independent') })
    assert.deepEqual(events, ['first', 'independent'])
    release()
    await Promise.all([first, third])
    assert.deepEqual(events, ['first', 'independent', 'first-done', 'third'])
  })
  it('serializes overlapping multi-file operations and keeps unrelated files parallel', async () => {
    let release!: () => void
    const hold = new Promise<void>(done => { release = done })
    const events: string[] = []
    const first = withOfficeFileLocks(['source.docx', 'render.html'], undefined, async () => {
      events.push('first'); await hold; events.push('first-done')
    })
    await new Promise(resolve => setImmediate(resolve))
    const overlap = withOfficeFileLocks(['other.docx', 'render.html'], undefined, async () => { events.push('overlap') })
    const independent = withOfficeFileLocks(['unrelated.docx'], undefined, async () => { events.push('independent') })
    await independent
    assert.deepEqual(events, ['first', 'independent'])
    release()
    await Promise.all([first, overlap])
    assert.deepEqual(events, ['first', 'independent', 'first-done', 'overlap'])
  })
  it('acquires multiple locks in sorted order without deadlock', async () => {
    const events: string[] = []
    await Promise.all([
      withOfficeFileLocks(['b.docx', 'a.docx'], undefined, async () => { events.push('first') }),
      withOfficeFileLocks(['a.docx', 'b.docx'], undefined, async () => { events.push('second') }),
    ])
    assert.equal(events.length, 2)
  })
  it('releases a cancelled partial lock set without releasing another worker lock', async () => {
    let release!: () => void
    const hold = new Promise<void>(done => { release = done })
    const events: string[] = []
    const first = withOfficeFileLocks(['cancel-b'], undefined, async () => {
      events.push('first'); await hold; events.push('first-done')
    })
    await new Promise(resolve => setImmediate(resolve))
    const controller = new AbortController()
    const pending = withOfficeFileLocks(['cancel-b', 'cancel-a'], controller.signal, async () => { events.push('cancelled') })
    const rejected = assert.rejects(pending, /cancel/)
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('cancel'))
    await rejected
    const third = withOfficeFileLocks(['cancel-b'], undefined, async () => { events.push('third') })
    await withOfficeFileLocks(['cancel-a'], undefined, async () => { events.push('released-a') })
    assert.deepEqual(events, ['first', 'released-a'])
    release()
    await Promise.all([first, third])
    assert.deepEqual(events, ['first', 'released-a', 'first-done', 'third'])
  })
  it('does not execute an already cancelled command without file paths', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancel'))
    let executed = false
    await assert.rejects(withOfficeFileLocks([], controller.signal, async () => { executed = true }), /cancel/)
    assert.equal(executed, false)
  })
  it('locks an output shared by otherwise distinct Office commands', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sep-office-locks-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'package.json'), '{"type":"commonjs"}')
    await writeFile(join(root, 'mcp'), `
      const fs = require('node:fs');
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => { const m = JSON.parse(line); if (m.id === undefined) return;
        if (m.method === 'initialize') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'office',version:'1'}}})+'\\n');
        if (m.method === 'tools/list') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'officecli',inputSchema:{type:'object'}}]}})+'\\n');
        const command = m.params.arguments.command; fs.appendFileSync('calls', 'start:' + command[1] + '\\n');
        setTimeout(() => { fs.appendFileSync('calls', 'end:' + command[1] + '\\n');
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'ok'}]}})+'\\n'); }, 30);
      });
    `)
    const base = await createMcpRuntime([], root)
    const attached = await attachOfficeRuntime(base, { skills: [], unavailable: [], office: { executable: process.execPath, sha256: '' } }, {
      runId: 'lock-office', modelId: 'm', gatewayUrl: '', workspaceDir: root, agentDir: root, sessionDir: root,
      getAccessToken: async () => '', authorizeTool: async () => true,
      toolPolicy: { allowedTools: ['read', 'write'], allowedPaths: [root], deniedPaths: [], workspaceDir: root,
        commandPolicy: 'disabled', approvalMode: 'auto-approve' },
    })
    t.after(() => attached.runtime.dispose())
    const office = attached.runtime.tools.find(tool => tool.name === OFFICE_TOOL_NAME)!
    for (const command of [
      ['view', 'second.docx', 'html', '--out', 'same.html'],
      ['get', 'same.html'],
    ]) {
      await writeFile(join(root, 'calls'), '')
      const first = office.execute('first', { command: ['view', 'first.docx', 'html', '--out', 'same.html'] }, undefined)
      const second = office.execute('second', { command }, undefined)
      const results = await Promise.all([first, second])
      for (const result of results) assert.equal(result.details.isError, false)
      const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n')
      assert.equal(calls.length, 4)
      assert.match(calls[0], /^start:/)
      assert.match(calls[1], /^end:/)
      assert.match(calls[2], /^start:/)
      assert.match(calls[3], /^end:/)
    }
  })
  it('keeps existing tools available if optional Office startup fails', async () => {
    const base = await createMcpRuntime([], process.cwd())
    const result = await attachOfficeRuntime(base, { skills: [], unavailable: [],
      office: { executable: join(process.cwd(), 'missing-office-binary.exe'), sha256: '' } }, {
      runId: 'failed-office', modelId: 'm', gatewayUrl: '', workspaceDir: process.cwd(), agentDir: '', sessionDir: '',
      getAccessToken: async () => '', authorizeTool: async () => false,
    })
    assert.equal(result.enabled, false)
    assert.equal(result.runtime, base)
    await base.dispose()
  })
  it('pins runtime flags without auto-approval or resident workers', () => {
    const config = officeMcpServer('/trusted/officecli')
    assert.deepEqual(config.autoApproveTools, [])
    assert.equal(config.transport.type, 'stdio')
    if (config.transport.type === 'stdio') {
      assert.equal(config.transport.env?.OFFICECLI_SKIP_UPDATE, '1')
      assert.equal(config.transport.env?.OFFICECLI_NO_AUTO_RESIDENT, '1')
    }
  })
  it('checks Office commands before unrestricted MCP bypass and asks approval for edits only', async () => {
    let approved = 0
    const config: PiAgentSessionConfig = { runId: 'test', modelId: 'm', gatewayUrl: '', workspaceDir: process.cwd(),
      agentDir: '', sessionDir: '', getAccessToken: async () => '', authorizeTool: async () => { approved++; return false },
      toolPolicy: { preset: 'workspace-edit', allowedTools: ['read', 'write'], allowedPaths: [process.cwd()],
        deniedPaths: [], workspaceDir: process.cwd(), commandPolicy: 'disabled', approvalMode: 'confirm-each' } }
    const runtime = { builtinOffice: true as const, tools: [], permissions: new Map([[OFFICE_TOOL_NAME, 'confirm-each' as const]]), dispose: async () => {} }
    const handlers: Array<(event: ToolCallEvent) => Promise<ToolCallEventResult>> = []
    const api = { on: (name: string, handler: unknown) => {
      if (name === 'tool_call') handlers.push(handler as typeof handlers[number])
    }, registerTool: () => {}, getActiveTools: () => [OFFICE_TOOL_NAME] } as unknown as ExtensionAPI
    for (const extension of buildExtensions(config, runtime)) await extension(api)
    const invoke = (command: string[]) => handlers[0]({ type: 'tool_call', toolCallId: 'test', toolName: OFFICE_TOOL_NAME, input: { command } })
    assert.equal((await invoke(['get', 'a.docx'])).block, false)
    assert.equal(approved, 0)
    assert.equal((await invoke(['create', 'a.docx'])).block, true)
    assert.equal(approved, 1)
    config.toolPolicy = { ...config.toolPolicy!, preset: 'full-local', approvalMode: 'auto-approve' }
    assert.equal((await invoke(['create', 'a.docx'])).block, false)
    assert.equal((await invoke(['install'])).block, true)
  })

  it('creates, edits, saves and reopens real docx/xlsx/pptx through MCP', { timeout: 120_000 }, async t => {
    const asset = officeManifest.assets[`${process.platform}-${process.arch}` as keyof typeof officeManifest.assets]
    if (!asset || !existsSync(join(applicationResourcesDirectory(), 'office', asset.file))) {
      t.skip('Run npm run office:prepare to enable real binary integration checks.'); return
    }
    const common = prepareCommonSkills()
    assert.ok(common.office, common.unavailable.join('; '))
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sep-office-real-')))
    const base = await createMcpRuntime([], root)
    const attached = await attachOfficeRuntime(base, common, { runId: 'office-test', modelId: 'm', gatewayUrl: '',
      workspaceDir: root, agentDir: root, sessionDir: root, getAccessToken: async () => '', authorizeTool: async () => true,
      toolPolicy: { preset: 'workspace-edit', allowedTools: ['read', 'write', 'edit'], allowedPaths: [root],
        deniedPaths: [], workspaceDir: root, commandPolicy: 'disabled', approvalMode: 'auto-approve' } })
    t.after(async () => { await attached.runtime.dispose(); await rm(root, { recursive: true, force: true }) })
    assert.equal(attached.enabled, true)
    const tool = attached.runtime.tools.find(tool => tool.name === OFFICE_TOOL_NAME)!
    const call = async (command: string[]) => {
      const result = await tool.execute('test', { command }, undefined)
      assert.equal(result.details.isError, false, result.content.map(item => item.text).join('\n'))
      return result.content.map(item => item.text).join('\n')
    }
    for (const extension of ['docx', 'xlsx', 'pptx']) {
      const path = join(root, `report.${extension}`)
      await call(['create', path])
      if (extension === 'docx') await call(['batch', path, '--commands', JSON.stringify([
        { command: 'add', parent: '/body', type: 'paragraph', props: { text: 'Office smoke 123' } },
      ])])
      if (extension === 'xlsx') await call(['set', path, '/Sheet1/A1', '--prop', 'value=Office smoke 123'])
      if (extension === 'pptx') {
        await call(['add', path, '/', '--type', 'slide', '--prop', 'title=Office smoke 123'])
      }
      await call(['save', path]); await call(['close', path])
      const text = await call(['view', path, 'text'])
      assert.match(text, /Office smoke 123/)
      assert.deepEqual((await readFile(path)).subarray(0, 2), Buffer.from('PK'))
      await call(['validate', path, '--json'])
    }
    const denied = await tool.execute('denied', { command: ['create', '../outside.docx'] }, undefined)
    assert.equal(denied.details.isError, true)
    await attached.runtime.dispose()
  })
})
