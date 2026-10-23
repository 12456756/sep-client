import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { createRequire } from 'node:module'
import { convertDocumentPreview } from './document-preview-converter'
const ExcelJS = createRequire(import.meta.url)('exceljs') as typeof import('exceljs')

test('text and markdown are returned as content, not executable HTML', async () => {
  assert.deepEqual(await convertDocumentPreview('md', Buffer.from('# Heading')), { kind: 'markdown', text: '# Heading' })
  assert.deepEqual(await convertDocumentPreview('html', Buffer.from('<script>bad()</script>')), { kind: 'text', text: '<script>bad()</script>' })
})

test('Word preview includes paragraphs, headings and tables without external file access', async () => {
  const bytes = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Accepted report</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'),
  })
  const result = await convertDocumentPreview('docx', bytes)
  assert.equal(result.kind, 'html')
  if (result.kind !== 'html') return
  assert.match(result.sections[0].html, /Accepted report/)
  assert.match(result.sections[0].html, /<table>/)
})

test('Excel preview has sheet names, escaped values, cached results and explicit missing formula values', async () => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Sales')
  sheet.addRow(['<script>not executable</script>', 7, { formula: 'B1*2', result: 14 }, { formula: 'B1*3' }])
  book.addWorksheet('Summary').addRow(['Second sheet'])
  const result = await convertDocumentPreview('xlsx', new Uint8Array(await book.xlsx.writeBuffer()))
  assert.equal(result.kind, 'html')
  if (result.kind !== 'html') return
  assert.equal(result.sections[0].title, 'Sales')
  assert.match(result.sections[0].html, /&lt;script&gt;/)
  assert.match(result.sections[0].html, />14</)
  assert.match(result.sections[0].html, /公式结果未缓存/)
  assert.equal(result.sections[1].title, 'Summary')
})

test('Excel preview rejects a small sparse workbook before expanding millions of empty cells', async () => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Sparse')
  for (let row = 1; row <= 1000; row++) sheet.getCell(`XFD${row}`).value = 'value'
  const bytes = new Uint8Array(await book.xlsx.writeBuffer())
  assert.ok(bytes.byteLength < 64 * 1024)
  await assert.rejects(convertDocumentPreview('xlsx', bytes), /表格预览单元格过多.*查看原件/)
})

test('Excel preview applies the cell budget across all visible sheets', async () => {
  const book = new ExcelJS.Workbook()
  for (const name of ['First', 'Second']) {
    const sheet = book.addWorksheet(name)
    for (let row = 1; row <= 4; row++) sheet.getCell(`XFD${row}`).value = name
  }
  await assert.rejects(convertDocumentPreview('xlsx', new Uint8Array(await book.xlsx.writeBuffer())), /表格预览单元格过多/)
})

test('Excel preview preserves sparse column positions within budget and skips hidden sheets', async () => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Visible')
  sheet.getCell('A1').value = 'first'
  sheet.getCell('J1').value = 'last'
  const hidden = book.addWorksheet('Hidden', { state: 'hidden' })
  for (let row = 1; row <= 7; row++) hidden.getCell(`XFD${row}`).value = 'hidden'
  const result = await convertDocumentPreview('xlsx', new Uint8Array(await book.xlsx.writeBuffer()))
  assert.equal(result.kind, 'html')
  if (result.kind !== 'html') return
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].title, 'Visible')
  assert.match(result.sections[0].html, /<td>first<\/td>(?:<td><\/td>){8}<td>last<\/td>/)
})

test('PowerPoint follows presentation order instead of numeric slide filenames', async () => {
  const bytes = zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="b"/><p:sldId r:id="a"/></p:sldIdLst></p:presentation>'),
    'ppt/_rels/presentation.xml.rels': strToU8('<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>'),
    'ppt/slides/slide1.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>'),
    'ppt/slides/slide2.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>'),
  })
  const result = await convertDocumentPreview('pptx', bytes)
  assert.equal(result.kind, 'html')
  if (result.kind !== 'html') return
  assert.match(result.sections[0].html, /First/)
  assert.match(result.sections[1].html, /Second/)
})
