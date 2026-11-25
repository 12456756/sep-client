import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { ORIGINAL_DOCUMENT_REPLACE_TOOL, RUN_PYTHON_TOOL } from '../../../src/shared/python-tool'
import { externalResultReceiptSchema } from '../../../src/shared/result-files'
import type { TaskReadView } from '../../../src/shared/types'
import { selectedAttachmentOriginal } from '../../data/attachment-original'
import { resolveConversationResult } from '../../data/conversation-result-file'
import { runtimeAttachmentReadScope, runtimeFileToolPolicy } from '../../runtime/file-tool-policy'
import { bundledPythonExecutable, PYTHON_FILE_LIMIT } from '../../runtime/python-runtime'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import { pythonTool } from './pi-python-tool'

const alias = '@original/document'
const formats = {
  xlsx: ['xl/workbook.xml', 'workbook', 'spreadsheetml.sheet', 'xl/worksheets/sheet1.xml', 'worksheet'],
  docx: ['word/document.xml', 'document', 'wordprocessingml.document', 'word/document.xml', 'document'],
  pptx: ['ppt/presentation.xml', 'presentation', 'presentationml.presentation', 'ppt/slides/slide1.xml', 'sld'],
} as const

function packageFixture(format: keyof typeof formats, value = 'before') {
  const [main, root, type, edited, editedRoot] = formats[format]
  const ns = `http://schemas.openxmlformats.org/${type.split('.')[0]}/2006/main`
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`),
    '_rels/.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`),
    [main]: strToU8(`<${root} xmlns="${ns}"/>`),
    [edited]: strToU8(`<${editedRoot} xmlns="${ns}"><t>${value}</t></${editedRoot}>`),
    'other-part.xml': strToU8('<unchanged/>'),
  }, { mtime: new Date(2020, 0, 1) }))
}

function pdfFixture() {
  const content = 'q 0 0 10 10 re S Q\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}endstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset.toString().padStart(10, '0') + ' 00000 n \n'
  })
  const xref = pdf.length
  return Buffer.from(`${pdf}xref\n0 5\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

async function fixture(t: TestContext, extension = 'xlsx', source = packageFixture('xlsx')) {
  const tmp = await mkdtemp(join(tmpdir(), 'csep-document-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const root = await realpath(tmp), workspaceDir = join(root, 'workspace')
  const original = join(root, 'original.' + extension)
  await mkdir(workspaceDir)
  await writeFile(original, source)
  const binding = await selectedAttachmentOriginal(original)
  assert.ok(binding)
  const config: PiAgentSessionConfig = { runId: 'run', modelId: 'model', gatewayUrl: '', agentDir: root, sessionDir: root,
    workspaceDir, getAccessToken: async () => '', authorizeTool: async () => true,
    toolPolicy: { ...runtimeFileToolPolicy(undefined, workspaceDir), originalFiles: new Map([[alias, binding]]) } }
  return { root, original, config }
}

async function addSourceAttachment(config: PiAgentSessionConfig, path: string, name: string, bytes: Buffer) {
  await writeFile(path, bytes)
  Object.assign(config.toolPolicy!, runtimeAttachmentReadScope([{
    attachmentId: 'source', sha256: '', displayName: name, mediaType: '', byteLength: bytes.length,
    readPath: path, extractionStatus: 'complete',
  }]))
}

const request = (extension = 'xlsx') => ({ purpose: 'Edit the selected document only', code: 'pass',
  replaceOriginal: { name: `document.${extension}`, path: alias } })
const output = (binaryFile: Buffer, exitCode = 0) => ({ status: 'finished' as const, exitCode,
  stdout: '', stderr: '', truncated: false, files: new Map<string, string>(), binaryFile })
const invoke = (tool: ReturnType<typeof pythonTool>, input: Parameters<ReturnType<typeof pythonTool>['execute']>[1], signal?: AbortSignal) =>
  tool.execute('test', input, signal, undefined, {} as never)

test('structured replacement needs its own approval even with full local access, and denial leaves no files', async t => {
  const { root, original, config } = await fixture(t)
  config.toolPolicy!.fileAccess = 'local'
  const calls: string[] = []
  config.authorizeTool = async approval => {
    calls.push(approval.toolName)
    if (approval.toolName === ORIGINAL_DOCUMENT_REPLACE_TOOL) {
      assert.equal((approval.input as { path: string }).path, original)
      assert.deepEqual(await readFile(original), packageFixture('xlsx'))
      return false
    }
    return true
  }
  await assert.rejects(invoke(pythonTool(config, '', async () => output(packageFixture('xlsx', 'edited'))), request()), /not approved/)
  assert.deepEqual(calls, [RUN_PYTHON_TOOL, ORIGINAL_DOCUMENT_REPLACE_TOOL])
  assert.deepEqual((await readdir(root)).sort(), ['original.xlsx', 'workspace'])
  assert.deepEqual(await readFile(original), packageFixture('xlsx'))
})

test('rejects arbitrary paths, read-only/scheduled calls, bad formats and failed sandbox results', async t => {
  const { original, config } = await fixture(t)
  const different = packageFixture('docx', 'wrong format')
  const failed = pythonTool(config, '', async () => output(different, 1))
  const changed = pythonTool(config, '', async () => output(different))
  assert.equal((await invoke(failed, request())).details.isError, true)
  await assert.rejects(invoke(changed, request()), /does not match/)
  await assert.rejects(invoke(changed, { ...request(), replaceOriginal: { ...request().replaceOriginal, path: original } }), /Select or drop/)
  for (const policy of [{ ...config.toolPolicy!, unattended: true }, { ...config.toolPolicy!, preset: 'read-only' as const }]) {
    const tool = pythonTool({ ...config, toolPolicy: policy }, '', async () => assert.fail('unexpected execution'))
    assert.ok(!('replaceOriginal' in tool.parameters.properties))
    await assert.rejects(invoke(tool, request()), /denied by task policy/)
  }
  assert.deepEqual(await readFile(original), packageFixture('xlsx'))
})

test('rejects cancellation and changes to the original while replacement approval is open', async t => {
  const { root, original, config } = await fixture(t)
  const edited = packageFixture('xlsx', 'AI edit')
  const concurrent = packageFixture('xlsx', 'manual edit')
  const controller = new AbortController()
  config.authorizeTool = async approval => {
    if (approval.toolName === ORIGINAL_DOCUMENT_REPLACE_TOOL) controller.abort()
    return true
  }
  await assert.rejects(invoke(pythonTool(config, '', async () => output(edited)), request(), controller.signal), { name: 'AbortError' })
  config.authorizeTool = async approval => {
    if (approval.toolName === ORIGINAL_DOCUMENT_REPLACE_TOOL) await writeFile(original, concurrent)
    return true
  }
  await assert.rejects(invoke(pythonTool(config, '', async () => output(edited)), request()), /document changed/)
  assert.deepEqual(await readFile(original), concurrent)
  assert.deepEqual((await readdir(root)).sort(), ['original.xlsx', 'workspace'])
})

test('registers the replaced original as an openable result and keeps only the backup in the workspace', async t => {
  const source = packageFixture('xlsx')
  const edited = Buffer.from(zipSync({ ...unzipSync(packageFixture('xlsx', 'edited')), 'padding.bin': Buffer.alloc(150 * 1024) }, { level: 0 }))
  const { root, original, config } = await fixture(t, 'xlsx', source)
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const task: TaskReadView = { id: 'task', title: 'Copy cells', prompt: 'Copy cells', workDir: config.workspaceDir,
    status: 'running', createdAt: 1, startedAt: 1, completedAt: null, error: null, logs: [], files: [],
    ownerId: owner.memberId, ownerEnterpriseId: owner.enterpriseId, subscriptionId: 'sub', activeRunId: 'run',
    workType: { state: 'resolved', kind: 'conversation' } }
  let backup: string | undefined
  config.authorizeTool = async approval => {
    if (approval.toolName === ORIGINAL_DOCUMENT_REPLACE_TOOL) {
      backup = (approval.input as { backup: string }).backup
      assert.ok(backup.startsWith(join(config.workspaceDir, '原件备份') + (process.platform === 'win32' ? '\\' : '/')))
      assert.deepEqual(await readFile(original), source)
      assert.deepEqual(task.files, [])
    }
    return true
  }
  config.registerWrittenFile = async (path, receipt) => {
    assert.equal(path, original)
    assert.deepEqual(await readFile(path), edited)
    task.files.push(path)
    task.externalFileReceipts = { [path]: externalResultReceiptSchema.parse(receipt) }
  }
  const result = await invoke(pythonTool(config, '', async () => output(edited)), request())
  assert.equal(result.details.isError, false)
  assert.ok(backup)
  assert.deepEqual(await readFile(backup), source)
  assert.deepEqual((await readdir(root)).sort(), ['original.xlsx', 'workspace'])
  assert.deepEqual(task.files, [original])
  const registered = await resolveConversationResult(owner, task, 'task-file-0')
  assert.ok(registered?.external)
  assert.deepEqual(registered.bytes, edited)
})

test('does not write the original or register a result if the backup directory becomes a link', async t => {
  const source = packageFixture('xlsx')
  const { root, original, config } = await fixture(t, 'xlsx', source)
  const outside = join(root, 'outside')
  await mkdir(outside)
  config.authorizeTool = async approval => {
    if (approval.toolName === ORIGINAL_DOCUMENT_REPLACE_TOOL) {
      await symlink(outside, join(config.workspaceDir, '原件备份'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    return true
  }
  config.registerWrittenFile = async () => assert.fail('an unsuccessful replacement must not be registered')
  const tool = pythonTool(config, '', async () => output(packageFixture('xlsx', 'edited')))
  await assert.rejects(invoke(tool, request()), /workspace backup location is unavailable/)
  assert.deepEqual(await readFile(original), source)
  assert.deepEqual(await readdir(outside), [])
})

test('a stale original identifier cannot be used to read or replace a document', async t => {
  const { config } = await fixture(t)
  config.toolPolicy!.originalFiles = undefined
  config.authorizeTool = async () => assert.fail('stale identifiers must not trigger an approval')
  const tool = pythonTool(config, '', async () => assert.fail('unexpected execution'))
  assert.ok(!('replaceOriginal' in tool.parameters.properties))
  await assert.rejects(invoke(tool, request()), /Reselect or drop the target original/)
  await assert.rejects(invoke(tool, { purpose: 'Read attachment', code: 'pass', inputs: [{ path: alias, name: 'source.xlsx' }] }), /readOnlyPath/)
})

for (const extension of ['xlsx', 'docx', 'pptx', 'pdf'] as const) {
  test(`bundled Python replaces a bound ${extension} via a validated sandbox output and keeps the old bytes`,
    { skip: !process.env.SEP_PYTHON_DEV_RESOURCES }, async t => {
      const native = bundledPythonExecutable()
      assert.ok(native)
      const source = extension === 'pdf' ? pdfFixture() : packageFixture(extension)
      const { original, config } = await fixture(t, extension, source)
      let backup: string | undefined
      config.authorizeTool = async approval => {
        if (approval.toolName === ORIGINAL_DOCUMENT_REPLACE_TOOL) {
          assert.deepEqual(await readFile(original), source)
          backup = (approval.input as { backup: string }).backup
        }
        return true
      }
      const filename = `document.${extension}`
      const code = extension === 'pdf' ? `from pathlib import Path
p = Path('inputs/${filename}').read_bytes()
Path('outputs/${filename}').write_bytes(p.replace(b'10 10 re', b'20 20 re'))` : `from zipfile import ZipFile
part = '${formats[extension][3]}'
with ZipFile('inputs/${filename}') as source, ZipFile('outputs/${filename}', 'w') as result:
  for name in source.namelist():
    data = source.read(name)
    result.writestr(name, data.replace(b'before', b'edited') if name == part else data)`
      const result = await invoke(pythonTool(config, native), { ...request(extension), code })
      assert.equal(result.details.isError, false, JSON.stringify(result.content))
      assert.ok(backup)
      assert.deepEqual(await readFile(backup), source)
      const saved = await readFile(original)
      if (extension === 'pdf') assert.match(saved.toString('ascii'), /20 20 re/)
      else {
        const parts = unzipSync(saved)
        assert.match(strFromU8(parts[formats[extension][3]]), /edited/)
        assert.equal(strFromU8(parts['other-part.xml']), '<unchanged/>')
      }
      await assert.rejects(invoke(pythonTool(config, native), { ...request(extension), code }), /original changed/)
    })
}

test('clears Sheet1 in an actual workbook without rewriting the styles or the other sheet',
  { skip: !process.env.SEP_PYTHON_DEV_RESOURCES }, async t => {
    const native = bundledPythonExecutable()
    assert.ok(native)
    const ExcelJS = createRequire(import.meta.url)('exceljs/dist/exceljs.min.js') as typeof import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const first = workbook.addWorksheet('Sheet1')
    first.getCell('A1').value = 'discard this'
    first.getCell('A1').font = { bold: true }
    first.getCell('A2').value = { formula: '1+2', result: 3 }
    workbook.addWorksheet('Sheet2').getCell('A1').value = 'retain this'
    const originalBytes = Buffer.from(await workbook.xlsx.writeBuffer())
    const { config, original } = await fixture(t, 'xlsx', originalBytes)
    const code = `from zipfile import ZipFile
from xml.etree import ElementTree as ET
sheet = 'xl/worksheets/sheet1.xml'
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('', ns)
with ZipFile('inputs/document.xlsx') as source, ZipFile('outputs/document.xlsx', 'w') as dest:
  for name in source.namelist():
    data = source.read(name)
    if name == sheet:
      root = ET.fromstring(data)
      for cell in root.iter(f'{{{ns}}}c'):
        cell.attrib.pop('t', None)
        for child in list(cell):
          if child.tag in [f'{{{ns}}}v', f'{{{ns}}}f', f'{{{ns}}}is']:
            cell.remove(child)
      data = ET.tostring(root, encoding='utf-8')
    dest.writestr(name, data)`
    const result = await invoke(pythonTool(config, native), { ...request(), code })
    assert.equal(result.details.isError, false, JSON.stringify(result.content))
    const saved = await readFile(original)
    const after = unzipSync(saved), before = unzipSync(originalBytes)
    for (const part of ['xl/styles.xml', 'xl/worksheets/sheet2.xml']) assert.deepEqual(after[part], before[part], part)
    const reopened = new ExcelJS.Workbook()
    await reopened.xlsx.load(saved as unknown as Parameters<typeof reopened.xlsx.load>[0])
    const edited = reopened.getWorksheet('Sheet1')!
    assert.equal(edited.getCell('A1').value, null)
    assert.equal(edited.getCell('A2').value, null)
    assert.equal(edited.getCell('A1').font.bold, true)
    assert.equal(reopened.getWorksheet('Sheet2')?.getCell('A1').value, 'retain this')
  })

test('uses authorized attachment names for Office inputs, independent of the guest filename', async t => {
  const { root, config } = await fixture(t)
  config.authorizeTool = async approval => approval.toolName !== 'file_select_original'
  const path = join(root, 'source')
  for (const format of ['docx', 'pptx'] as const) {
    const source = packageFixture(format)
    assert.equal(source.readUInt16LE(8), 8)
    await addSourceAttachment(config, path, `source.${format.toUpperCase()}`, source)
    const tool = pythonTool(config, '', async (_executable, _code, _signal, options) => {
      const copy = options!.inputs!.get('guest')!
      assert.equal(copy.readUInt16LE(8), 0)
      assert.deepEqual(unzipSync(copy), unzipSync(source))
      return output(Buffer.alloc(0))
    })
    const input = { purpose: 'Read attached document', code: 'pass', inputs: [{ path, name: 'guest' }] }
    assert.equal((await invoke(tool, input)).details.isError, false)
    assert.deepEqual(await readFile(path), source)
    config.toolPolicy!.readableAttachmentPaths = []
    await assert.rejects(invoke(tool, input), /input was denied/)
  }
})

test('keeps non-Office input bytes and rejects mismatched or oversized Office packages before Python starts', async t => {
  const { root, config } = await fixture(t)
  const path = join(root, 'source'), filler = join(config.workspaceDir, 'filler')
  const raw = packageFixture('xlsx')
  const tool = pythonTool(config, '', async (_executable, _code, _signal, options) => {
    assert.deepEqual(options!.inputs!.get('file.xlsx'), raw)
    return output(Buffer.alloc(0))
  })
  const input = { purpose: 'Read input', code: 'pass', inputs: [{ path, name: 'file.xlsx' }] }
  await addSourceAttachment(config, path, 'archive.zip', raw)
  assert.equal((await invoke(tool, input)).details.isError, false)
  const shouldNotExecute = pythonTool(config, '', async () => assert.fail('Python started with an invalid input'))
  await addSourceAttachment(config, path, 'document.docx', raw)
  await assert.rejects(invoke(shouldNotExecute, input), /does not match/)
  const large = Buffer.from(zipSync({ ...unzipSync(raw), 'padding.xml': strToU8(`<pad>${'0'.repeat(4096)}</pad>`) }))
  assert.ok(large.length < 2048)
  await addSourceAttachment(config, path, 'source.xlsx', large)
  await writeFile(filler, Buffer.alloc(PYTHON_FILE_LIMIT - 2048))
  await assert.rejects(invoke(shouldNotExecute, { ...input, inputs: [{ path: filler, name: 'filler' }, ...input.inputs] }), /expanded size exceeds the limit/)
})

test('bundled Python copies A1:E11 between compressed attachment workbooks and only replaces the approved target',
  { skip: !process.env.SEP_PYTHON_DEV_RESOURCES }, async t => {
    const native = bundledPythonExecutable()
    assert.ok(native)
    const ExcelJS = createRequire(import.meta.url)('exceljs/dist/exceljs.min.js') as typeof import('exceljs')
    const sourceWorkbook = new ExcelJS.Workbook(), targetWorkbook = new ExcelJS.Workbook()
    const source = sourceWorkbook.addWorksheet('Sheet1'), target = targetWorkbook.addWorksheet('Sheet1')
    const values = Array.from({ length: 11 }, (_, row) => Array.from({ length: 5 }, (_, col) =>
      row === 0 ? `Heading ${col + 1}` : row * 10 + col))
    source.addRows(values)
    target.getCell('A12').value = 'outside the requested range'
    targetWorkbook.addWorksheet('Sheet2').getCell('A1').value = 'keep the other sheet'
    const sourceBytes = Buffer.from(await sourceWorkbook.xlsx.writeBuffer())
    const originalBytes = Buffer.from(await targetWorkbook.xlsx.writeBuffer())
    const { root, config, original } = await fixture(t, 'xlsx', originalBytes)
    const path = join(root, 'source')
    await addSourceAttachment(config, path, 'sales.xlsx', sourceBytes)
    let backup: string | undefined
    config.authorizeTool = async approval => {
      if (approval.toolName === ORIGINAL_DOCUMENT_REPLACE_TOOL) {
        assert.deepEqual(await readFile(original), originalBytes)
        backup = (approval.input as { backup: string }).backup
      }
      return true
    }
    const code = `from zipfile import ZipFile
from xml.etree import ElementTree as ET
from copy import deepcopy
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('', ns)
tag = lambda name: f'{{{ns}}}{name}'
part = 'xl/worksheets/sheet1.xml'
with ZipFile('inputs/sales.xlsx') as src, ZipFile('inputs/document.xlsx') as dst, ZipFile('outputs/document.xlsx', 'w') as out:
  shared = ET.fromstring(src.read('xl/sharedStrings.xml'))
  source = ET.fromstring(src.read(part)).find(tag('sheetData'))
  target = ET.fromstring(dst.read(part))
  rows = target.find(tag('sheetData'))
  for index, row in enumerate(source[:11]):
    copied = deepcopy(row)
    for cell in copied:
      if cell.get('t') == 's':
        value = cell.find(tag('v'))
        text = next(shared[int(value.text)].iter(tag('t'))).text
        cell.remove(value)
        cell.set('t', 'inlineStr')
        ET.SubElement(ET.SubElement(cell, tag('is')), tag('t')).text = text
    rows.insert(index, copied)
  target.find(tag('dimension')).set('ref', 'A1:E12')
  for name in dst.namelist():
    out.writestr(name, ET.tostring(target, encoding='utf-8') if name == part else dst.read(name))`
    const result = await invoke(pythonTool(config, native), { ...request(), code, inputs: [{ path, name: 'sales.xlsx' }] })
    assert.equal(result.details.isError, false, JSON.stringify(result.content))
    assert.ok(backup)
    assert.deepEqual(await readFile(backup), originalBytes)
    assert.deepEqual(await readFile(path), sourceBytes)
    const saved = await readFile(original)
    assert.deepEqual(unzipSync(saved)['xl/worksheets/sheet2.xml'], unzipSync(originalBytes)['xl/worksheets/sheet2.xml'])
    const reopened = new ExcelJS.Workbook()
    await reopened.xlsx.load(saved as unknown as Parameters<typeof reopened.xlsx.load>[0])
    const edited = reopened.getWorksheet('Sheet1')!
    for (const [row, rowValues] of values.entries()) {
      for (const [col, expected] of rowValues.entries()) assert.equal(edited.getCell(row + 1, col + 1).value, expected)
    }
    assert.equal(edited.getCell('A12').value, 'outside the requested range')
  })
