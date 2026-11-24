import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { runtimeFileToolPolicy } from '../../runtime/file-tool-policy'
import { managedFileTools } from './pi-managed-file-tools'
import { managedReadTools } from './pi-managed-read-tools'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import { selectedAttachmentOriginal } from '../../data/attachment-original'
import { evaluateToolCall } from '../../../pi-extension/guard'

async function fixture(t: TestContext) {
  const tmp = await mkdtemp(join(tmpdir(), 'csep-managed-file-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const root = await realpath(tmp)
  const workspaceDir = await mkdtemp(join(root, 'work-'))
  const config: PiAgentSessionConfig = {
    runId: 'run', modelId: 'model', gatewayUrl: '', agentDir: root, sessionDir: root, workspaceDir,
    getAccessToken: async () => '', authorizeTool: async () => false, toolPolicy: runtimeFileToolPolicy(undefined, workspaceDir),
  }
  return { root, workspaceDir, config }
}

function write(config: PiAgentSessionConfig) {
  const [tool] = managedFileTools(config)
  return (path: string, content: string, signal?: AbortSignal) => tool.execute('call', { path, content }, signal, undefined, {} as never)
}

test('a new file at an explicit external destination requires confirmation and never falls back or overwrites', async t => {
  const { root, workspaceDir, config } = await fixture(t)
  config.toolPolicy = { ...config.toolPolicy!, allowExternalSaveAs: true }
  const desktop = join(root, 'Desktop')
  await mkdir(desktop)
  const path = join(desktop, '未完成工作.txt')
  assert.equal(evaluateToolCall('write', { path }, config.toolPolicy).allowed, true)
  await assert.rejects(write(config)(path, 'denied'), /Save As was not confirmed/)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await assert.rejects(readFile(join(workspaceDir, '未完成工作.txt')), { code: 'ENOENT' })

  const controller = new AbortController()
  const withApproval = (authorizeTool: PiAgentSessionConfig['authorizeTool']) => write({ ...config, authorizeTool })
  const confirm = (request: Parameters<PiAgentSessionConfig['authorizeTool']>[0]) => {
    assert.deepEqual(request, { toolName: 'file_save_as', input: { path } })
  }
  await assert.rejects(withApproval(async request => { confirm(request); controller.abort(); return true })(path, 'cancelled', controller.signal), { name: 'AbortError' })
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  const result = await withApproval(async request => { confirm(request); return true })(path, 'saved')
  assert.deepEqual(result.content, [{ type: 'text', text: `File saved: ${path}` }])
  assert.equal(await readFile(path, 'utf8'), 'saved')

  const raced = join(desktop, 'race.txt')
  await assert.rejects(withApproval(async request => {
    assert.deepEqual(request, { toolName: 'file_save_as', input: { path: raced } })
    await writeFile(raced, 'manual content')
    return true
  })(raced, 'attempt to replace'), { code: 'EEXIST' })
  assert.equal(await readFile(raced, 'utf8'), 'manual content')
  for (const policy of [{ ...config.toolPolicy, preset: 'read-only' as const }, { ...config.toolPolicy, unattended: true }, { ...config.toolPolicy, deniedPaths: [desktop] }]) {
    const denied = join(desktop, 'blocked.txt')
    assert.equal(evaluateToolCall('write', { path: denied }, policy).allowed, false)
    await assert.rejects(write({ ...config, toolPolicy: policy, authorizeTool: async () => assert.fail('unexpected approval') })(denied, 'blocked'), /access denied/)
    await assert.rejects(readFile(denied), { code: 'ENOENT' })
  }
  const nonConversation = join(desktop, 'no-conversation.txt')
  config.toolPolicy = { ...config.toolPolicy, allowExternalSaveAs: false }
  const needsOriginal = withApproval(async request => { assert.equal(request.toolName, 'file_select_original'); return false })
  await assert.rejects(needsOriginal(nonConversation, 'blocked'), /original file was not selected/)
  await assert.rejects(readFile(nonConversation), { code: 'ENOENT' })
  config.toolPolicy = { ...config.toolPolicy, allowExternalSaveAs: true }
  const granted = join(desktop, 'granted.txt')
  await write({ ...config, toolPolicy: { ...config.toolPolicy, fileAccess: 'local' }, authorizeTool: async () => assert.fail('unexpected approval') })(granted, 'local grant')
  assert.equal(await readFile(granted, 'utf8'), 'local grant')
})

test('a new file can be created and revised in the same run without approving a pre-existing file', async t => {
  const { workspaceDir, config } = await fixture(t)
  const save = write(config)
  await save('new.txt', 'first')
  await save('new.txt', 'second')
  await assert.rejects(write(config)('new.txt', 'later run'), /not approved/)
  assert.equal(await readFile(join(workspaceDir, 'new.txt'), 'utf8'), 'second')
})

test('an external original requires file selection and approval of the exact proposed contents', async t => {
  const { root, config } = await fixture(t)
  const path = join(root, 'original.md')
  await writeFile(path, 'before')
  const approvals: Parameters<PiAgentSessionConfig['authorizeTool']>[0][] = []
  await write({ ...config, authorizeTool: async request => { approvals.push(request); return true } })(path, 'after')
  assert.deepEqual(approvals, [
    { toolName: 'file_select_original', input: { path } },
    { toolName: 'file_edit_once', input: { path, before: 'before', after: 'after' } },
  ])
  assert.equal(await readFile(path, 'utf8'), 'after')
})

test('an expired, cancelled or stale file approval does not write', async t => {
  const { workspaceDir, config } = await fixture(t)
  const path = join(workspaceDir, 'original.txt')
  await writeFile(path, 'before')
  await assert.rejects(write(config)(path, 'expired'), /not approved/)
  const controller = new AbortController()
  await assert.rejects(write({ ...config, authorizeTool: async () => { controller.abort(); return true } })(path, 'cancelled', controller.signal), { name: 'AbortError' })
  assert.equal(await readFile(path, 'utf8'), 'before')
  await assert.rejects(write({ ...config, authorizeTool: async () => { await writeFile(path, 'manual edit'); return true } })(path, 'stale'), /File changed/)
  assert.equal(await readFile(path, 'utf8'), 'manual edit')
})

test('a bound original skips the picker but does not skip change approval or accept a replacement', async t => {
  const { root, config } = await fixture(t)
  const path = join(root, 'selected.md')
  await writeFile(path, 'before')
  const binding = (await selectedAttachmentOriginal(path))!
  const permissions = { ...config.toolPolicy!, originalFiles: new Map([['@original/attachment', binding]]) }
  const calls: string[] = []
  const save = write({ ...config, toolPolicy: permissions, authorizeTool: async request => { calls.push(request.toolName); return true } })
  await save('@original/attachment', 'after')
  assert.deepEqual(calls, ['file_edit_once'])
  assert.equal(await readFile(path, 'utf8'), 'after')
  await assert.rejects(save('@original/attachment', 'stale identity'), /original changed/)
})

test('managed recursive search omits protected matches', async t => {
  const { workspaceDir, config } = await fixture(t)
  await writeFile(join(workspaceDir, '.env'), 'test-token hidden')
  await writeFile(join(workspaceDir, 'visible.txt'), 'test-token visible')
  const grep = managedReadTools(config).find(tool => tool.name === 'grep')!
  const result = await grep.execute('call', { pattern: 'test-token' } as never, undefined, undefined, {} as never)
  assert.match(JSON.stringify(result.content), /visible\.txt/)
  assert.doesNotMatch(JSON.stringify(result.content), /hidden|\.env/)
})
