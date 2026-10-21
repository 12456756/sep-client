import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, open } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { validateDeliveryFiles, revalidateDeliveryFiles, resolveDeliveryFiles } from './arrangement-delivery-files'
import type { ArrangementNode } from '../domain/arrangement-plan'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(format = 'txt') {
  const root = await mkdtemp(join(tmpdir(), 'sep-delivery-'))
  roots.push(root)
  await mkdir(join(root, 'deliverables'))
  const node: ArrangementNode = { id: 'a', subscriptionId: 'sub', modelId: 'model', title: 'Report', instruction: 'Write report', expectedOutput: 'File', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
    deliverables: [{ id: 'report', name: 'Report', format, path: `deliverables/report.${format}`, contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }] }
  const submission = { nodeId: 'a', summary: 'Done', finalDeliverables: [{ id: 'report', path: node.deliverables![0]!.path }] }
  return { root, node, submission, file: join(root, submission.finalDeliverables[0]!.path) }
}

function officePackage(format: 'docx' | 'xlsx' | 'pptx'): Uint8Array {
  const main = format === 'docx' ? 'word/document.xml' : format === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'
  const type = format === 'docx' ? 'wordprocessingml.document' : format === 'xlsx' ? 'spreadsheetml.sheet' : 'presentationml.presentation'
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`),
    '_rels/.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`),
  }
  if (format === 'docx') files[main] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p></w:body></w:document>')
  if (format === 'xlsx') {
    files[main] = strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Findings" sheetId="1"/></sheets></workbook>')
    files['xl/worksheets/sheet1.xml'] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>')
  }
  if (format === 'pptx') {
    files[main] = strToU8('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256"/></p:sldIdLst></p:presentation>')
    files['ppt/slides/slide1.xml'] = strToU8('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>')
  }
  return zipSync(files)
}

describe('final delivery file validation', () => {
  it('freezes accepted bytes outside the workspace and uses them after the visible file changes or disappears', async () => {
    const f = await fixture()
    const taskDirectory = await mkdtemp(join(tmpdir(), 'sep-delivery-data-'))
    roots.push(taskDirectory)
    await writeFile(f.file, 'Original findings')
    const result = await validateDeliveryFiles(f.root, f.node, f.submission, 'run-a', undefined, { taskDirectory })
    assert.ok(result.ok)
    assert.equal(result.files[0]!.snapshot?.source, 'confirmed')
    for (const removed of [false, true]) {
      if (removed) await rm(f.file)
      else await writeFile(f.file, 'Re-saved workspace file')
      const resolved = await resolveDeliveryFiles(f.root, result.files, undefined, { taskDirectory, allowWorkspaceChanges: true })
      assert.deepEqual(resolved.issues, [])
      assert.equal(await readFile(resolved.readPaths[0]!, 'utf8'), 'Original findings')
      assert.ok(!resolved.readPaths[0]!.startsWith(f.root))
      assert.deepEqual(resolved.files, result.files)
    }
  })

  it('recovers a legacy Office file with changed bytes while preserving its original receipt and recording the new version', async () => {
    const f = await fixture('xlsx')
    await writeFile(f.file, officePackage('xlsx'))
    const original = await validateDeliveryFiles(f.root, f.node, f.submission, 'old-run')
    assert.ok(original.ok)
    const files = original.files
    const entries = { ...Object.fromEntries(Object.entries((await import('fflate')).unzipSync(await readFile(f.file)))),
      'docProps/core.xml': strToU8('<properties><modified>updated</modified></properties>') }
    await writeFile(f.file, zipSync(entries))
    const taskDirectory = join(f.root, 'task-data')
    const recovered = await resolveDeliveryFiles(f.root, files, undefined, { taskDirectory, allowWorkspaceChanges: true })
    assert.deepEqual(recovered.issues, [])
    assert.equal(recovered.warnings[0]?.code, 'LEGACY_DELIVERY_UPDATED')
    assert.equal(recovered.files[0]!.sha256, files[0]!.sha256)
    assert.equal(recovered.files[0]!.snapshot?.source, 'workspace-recovery')
    assert.notEqual(recovered.files[0]!.snapshot?.sha256, files[0]!.sha256)
    assert.equal(files[0]!.snapshot, undefined, 'must not mutate the existing checkpoint')
    await writeFile(f.file, 'now corrupt')
    const retried = await resolveDeliveryFiles(f.root, recovered.files, undefined, { taskDirectory, allowWorkspaceChanges: true })
    assert.deepEqual(retried.issues, [])
    assert.deepEqual(retried.files, recovered.files)
    assert.deepEqual(await readFile(retried.readPaths[0]!), await readFile(recovered.readPaths[0]!))
  })

  it('never falls back to a changed working file when a registered snapshot is corrupt or missing', async () => {
    const f = await fixture()
    const taskDirectory = join(f.root, 'task-data')
    await writeFile(f.file, 'Original')
    const accepted = await validateDeliveryFiles(f.root, f.node, f.submission, 'run', undefined, { taskDirectory })
    assert.ok(accepted.ok)
    const resolved = await resolveDeliveryFiles(f.root, accepted.files, undefined, { taskDirectory })
    await writeFile(resolved.readPaths[0]!, 'corrupt snapshot')
    assert.ok((await resolveDeliveryFiles(f.root, accepted.files, undefined, { taskDirectory, allowWorkspaceChanges: true })).issues.length)
    await rm(resolved.readPaths[0]!)
    assert.ok((await resolveDeliveryFiles(f.root, accepted.files, undefined, { taskDirectory, allowWorkspaceChanges: true })).issues.length)
  })

  it('still rejects missing, empty, corrupt Office and unsafe legacy files in compatibility mode', async () => {
    const f = await fixture('xlsx')
    await writeFile(f.file, officePackage('xlsx'))
    const accepted = await validateDeliveryFiles(f.root, f.node, f.submission, 'run')
    assert.ok(accepted.ok)
    for (const content of ['', 'not an Excel file']) {
      await writeFile(f.file, content)
      assert.ok((await resolveDeliveryFiles(f.root, accepted.files, undefined, { taskDirectory: join(f.root, 'data'), allowWorkspaceChanges: true })).issues.length)
    }
    await rm(f.file)
    assert.ok((await resolveDeliveryFiles(f.root, accepted.files, undefined, { allowWorkspaceChanges: true })).issues.length)
    await assert.rejects(resolveDeliveryFiles(f.root, accepted.files, AbortSignal.abort(), { allowWorkspaceChanges: true }), { name: 'AbortError' })
  })

  it('registers real final files and detects later mutation or removal', async () => {
    const f = await fixture()
    await writeFile(f.file, 'Findings: market opportunity')
    const result = await validateDeliveryFiles(f.root, f.node, f.submission, 'run-a')
    assert.ok(result.ok)
    assert.equal(result.files[0]!.nodeRunId, 'run-a')
    assert.match(result.files[0]!.sha256, /^[a-f0-9]{64}$/)
    assert.equal((await revalidateDeliveryFiles(f.root, result.files)).length, 0)
    await writeFile(f.file, 'changed')
    assert.ok((await revalidateDeliveryFiles(f.root, result.files)).length > 0)
    await rm(f.file)
    assert.ok((await revalidateDeliveryFiles(f.root, result.files)).length > 0)
  })
  it('rejects missing, empty, directory and symlink-escaped files', async () => {
    const f = await fixture()
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
    await writeFile(f.file, '')
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
    await rm(f.file)
    await mkdir(f.file)
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
    await rm(f.file, { recursive: true })
    const outside = await mkdtemp(join(tmpdir(), 'sep-delivery-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'report.txt'), 'outside')
    await rm(join(f.root, 'deliverables'), { recursive: true })
    await symlink(outside, join(f.root, 'deliverables'), 'junction')
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
  })
  it('rejects named pipes without waiting for a writer', async t => {
    if (process.platform === 'win32') return t.skip('Named pipes require POSIX')
    const f = await fixture()
    execFileSync('mkfifo', [f.file])
    const validation = validateDeliveryFiles(f.root, f.node, f.submission, 'run')
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      validation,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_000) }),
    ])
    clearTimeout(timer)
    if (result === null) {
      // Release a blocked reader so a regression cannot hang the test process.
      const writer = await open(f.file, constants.O_WRONLY | constants.O_NONBLOCK)
      await writer.close()
      await validation
    }
    assert.notEqual(result, null, 'Validation blocked opening a FIFO')
    assert.ok(result && !result.ok)
    assert.equal(result.issues[0]?.code, 'NOT_A_FILE')
  })
  it('checks Office structure instead of trusting a docx extension', async () => {
    const f = await fixture('docx')
    await writeFile(f.file, 'not a Word file')
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
    await writeFile(f.file, officePackage('docx'))
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, true)
    await writeFile(f.file, zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<broken>') }))
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
  })
  for (const format of ['docx', 'xlsx', 'pptx'] as const) {
    it(`rejects an incomplete ${format} package and accepts its basic document structure`, async () => {
      const f = await fixture(format)
      await writeFile(f.file, officePackage(format))
      assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, true)
      const main = format === 'docx' ? 'word/document.xml' : format === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'
      const root = format === 'docx' ? 'w:document' : format === 'xlsx' ? 'workbook' : 'p:presentation'
      await writeFile(f.file, zipSync({ '[Content_Types].xml': strToU8('<Types/>'), [main]: strToU8(`<${root}/>`),
        'xl/worksheets/sheet1.xml': strToU8('<worksheet/>'), 'ppt/slides/slide1.xml': strToU8('<p:sld/>') }))
      assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
    })
  }
  it('supports cancellation and rejects oversized files and invalid JSON', async () => {
    const f = await fixture('json')
    await writeFile(f.file, '{not-json}')
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
    await writeFile(f.file, '{"findings":["opportunity"]}')
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, true)
    await assert.rejects(validateDeliveryFiles(f.root, f.node, f.submission, 'run', AbortSignal.abort()), { name: 'AbortError' })
    await writeFile(f.file, Buffer.alloc(64 * 1024 * 1024 + 1))
    const result = await validateDeliveryFiles(f.root, f.node, f.submission, 'run')
    assert.ok(!result.ok)
    assert.equal(result.issues[0]?.code, 'FILE_TOO_LARGE')
  })
  it('rejects fake PDFs and accepts a parsable PDF with a page', async () => {
    const f = await fixture('pdf')
    await writeFile(f.file, '%PDF fake')
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, false)
    const pdf = await PDFDocument.create()
    pdf.addPage()
    await writeFile(f.file, await pdf.save())
    assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, true)
  })
})
