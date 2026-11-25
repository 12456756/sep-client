import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateOfficeCommand } from './pi-office-policy'
import type { ToolPolicy } from '../../../pi-extension/guard'

describe('Office command policy', () => {
  async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sep-office-policy-')))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const policy: ToolPolicy = { preset: 'workspace-edit', allowedTools: ['read', 'write', 'edit'],
      allowedPaths: [workspace], deniedPaths: [], workspaceDir: workspace,
      approvalMode: 'auto-approve', commandPolicy: 'disabled' }
    return { root, workspace, policy }
  }
  it('authorizes a DOCX read and a new DOC write without allowing overwrite or path escape', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    const command = { command: ['export-doc', 'article.docx', 'article.doc'] }
    const approved = evaluateOfficeCommand(command, { ...f.policy, approvalMode: 'confirm-each' })
    assert.equal(approved.allowed, true)
    assert.equal(approved.requiresApproval, true)
    assert.deepEqual(approved.lockPaths, [join(f.workspace, 'article.docx'), join(f.workspace, 'article.doc')])
    assert.equal(evaluateOfficeCommand(command, { ...f.policy, preset: 'read-only' }).allowed, false)
    for (const paths of [['../article.docx', 'article.doc'], ['article.docx', '../article.doc'],
      ['article.docx', 'article.docx'], ['article.docm', 'article.doc'], ['article.docx', 'name:stream.doc'],
      ['article.docx', 'article.doc', '--force']]) {
      assert.equal(evaluateOfficeCommand({ command: ['export-doc', ...paths] }, f.policy).allowed, false)
    }
    await writeFile(join(f.workspace, 'article.doc'), 'keep')
    assert.match(evaluateOfficeCommand(command, f.policy).reason ?? '', /already exists/)
  })
  it('normalizes string and array commands without executing a shell', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    const decision = evaluateOfficeCommand({ command: 'get "report one.docx" /body --json' }, f.policy)
    assert.equal(decision.allowed, true)
    assert.deepEqual(decision.args, ['get', join(f.workspace, 'report one.docx'), '/body', '--json'])
    assert.deepEqual(decision.lockPaths, [join(f.workspace, 'report one.docx')])
    assert.equal(evaluateOfficeCommand({ command: ['help', 'docx', 'paragraph'] }, f.policy).allowed, true)
    assert.equal(evaluateOfficeCommand({ command: ['set', 'a.docx', '/body', '--prop', 'text=Hello'] }, f.policy).allowed, true)
  })
  it('requires confirmation for import even in auto-approve and accepts only an authorized extensionless attachment', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    const source = join(f.root, 'source')
    await writeFile(source, 'attachment')
    const command = { command: ['import-doc', source, 'working.docx'] }
    assert.equal(evaluateOfficeCommand(command, f.policy).allowed, false)
    const approved = evaluateOfficeCommand(command, { ...f.policy, readableAttachmentPaths: [source] })
    assert.equal(approved.allowed, true)
    assert.equal(approved.requiresApproval, true)
    assert.deepEqual(approved.args, ['import-doc', source, join(f.workspace, 'working.docx')])
    assert.equal(evaluateOfficeCommand({ command: ['import-doc', '../source', '../working.docx'] },
      { ...f.policy, readableAttachmentPaths: [source] }).allowed, false)
  })
  it('explains why OfficeCLI cannot use an attachment original identifier', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    const command = { command: ['get', '@original/att-stale', '/', '--json'] }
    const decision = evaluateOfficeCommand(command, { ...f.policy, fileAccess: 'local' })
    assert.equal(decision.allowed, false)
    assert.match(decision.reason ?? '', /OfficeCLI cannot use attachment original identifiers/)
    assert.deepEqual(decision.lockPaths, [])
  })
  it('blocks writes in read-only runs and respects approval settings', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    const readOnly = { ...f.policy, preset: 'read-only' as const, allowedTools: ['read'] }
    assert.equal(evaluateOfficeCommand({ command: ['create', 'a.xlsx'] }, readOnly).allowed, false)
    assert.equal(evaluateOfficeCommand({ command: ['view', 'a.xlsx', 'text'] }, readOnly).allowed, true)
    assert.equal(evaluateOfficeCommand({ command: ['set', 'a.docx', '/body', '--prop', 'text=x'] },
      { ...f.policy, approvalMode: 'confirm-each' }).requiresApproval, true)
  })
  it('returns both primary and output paths for runtime locking', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    const decision = evaluateOfficeCommand({ command: ['view', 'source.docx', 'html', '--out', 'render.html', '-o', 'render.html'] }, f.policy)
    assert.equal(decision.allowed, true)
    assert.deepEqual(decision.lockPaths, [join(f.workspace, 'source.docx'), join(f.workspace, 'render.html')])
  })
  it('checks traversal, symlinks, output paths and embedded resource paths', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    for (const command of [ ['get', '../secret.docx'], ['view', 'a.docx', 'html', '-o', '../a.html'],
      ['add', 'a.pptx', '/', '--type', 'picture', '--prop', 'path=../secret.png'],
      ['set', 'a.xlsx', '/Sheet1/A1', '--prop', 'formula=WEBSERVICE("https://example.com")'],
      ['batch', 'a.docx', '--commands', '[{"command":"add","parent":"/body","type":"picture","props":{"path":"../a.png"}}]'] ]) {
      assert.equal(evaluateOfficeCommand({ command }, f.policy).allowed, false, JSON.stringify(command))
    }
    await writeFile(join(f.root, 'secret.docx'), 'secret')
    await symlink(f.root, join(f.workspace, 'linked'), 'junction')
    assert.equal(evaluateOfficeCommand({ command: ['get', 'linked/secret.docx'] }, f.policy).allowed, false)
  })
  it('supports checked inline batches but rejects opaque inputs and administrative commands', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    assert.equal(evaluateOfficeCommand({ command: ['batch', 'a.docx', '--commands',
      JSON.stringify([{ command: 'add', parent: '/body', type: 'paragraph', props: { text: 'Hello' } }])] }, f.policy).allowed, true)
    for (const command of [['install'], ['plugins', 'install', 'a'], ['mcp'], ['watch', 'a.docx'],
      ['batch', 'a.docx', '--input', 'commands.json'], ['get', 'a.docx', '--unexpected', '../file'],
      ['raw-set', 'a.docx', '/document', '--xml', '<unsafe/>']]) {
      assert.equal(evaluateOfficeCommand({ command }, f.policy).allowed, false, JSON.stringify(command))
    }
  })
  it('permits approved dependency reads, never writes to dependency snapshots', async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
    const dependency = join(f.root, 'dependency.docx')
    await writeFile(dependency, 'doc')
    const policy = { ...f.policy, readableDeliveryPaths: [dependency] }
    assert.equal(evaluateOfficeCommand({ command: ['get', dependency] }, policy).allowed, true)
    assert.equal(evaluateOfficeCommand({ command: ['set', dependency, '/body', '--prop', 'text=x'] }, policy).allowed, false)
  })
})
