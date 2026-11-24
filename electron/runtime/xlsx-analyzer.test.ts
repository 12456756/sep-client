import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { zipSync } from 'fflate'
import { extractAttachment } from './attachment-extractor'
import { queryXlsx } from './xlsx-analyzer'
import { XLSX_MEDIA_TYPE } from '../../src/shared/attachment-contracts'
import { xlsxResultSchema } from '../domain/xlsx-analysis'

const ExcelJS = createRequire(import.meta.url)('exceljs') as typeof import('exceljs')

test('reads past the summary and across empty rows; the final row changes the group sum', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sales')
  sheet.addRow(['ID', 'Amount', 'Note'])
  for (let row = 2; row < 8002; row++) if (row !== 7900) {
    sheet.getRow(row).values = ['001', 1, 'summary limit '.repeat(12)]
  }
  sheet.getRow(8002).values = [1, 9, 'LAST_ROW_ONLY']
  sheet.getCell('A8002').numFmt = '000'
  workbook.addWorksheet('Hidden', { state: 'veryHidden' }).getCell('A1').value = 'do not show'
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
  const text = await extractAttachment(XLSX_MEDIA_TYPE, bytes)
  assert.equal(text.status, 'partial')
  assert.equal(text.text.length, 100000)
  assert.doesNotMatch(text.text, /LAST_ROW_ONLY/)
  const inspect = await queryXlsx(bytes, { operation: 'xlsx_inspect' })
  assert.equal(inspect.operation, 'xlsx_inspect')
  assert.deepEqual(inspect.sheets.map(sheet => [sheet.name, sheet.usedRange, sheet.nonEmptyRows]), [['Sales', 'A1:C8002', 8001]])
  assert.ok(xlsxResultSchema.safeParse(inspect).success)
  const query = { operation: 'xlsx_analyze', sheet: 'Sales', range: 'A2:C8002', kind: 'group_sum', columns: ['A'], valueColumn: 'B' } as const
  const sum = await queryXlsx(bytes, { ...query, columns: [...query.columns] })
  assert.equal(sum.operation, 'xlsx_analyze')
  assert.deepEqual([sum.scannedRows, sum.emptyRows, sum.includedRows, sum.total], [8001, 1, 8000, 8008])
  assert.deepEqual(sum.groups, [{ key: ['001'], count: 8000, sum: 8008 }])
  const tail = await queryXlsx(bytes, { operation: 'xlsx_read_range', sheet: 'Sales', range: 'A8002:C8002' })
  assert.equal(tail.operation, 'xlsx_read_range')
  assert.deepEqual(tail.cells.map(cell => cell.value), ['001', 9, 'LAST_ROW_ONLY'])
  await assert.rejects(queryXlsx(bytes, { operation: 'xlsx_read_range', sheet: 'Hidden', range: 'A1:A1' }), /XLSX_SHEET_NOT_AVAILABLE/)
})

test('distinguishes formula caches, cell errors, blank, text numbers and duplicate keys', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  sheet.addRows([
    ['001', { formula: '5+5', result: 10 }], ['001', { formula: '1-1', result: 0 }], [1, 2],
    ['001', { formula: '4+4' }], ['001', { error: '#DIV/0!' }], ['001', '12'], ['001', ' '], [null, 8],
  ])
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
  const q = { operation: 'xlsx_analyze', sheet: 'Data', range: 'A1:B8' } as const
  const missing = await queryXlsx(bytes, { ...q, kind: 'missing', columns: ['B'] })
  assert.equal(missing.operation, 'xlsx_analyze')
  assert.deepEqual(missing.missingByColumn, [{ column: 'B', blank: 1, error: 1, uncachedFormula: 1 }])
  const sum = await queryXlsx(bytes, { ...q, kind: 'group_sum', columns: ['A'], valueColumn: 'B' })
  assert.equal(sum.operation, 'xlsx_analyze')
  assert.deepEqual([sum.total, sum.includedRows, sum.excludedKeyRows, sum.excludedValueRows], [12, 3, 1, 4])
  assert.deepEqual(sum.groups, [{ key: ['001'], count: 2, sum: 10 }, { key: [1], count: 1, sum: 2 }])
  const duplicates = await queryXlsx(bytes, { ...q, kind: 'duplicates', columns: ['A'] })
  assert.equal(duplicates.operation, 'xlsx_analyze')
  assert.deepEqual([duplicates.duplicateRows, duplicates.duplicateExtraRows, duplicates.totalGroups], [6, 5, 1])
  const filtered = await queryXlsx(bytes, { ...q, kind: 'count', filters: [{ column: 'A', op: 'eq', value: '001' }, { column: 'B', op: 'gte', value: 0 }] })
  assert.equal(filtered.operation, 'xlsx_analyze')
  assert.deepEqual([filtered.includedRows, filtered.filteredRows, filtered.unavailableFilterRows], [2, 2, 4])
})

test('fails bounded requests instead of returning partial statistics; omits only group display', async () => {
  const query = { operation: 'xlsx_analyze', sheet: 'Data', range: 'A1:B90', kind: 'group_count', columns: ['A'] } as const
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  for (let index = 0; index < 90; index++) sheet.addRow([`key_${index}`, index])
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
  const result = await queryXlsx(bytes, { ...query, columns: ['A'] })
  assert.equal(result.operation, 'xlsx_analyze')
  assert.deepEqual([result.includedRows, result.totalGroups, result.groups?.length, result.omittedGroups], [90, 90, 50, 40])
  await assert.rejects(queryXlsx(bytes, { ...query, columns: ['A'], range: 'A1:Z100000' }), /XLSX_BUDGET_EXCEEDED/)
  await assert.rejects(queryXlsx(bytes, { operation: 'xlsx_read_range', sheet: 'Data', range: 'A1:B90' }), /XLSX_BUDGET_EXCEEDED/)
  await assert.rejects(queryXlsx(bytes, { ...query, columns: ['C'] }), /XLSX_INVALID_REQUEST/)
  const badSize = Buffer.from(zipSync({ 'xl/workbook.xml': Buffer.from('invalid') }))
  const directory = badSize.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  badSize.writeUInt32LE(1, directory + 24)
  await assert.rejects(queryXlsx(badSize, { operation: 'xlsx_inspect' }), /XLSX_PARSE_FAILED/)
  badSize.writeUInt32LE(65 * 1024 * 1024, directory + 24)
  await assert.rejects(queryXlsx(badSize, { operation: 'xlsx_inspect' }), /XLSX_BUDGET_EXCEEDED/)
})
