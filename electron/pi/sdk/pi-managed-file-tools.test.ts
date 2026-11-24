import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { runtimeFileToolPolicy } from '../../runtime/file-tool-policy'
import { managedFileTools } from './pi-managed-file-tools'
import { managedReadTools } from './pi-managed-read-tools'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import { selectedAttachmentOriginal } from '../../data/attachment-original'

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
