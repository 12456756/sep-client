import { Unzip, UnzipInflate, unzipSync, zipSync } from 'fflate'
import type { Cell, Worksheet } from 'exceljs'
import { attachmentImportLimits } from '../../src/shared/attachment-contracts'
import { XLSX_RESULT_BYTES, type XlsxFailure, type XlsxQuery, type XlsxResult, type XlsxSample, type XlsxScalar } from '../domain/xlsx-analysis'
import { loadXlsxWorkbook } from './xlsx-workbook'

const MAX_SCAN = 1_000_000
const MAX_ROWS = 100_000
const MAX_SAMPLE_CELLS = 120
const MAX_EXPANDED = 64 * 1024 * 1024

export class XlsxAnalysisError extends Error {
  constructor(readonly reason: XlsxFailure) { super(reason) }
}
function fail(reason: XlsxFailure): never { throw new XlsxAnalysisError(reason) }

function columnNumber(name: string): number {
  return [...name].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0)
}
function columnName(number: number): string {
  let name = ''
  while (number) { number--; name = String.fromCharCode(65 + number % 26) + name; number = Math.floor(number / 26) }
  return name
}
function parseRange(range: string) {
  const match = /^([A-Z]{1,3})([1-9][0-9]*):([A-Z]{1,3})([1-9][0-9]*)$/.exec(range)
  if (!match) fail('XLSX_INVALID_REQUEST')
  const [, left, top, right, bottom] = match
  const c1 = columnNumber(left), c2 = columnNumber(right), r1 = Number(top), r2 = Number(bottom)
  if (c1 > c2 || c2 > 16_384 || r1 > r2 || r2 > 1_048_576) fail('XLSX_INVALID_REQUEST')
  return { c1, c2, r1, r2, rows: r2 - r1 + 1, cells: (c2 - c1 + 1) * (r2 - r1 + 1) }
}

type ReadCell = { state: 'value'; value: XlsxScalar; number?: number; cachedFormula?: true } |
  { state: 'blank' | 'error' | 'uncached_formula'; cachedFormula?: true }
function readCell(cell?: Cell): ReadCell {
  const raw = cell?.value
  const formula = raw && typeof raw === 'object' && ('formula' in raw || 'sharedFormula' in raw) ? raw : undefined
  // ExcelJS's formula value copy drops falsy cached results; Cell.result preserves zero and false.
  const val = formula ? cell?.result : raw
  if (formula && val == null) return { state: 'uncached_formula' }
  const flags = formula ? { cachedFormula: true as const } : {}
  if (val == null) return { state: 'blank', ...flags }
  if (typeof val === 'number' && Number.isFinite(val)) {
    const fmt = cell?.numFmt
    const padded = fmt && /^0{2,64}$/.test(fmt) && Number.isSafeInteger(val)
      ? `${val < 0 ? '-' : ''}${String(Math.abs(val)).padStart(fmt.length, '0')}` : val
    return { state: 'value', value: padded, number: val, ...flags }
  }
  if (typeof val === 'boolean') return { state: 'value', value: val, ...flags }
  if (val instanceof Date && Number.isFinite(val.getTime())) return { state: 'value', value: val.toISOString(), ...flags }
  const text = typeof val === 'string' ? val : typeof val === 'object' && 'richText' in val
    ? val.richText.map(part => part.text).join('') : typeof val === 'object' && 'hyperlink' in val ? val.text : undefined
  if (text !== undefined) return text.trim() ? { state: 'value', value: text, ...flags } : { state: 'blank', ...flags }
  return { state: 'error', ...flags }
}

function sample(address: string, result: ReadCell): XlsxSample {
  const { state, cachedFormula } = result
  const value = result.state === 'value' ? result.value : undefined
  return { address, state, ...(cachedFormula ? { cachedFormula } : {}),
    ...(typeof value === 'string' && value.length > 256 ? { value: value.slice(0, 256), clipped: true } : value !== undefined ? { value } : {}) }
}

function size(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)) }

function inspect(sheets: Worksheet[]): XlsxResult {
  let scanned = 0
  const result: Extract<XlsxResult, { operation: 'xlsx_inspect' }> = {
    operation: 'xlsx_inspect', visibleSheets: sheets.length, omittedSheets: Math.max(0, sheets.length - 16), sheets: [],
  }
  for (const sheet of sheets.slice(0, 16)) {
    let top = Infinity, bottom = 0, left = Infinity, right = 0
    const info: (typeof result.sheets)[number] = { name: sheet.name, nonEmptyRows: 0, usedRange: null, samples: [], sampleClipped: false }
    sheet.eachRow(row => {
      let used = false
      row.eachCell((cell, col) => {
        if (++scanned > MAX_SCAN) fail('XLSX_BUDGET_EXCEEDED')
        const value = readCell(cell)
        if (value.state === 'blank' && cell.value == null) return
        used = true
        left = Math.min(left, col); right = Math.max(right, col)
        if (info.nonEmptyRows >= 5) return
        if (info.samples.length < 24) info.samples.push(sample(cell.address, value))
        else info.sampleClipped = true
      })
      if (used) {
        info.nonEmptyRows++
        top = Math.min(top, row.number); bottom = Math.max(bottom, row.number)
      }
    })
    if (right) info.usedRange = `${columnName(left)}${top}:${columnName(right)}${bottom}`
    result.sheets.push(info)
  }
  for (const info of result.sheets.slice().reverse()) {
    if (size(result) <= XLSX_RESULT_BYTES) break
    info.sampleClipped ||= info.samples.length > 0
    info.samples = []
  }
  return result
}

function matches(actual: XlsxScalar, expected: XlsxScalar, op: typeof import('../domain/xlsx-analysis').xlsxComparisons[number]): boolean {
  if (op === 'eq') return actual === expected
  if (op === 'ne') return actual !== expected
  if (typeof actual !== 'number' || typeof expected !== 'number') return false
  switch (op) {
    case 'lt': return actual < expected
    case 'lte': return actual <= expected
    case 'gt': return actual > expected
    case 'gte': return actual >= expected
  }
}

function add(a: number, b: number): number {
  const result = a + b
  if (!Number.isFinite(result)) fail('XLSX_NUMERIC_OVERFLOW')
  return result
}

function analyze(sheet: Worksheet, range: ReturnType<typeof parseRange>, query: Extract<XlsxQuery, { operation: 'xlsx_analyze' }>): XlsxResult {
  const { kind } = query
  const columns = query.columns ?? []
  if ((kind === 'count' ? columns.length !== 0 : !columns.length) || new Set(columns).size !== columns.length ||
    (kind === 'group_sum') !== (query.valueColumn !== undefined)) fail('XLSX_INVALID_REQUEST')
  const inRange = (name: string) => {
    const number = columnNumber(name)
    if (number < range.c1 || number > range.c2) fail('XLSX_INVALID_REQUEST')
    return number
  }
  const keys = columns.map(inRange)
  const valueCol = query.valueColumn ? inRange(query.valueColumn) : 0
  const filters = (query.filters ?? []).map(filter => ({ ...filter, index: inRange(filter.column) }))
  if (filters.some(filter => !['eq', 'ne'].includes(filter.op) && typeof filter.value !== 'number')) fail('XLSX_INVALID_REQUEST')
  const result: Extract<XlsxResult, { operation: 'xlsx_analyze' }> = {
    operation: query.operation, sheet: query.sheet, range: query.range, kind, scannedRows: range.rows,
    emptyRows: 0, filteredRows: 0, unavailableFilterRows: 0, matchedRows: 0, includedRows: 0, excludedKeyRows: 0, excludedValueRows: 0,
  }
  const missing = columns.map(column => ({ column, blank: 0, error: 0, uncachedFormula: 0 }))
  const groups = new Map<string, { key: XlsxScalar[]; count: number; sum: number }>()
  let groupKeySize = 0, total = 0, missingRows = 0
  for (let r = range.r1; r <= range.r2; r++) {
    const row = sheet.findRow(r)
    const get = (c: number) => readCell(row?.findCell(c))
    let nonEmpty = false
    for (let c = range.c1; row && c <= range.c2; c++) {
      if (get(c).state !== 'blank') { nonEmpty = true; break }
    }
    if (!nonEmpty) { result.emptyRows++; continue }
    const tested = filters.map(filter => ({ filter, actual: get(filter.index) }))
    if (tested.some(({ actual }) => actual.state !== 'value')) { result.unavailableFilterRows++; continue }
    if (tested.some(({ actual, filter }) => actual.state === 'value' && !matches(actual.value, filter.value, filter.op))) { result.filteredRows++; continue }
    result.matchedRows++
    const selected = keys.map(get)
    if (kind === 'missing') {
      if (selected.some(cell => cell.state !== 'value')) missingRows++
      selected.forEach(({ state }, index) => {
        if (state !== 'value') missing[index][state === 'uncached_formula' ? 'uncachedFormula' : state]++
      })
    } else if (kind !== 'count') {
      const key = selected.flatMap(cell => cell.state === 'value' ? [cell.value] : [])
      if (key.length !== keys.length) { result.excludedKeyRows++; continue }
      const numeric = valueCol ? get(valueCol) : undefined
      const number = numeric?.state === 'value' ? numeric.number : undefined
      if (valueCol && number === undefined) { result.excludedValueRows++; continue }
      const encoded = JSON.stringify(key)
      let group = groups.get(encoded)
      if (!group) {
        if (groups.size >= 20_000 || (groupKeySize += Buffer.byteLength(encoded)) > 4_000_000) fail('XLSX_BUDGET_EXCEEDED')
        group = { key, count: 0, sum: 0 }
        groups.set(encoded, group)
      }
      group.count++
      if (number !== undefined) { group.sum = add(group.sum, number); total = add(total, number) }
    }
    result.includedRows++
  }
  if (kind === 'missing') return { ...result, missingRows, missingByColumn: missing }
  if (kind === 'count') return result
  const eligible = [...groups.values()].filter(group => kind !== 'duplicates' || group.count > 1)
  if (kind === 'duplicates') {
    result.duplicateRows = eligible.reduce((sum, group) => sum + group.count, 0)
    result.duplicateExtraRows = result.duplicateRows - eligible.length
  }
  if (kind === 'group_sum') result.total = total
  eligible.sort((a, b) => (kind === 'group_sum' ? b.sum - a.sum : 0) || b.count - a.count)
  result.totalGroups = eligible.length
  result.groups = []
  for (const group of eligible.slice(0, 50)) {
    const key = group.key.map(value => typeof value === 'string' ? value.slice(0, 256) : value)
    result.groups.push({ key, count: group.count, ...(kind === 'group_sum' ? { sum: group.sum } : {}),
      ...(key.some((value, index) => value !== group.key[index]) ? { clipped: true } : {}) })
    if (size(result) > XLSX_RESULT_BYTES - 100) { result.groups.pop(); break }
  }
  result.omittedGroups = eligible.length - result.groups.length
  return result
}

function boundedArchive(bytes: Uint8Array): Uint8Array {
  let expanded = 0
  const declared = new Map<string, number>()
  unzipSync(bytes, { filter: entry => {
    if (declared.size >= 2048 || (expanded += entry.originalSize) > MAX_EXPANDED) fail('XLSX_BUDGET_EXCEEDED')
    if (declared.has(entry.name) || entry.name.length > 1024 || !entry.name || entry.name.includes('\\') ||
      entry.name.startsWith('/') || entry.name.split('/').some(part => ['.', '..', '__proto__', 'constructor', 'prototype'].includes(part))) fail('XLSX_PARSE_FAILED')
    declared.set(entry.name, entry.originalSize)
    return false
  } })
  // Bound actual output as well as the ZIP directory's claims. ExcelJS only sees the checked entries.
  expanded = 0
  const files: Record<string, Uint8Array> = Object.create(null)
  const unzip = new Unzip(file => {
    const expected = declared.get(file.name)
    if (expected === undefined || Object.hasOwn(files, file.name)) fail('XLSX_PARSE_FAILED')
    const contents = new Uint8Array(expected)
    files[file.name] = contents
    let written = 0
    file.ondata = (error, chunk, done) => {
      if (error) fail('XLSX_PARSE_FAILED')
      expanded += chunk.length
      if (expanded > MAX_EXPANDED) fail('XLSX_BUDGET_EXCEEDED')
      if (written + chunk.length > contents.length) fail('XLSX_PARSE_FAILED')
      contents.set(chunk, written)
      written += chunk.length
      if (done) {
        if (written !== expected) fail('XLSX_PARSE_FAILED')
        declared.delete(file.name)
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let from = 0; from < bytes.length; from += 16_384) unzip.push(bytes.subarray(from, from + 16_384), from + 16_384 >= bytes.length)
  if (declared.size) fail('XLSX_PARSE_FAILED')
  return zipSync(files, { level: 0 })
}

export async function queryXlsx(bytes: Uint8Array, query: XlsxQuery): Promise<XlsxResult> {
  if (!bytes.length || bytes.length > attachmentImportLimits.maxFileBytes) fail('XLSX_BUDGET_EXCEEDED')
  const range = query.operation === 'xlsx_inspect' ? undefined : parseRange(query.range)
  if (range && (range.rows > MAX_ROWS || range.cells > (query.operation === 'xlsx_read_range' ? MAX_SAMPLE_CELLS : MAX_SCAN))) fail('XLSX_BUDGET_EXCEEDED')
  let workbook: Awaited<ReturnType<typeof loadXlsxWorkbook>>['workbook']
  try {
    ;({ workbook } = await loadXlsxWorkbook(boundedArchive(bytes), { ignoreNodes: ['mergeCells', 'drawing', 'conditionalFormatting', 'extLst'] }))
  } catch (error) { if (error instanceof XlsxAnalysisError) throw error; fail('XLSX_PARSE_FAILED') }
  const sheets = workbook.worksheets.filter(sheet => sheet.state === 'visible')
  if (query.operation === 'xlsx_inspect') return inspect(sheets)
  const sheet = sheets.find(sheet => sheet.name === query.sheet)
  if (!sheet) fail('XLSX_SHEET_NOT_AVAILABLE')
  if (query.operation === 'xlsx_analyze') return analyze(sheet, range!, query)
  const cells: XlsxSample[] = []
  const { r1, r2, c1, c2 } = range!
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
    cells.push(sample(`${columnName(c)}${r}`, readCell(sheet.findRow(r)?.findCell(c))))
  }
  const result: XlsxResult = { operation: query.operation, sheet: query.sheet, range: query.range, cells }
  if (size(result) > XLSX_RESULT_BYTES) fail('XLSX_BUDGET_EXCEEDED')
  return result
}
