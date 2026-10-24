import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { strToU8, zipSync } from 'fflate'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createRequire } from 'node:module'
import { extractAttachment } from './attachment-extractor'

test('extracts bounded text and marks truncation', async () => {
  const result = await extractAttachment('text/plain', strToU8('hello '.repeat(30000)))
  assert.equal(result.status, 'partial')
  assert.equal(result.text.length, 100000)
  assert.ok(result.warnings.includes('TEXT_TRUNCATED'))
})

test('extracts Office paragraphs without treating HTML as document text', async () => {
  const bytes = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t>Revenue 42</w:t></w:r></w:p></w:body></w:document>') })
  const result = await extractAttachment('application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes)
  assert.equal(result.status, 'ready')
  assert.match(result.text, /Quarterly report\nRevenue 42/)
})

test('rejects hostile XML and unsupported binaries explicitly', async () => {
  const bytes = zipSync({ 'ppt/slides/slide1.xml': strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><p>&x;</p>') })
  assert.equal((await extractAttachment('application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes)).status, 'failed')
  assert.equal((await extractAttachment('application/octet-stream', new Uint8Array([0, 1, 2]))).status, 'unsupported')
})

test('extracts slides in numeric order and rejects oversized archive metadata', async () => {
  const slide = (text: string) => strToU8(`<p:sld xmlns:p="urn:slide" xmlns:a="urn:text"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`)
  const bytes = zipSync({ 'ppt/slides/slide10.xml': slide('Tenth slide'), 'ppt/slides/slide2.xml': slide('Second slide') })
  const result = await extractAttachment('application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes)
  assert.equal(result.status, 'ready')
  assert.ok(result.text.indexOf('Second slide') < result.text.indexOf('Tenth slide'))
  const oversized = zipSync(Object.fromEntries(Array.from({ length: 2049 }, (_, i) => [`word/header${i}.xml`, strToU8('<p>x</p>')])))
  assert.equal((await extractAttachment('application/vnd.openxmlformats-officedocument.wordprocessingml.document', oversized)).status, 'failed')
})

test('extracts workbook values and marks uncached formulas without executing them', async () => {
  const ExcelJS = createRequire(import.meta.url)('exceljs') as typeof import('exceljs')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Budget')
  sheet.addRow(['Revenue', 42])
  sheet.getCell('B2').value = { formula: 'SUM(B1:B1)' }
  const result = await extractAttachment('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Uint8Array(await workbook.xlsx.writeBuffer()))
  assert.equal(result.status, 'ready')
  assert.match(result.text, /A1: Revenue.*B1: 42/)
  assert.match(result.text, /FORMULA_RESULT_NOT_CACHED/)
  assert.ok(result.warnings.includes('FORMULAS_NOT_EXECUTED'))
})

test('extracts actual PDF page text and distinguishes image-only input', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage().drawText('Attachment PDF evidence', { font: await pdf.embedFont(StandardFonts.Helvetica) })
  const result = await extractAttachment('application/pdf', await pdf.save())
  assert.match(result.text, /Attachment PDF evidence/)
  assert.equal(result.status, 'ready')
  const blank = await PDFDocument.create(); blank.addPage()
  assert.ok((await extractAttachment('application/pdf', await blank.save())).warnings.includes('NO_TEXT_OCR_UNAVAILABLE'))
  assert.equal((await extractAttachment('image/png', new Uint8Array([1]))).status, 'not-required')
})
