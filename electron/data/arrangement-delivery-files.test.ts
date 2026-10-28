import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, open } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8, unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { validateDeliveryFiles, revalidateDeliveryFiles, resolveDeliveryFiles } from './arrangement-delivery-files'
import type { ArrangementNode } from '../domain/arrangement-plan'
import { applicationResourcesDirectory } from './application-resources'
import * as officeManifest from '../../resources/office/manifest.json'

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
  it('does not approve media mappings or typed media through the ordinary workspace validator', async () => {
    const f = await fixture('png')
    await writeFile(f.file, 'A filename and an asset ID do not prove a valid image')
    for (const artifact of [
      { kind: 'image' as const, source: 'media-output' as const },
      { kind: 'image' as const, source: 'workspace' as const },
      { kind: 'video' as const, source: 'either' as const },
      undefined,
    ]) {
      const mediaNode: ArrangementNode = { ...f.node, deliverables: [{ ...f.node.deliverables![0]!, artifact }] }
      const submitted = { ...f.submission, mediaDeliverables: [{ deliverableId: 'report', artifactId: 'asset_abc-123' }] }
      const result = await validateDeliveryFiles(f.root, mediaNode, submitted, 'run')
      assert.ok(!result.ok)
      assert.equal(result.issues[0]?.code, 'MEDIA_DELIVERY_NOT_READY')
      if (artifact) {
        const unmapped = await validateDeliveryFiles(f.root, mediaNode, f.submission, 'run')
        assert.ok(!unmapped.ok)
        assert.equal(unmapped.issues[0]?.code, 'MEDIA_DELIVERY_NOT_READY')
      }
    }
  })

  it('never replaces a media source receipt with changed workspace bytes during recovery', async () => {
    const f = await fixture()
    await writeFile(f.file, 'Original findings')
    const accepted = await validateDeliveryFiles(f.root, f.node, f.submission, 'run')
    assert.ok(accepted.ok)
    const mediaFile = { ...accepted.files[0]!, sourceArtifact: { kind: 'image' as const, artifactId: 'asset_abc-123', sha256: accepted.files[0]!.sha256 } }
    await writeFile(f.file, 'Changed findings')
    const result = await resolveDeliveryFiles(f.root, [mediaFile], undefined, { allowWorkspaceChanges: true })
    assert.equal(result.files.length, 0)
    assert.equal(result.issues[0]?.code, 'PREDECESSOR_FILE_CHANGED')
  })

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
    it(`resolves ${format} content type declarations with Override precedence over Default`, async () => {
      const f = await fixture(format)
      const main = format === 'docx' ? 'word/document.xml' : format === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'
      const type = format === 'docx' ? 'wordprocessingml.document' : format === 'xlsx' ? 'spreadsheetml.sheet' : 'presentationml.presentation'
      const mime = `application/vnd.openxmlformats-officedocument.${type}.main+xml`
      const defaultType = `<Default Extension="xml" ContentType="${mime}"/>`
      const overrideType = `<Override PartName="/${main}" ContentType="${mime}"/>`
      const cases = [
        { name: 'default only', declarations: defaultType, accepted: true },
        { name: 'case insensitive default extension', declarations: `<Default Extension="XML" ContentType="${mime}"/>`, accepted: true },
        { name: 'unrelated override does not hide default', declarations: `<Override PartName="/other.xml" ContentType="application/xml"/>${defaultType}`, accepted: true },
        { name: 'override replaces generic default', declarations: `<Default Extension="xml" ContentType="application/xml"/>${overrideType}`, accepted: true },
        { name: 'matching default and override', declarations: `${defaultType}${overrideType}`, accepted: true },
        { name: 'wrong override cannot fall back to default', declarations: `${defaultType}<Override PartName="/${main}" ContentType="application/xml"/>`, accepted: false },
        { name: 'missing override type cannot fall back to default', declarations: `${defaultType}<Override PartName="/${main}"/>`, accepted: false },
        { name: 'missing declarations', declarations: '', accepted: false },
        { name: 'wrong extension', declarations: `<Default Extension="rels" ContentType="${mime}"/>`, accepted: false },
        { name: 'wrong default type', declarations: '<Default Extension="xml" ContentType="application/xml"/>', accepted: false },
        { name: 'missing default type', declarations: '<Default Extension="xml"/>', accepted: false },
        { name: 'unknown declaration is not a mapping', declarations: `<Fallback Extension="xml" ContentType="${mime}"/>`, accepted: false },
      ]
      for (const example of cases) {
        const files = unzipSync(officePackage(format))
        files['[Content_Types].xml'] = strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${example.declarations}</Types>`)
        await writeFile(f.file, zipSync(files))
        const result = await validateDeliveryFiles(f.root, f.node, f.submission, 'run')
        assert.equal(result.ok, example.accepted, example.name)
        if (!result.ok) assert.equal(result.issues[0]?.code, 'INVALID_FORMAT', example.name)
        else assert.deepEqual(await revalidateDeliveryFiles(f.root, result.files), [], example.name)
      }
    })

    it(`accepts prefixed XML declarations and Strict relationships for ${format}`, async () => {
      const f = await fixture(format)
      const main = format === 'docx' ? 'word/document.xml' : format === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'
      const type = format === 'docx' ? 'wordprocessingml.document' : format === 'xlsx' ? 'spreadsheetml.sheet' : 'presentationml.presentation'
      const files = unzipSync(officePackage(format))
      files['[Content_Types].xml'] = strToU8(`\uFEFF<?xml version="1.0" encoding="UTF-8"?><ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types"><ct:Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></ct:Types>`)
      files['_rels/.rels'] = strToU8(`<?xml version="1.0"?><r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="/${main}"/></r:Relationships>`)
      await writeFile(f.file, zipSync(files))
      assert.equal((await validateDeliveryFiles(f.root, f.node, f.submission, 'run')).ok, true)
    })

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

  it('accepts real OfficeCLI docx/xlsx/pptx deliveries and their archived snapshots', { timeout: 120_000 }, async t => {
    const asset = officeManifest.assets[`${process.platform}-${process.arch}` as keyof typeof officeManifest.assets]
    const binary = asset && join(applicationResourcesDirectory(), 'office', asset.file)
    if (!binary || !existsSync(binary)) {
      t.skip('Run npm run office:prepare to enable real binary integration checks.'); return
    }
    const call = (args: string[]) => execFileSync(binary, args, { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_RESIDENT_FLUSH: 'each' } })
    for (const format of ['docx', 'xlsx', 'pptx'] as const) {
      const f = await fixture(format)
      call(['create', f.file])
      if (format === 'docx') call(['add', f.file, '/body', '--type', 'paragraph', '--prop', 'text=Delivery validation regression'])
      if (format === 'xlsx') call(['set', f.file, '/Sheet1/A1', '--prop', 'value=Delivery validation regression'])
      if (format === 'pptx') call(['add', f.file, '/', '--type', 'slide', '--prop', 'title=Delivery validation regression'])
      call(['save', f.file]); call(['close', f.file])
      assert.deepEqual(JSON.parse(call(['validate', f.file, '--json'])), { success: true, data: { count: 0, errors: [] } })
      const options = { taskDirectory: join(f.root, 'task-data') }
      const result = await validateDeliveryFiles(f.root, f.node, f.submission, 'run', undefined, options)
      assert.ok(result.ok, `${format}: ${JSON.stringify(result)}`)
      assert.deepEqual(await revalidateDeliveryFiles(f.root, result.files, undefined, options), [])
    }
  })
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
