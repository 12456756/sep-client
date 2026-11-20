import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { AttachmentStore } from '../../data/attachment-store'
import { writeWordCopy } from '../../data/document-preview-store'
import { extractAttachment } from '../../runtime/attachment-extractor'
import { convertDocumentPreview } from '../../runtime/document-preview-converter'
import { AttachmentService } from '../../service/attachment-service'
import { prepareCommonSkills } from './common-skills'
import { createMcpRuntime } from './pi-mcp-client'
import { OFFICE_TOOL_NAME } from './pi-office-policy'
import { attachOfficeRuntime } from './pi-office-runtime'
import { exportLegacyWord, importLegacyWord } from './pi-word-export'

async function fixture(t: TestContext, parts: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'csep-test-word-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.docx'), destination = join(root, 'delivery.doc')
  const bytes = zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word export test &#x4E2D;&#x6587;</w:t></w:r></w:p></w:body></w:document>',
    ...parts,
  }).map(([name, content]) => [name, strToU8(content)])))
  await writeFile(source, bytes)
  return { root, source, destination, bytes }
}

// A format marker for publication tests; only the opt-in Word test performs real conversion.
const fakeBinary = Buffer.alloc(512)
fakeBinary.write('d0cf11e0a1b11ae1', 0, 'hex')
fakeBinary.write('WordDocument\0', 32, 'utf16le')
const binaryConverter = (root: string) => writeFile(join(root, 'output.doc'), fakeBinary)

it('publishes a validated staged file, preserving both the source and an existing destination', async t => {
  const f = await fixture(t)
  const checkDestination = () => {}
  await exportLegacyWord(f.source, f.destination, checkDestination, undefined, binaryConverter)
  assert.deepEqual(await readFile(f.destination), fakeBinary)
  assert.deepEqual(await readFile(f.source), Buffer.from(f.bytes))
  await writeFile(f.destination, 'existing')
  await assert.rejects(exportLegacyWord(f.source, f.destination, checkDestination, undefined, binaryConverter), { code: 'EEXIST' })
  assert.equal(await readFile(f.destination, 'utf8'), 'existing')
})

it('never publishes a non-binary result, a cancelled export, or a changed destination', async t => {
  const f = await fixture(t)
  await assert.rejects(exportLegacyWord(f.source, f.destination, () => {}, undefined,
    root => writeFile(join(root, 'output.doc'), '{\rtf1 not a Word binary}')), /did not produce/)
  const controller = new AbortController()
  await assert.rejects(exportLegacyWord(f.source, f.destination, () => {}, controller.signal, async root => {
    await binaryConverter(root)
    controller.abort(new Error('cancelled'))
  }), /cancelled/)
  await assert.rejects(exportLegacyWord(f.source, f.destination, () => { throw new Error('destination changed') },
    undefined, binaryConverter), /destination changed/)
  await assert.rejects(readFile(f.destination), { code: 'ENOENT' })
})

it('rejects DOCX with external links, embedded content or fields before invoking Word', async t => {
  const samples: Array<Record<string, string>> = [
    { 'word/_rels/document.xml.rels': '<Relationships><Relationship Type="hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>' },
    { 'word/_rels/document.xml.rels': '<Relationships><Relationship Type="image" Target="//server/share"/></Relationships>' },
    { 'word/vbaProject.bin': 'macros' },
    { 'word/document.xml': '<w:document xmlns:w="urn:word"><w:instrText>DDEAUTO payload</w:instrText></w:document>' },
  ]
  for (const parts of samples) {
    const f = await fixture(t, parts)
    await assert.rejects(exportLegacyWord(f.source, f.destination, () => {}, undefined,
      () => { assert.fail('must not invoke Word') }), /without external links, fields, macros or embedded objects/)
    await assert.rejects(readFile(f.destination), { code: 'ENOENT' })
  }
})

it('imports only a legacy Word source and publishes a working copy without changing attachment bytes', async t => {
  const f = await fixture(t)
  const attachment = join(f.root, 'source')
  const working = join(f.root, 'working.docx')
  const convert = async (root: string, _signal?: AbortSignal, importing?: boolean) => {
    assert.equal(importing, true)
    assert.deepEqual(await readFile(join(root, 'input.doc')), fakeBinary)
    await writeFile(join(root, 'output.docx'), f.bytes)
  }
  await writeFile(attachment, f.bytes)
  await assert.rejects(importLegacyWord(attachment, working, () => {}, undefined, convert), /trusted Word/)
  await writeFile(attachment, fakeBinary)
  await assert.rejects(importLegacyWord(attachment, working, () => {}, undefined,
    root => writeFile(join(root, 'output.docx'), 'not DOCX')), /working copy/)
  const abort = new AbortController()
  await assert.rejects(importLegacyWord(attachment, working, () => {}, abort.signal, async (...args) => {
    await convert(...args)
    abort.abort(new Error('cancelled'))
  }), /cancelled/)
  await assert.rejects(readFile(working), { code: 'ENOENT' })
  await importLegacyWord(attachment, working, () => {}, undefined, convert)
  assert.deepEqual(await readFile(working), Buffer.from(f.bytes))
  assert.deepEqual(await readFile(attachment), fakeBinary)
})

it('round-trips Chinese text through real Word export, attachment extraction, preview, import and re-export', {
  skip: process.platform !== 'win32' || process.env.SEP_TEST_WORD_EXPORT !== '1', timeout: 195_000,
}, async t => {
  const f = await fixture(t)
  await exportLegacyWord(f.source, f.destination, () => {})
  const bytes = await readFile(f.destination)
  assert.ok(bytes.length > 512)
  assert.equal(bytes.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1')
  assert.ok(bytes.includes(Buffer.from('WordDocument\0', 'utf16le')))
  const expected = 'Word export test \u4e2d\u6587'
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const store = new AttachmentStore(join(f.root, 'storage'), undefined, extractAttachment)
  const attachments = new AttachmentService(store, () => owner)
  const session = await attachments.beginSession({ kind: 'conversation', taskId: 'task' })
  const [imported] = await attachments.importFiles(session.sessionId, 'import-doc', [f.destination])
  assert.equal(imported.item.mediaType, 'application/msword')
  const ref = { attachmentId: imported.item.attachmentId, sha256: imported.item.sha256 }
  await attachments.claimTask(session.sessionId, 'task', [ref])
  const resolved = await attachments.resolveTaskInputs(owner, 'task', [ref])
  const [source] = resolved.attachments
  assert.ok(source.extractedText?.includes(expected))
  assert.ok(source.readPath)
  const uploaded = await attachments.readTaskDocument('task', ref.attachmentId, ref.sha256)
  assert.deepEqual(Buffer.from(uploaded.bytes), bytes)
  const preview = await convertDocumentPreview(uploaded.format, uploaded.bytes)
  assert.equal(preview.kind, 'html')
  assert.ok(preview.sections[0].html.includes(expected))
  const working = join(f.root, 'working.docx')
  const delivery = join(f.root, 'edited.doc')
  const common = prepareCommonSkills()
  assert.ok(common.office, 'Run npm run office:prepare before running the real Word round trip.')
  const base = await createMcpRuntime([], f.root)
  const attached = await attachOfficeRuntime(base, common, { runId: 'word-test', modelId: 'm', gatewayUrl: '',
    workspaceDir: f.root, agentDir: f.root, sessionDir: f.root, getAccessToken: async () => '', authorizeTool: async () => true,
    toolPolicy: { preset: 'workspace-edit', allowedTools: ['read', 'write', 'edit'], allowedPaths: [f.root], deniedPaths: [],
      workspaceDir: f.root, commandPolicy: 'disabled', approvalMode: 'confirm-each', readableAttachmentPaths: [source.readPath] } })
  const tool = attached.runtime.tools.find(item => item.name === OFFICE_TOOL_NAME)
  try {
    assert.ok(tool)
    const call = async (command: string[]) => {
      const result = await tool.execute('word-test', { command }, undefined)
      assert.equal(result.details.isError, false, result.content.map(item => item.text).join('\n'))
    }
    await call(['import-doc', source.readPath, working])
    await call(['batch', working, '--commands', JSON.stringify([
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: 'Word edited result \u4e2d\u6587' } },
    ])])
    await call(['save', working]); await call(['close', working])
    await call(['export-doc', working, delivery])
  } finally { await attached.runtime.dispose() }
  const editedBytes = await readFile(delivery)
  assert.ok((await extractAttachment('application/msword', editedBytes)).text?.includes('Word edited result \u4e2d\u6587'))
  const saved = join(f.root, 'saved.doc')
  await writeWordCopy(saved, editedBytes, 'doc')
  await assert.rejects(writeWordCopy(saved, bytes, 'doc'))
  assert.deepEqual(await readFile(saved), editedBytes)
  assert.deepEqual(await readFile(source.readPath), bytes)
})
