import { z } from 'zod'

export const XLSX_RESULT_BYTES = 24_000
export const xlsxColumnPattern = '^[A-Z]{1,3}$'
export const xlsxRangePattern = '^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$'
export const xlsxKinds = ['count', 'missing', 'duplicates', 'group_count', 'group_sum'] as const
export const xlsxComparisons = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const

const column = z.string().regex(new RegExp(xlsxColumnPattern))
const sheet = z.string().min(1).max(31)
const range = z.string().regex(new RegExp(xlsxRangePattern))
const scalar = z.union([z.string().max(512), z.number(), z.boolean()])
export type XlsxScalar = z.infer<typeof scalar>
export const xlsxQuerySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('xlsx_inspect') }).strict(),
  z.object({ operation: z.literal('xlsx_read_range'), sheet, range }).strict(),
  z.object({ operation: z.literal('xlsx_analyze'), sheet, range, kind: z.enum(xlsxKinds),
    columns: z.array(column).min(1).max(5).optional(),
    valueColumn: column.optional(),
    filters: z.array(z.object({ column, op: z.enum(xlsxComparisons), value: scalar }).strict()).max(8).optional(),
  }).strict(),
])
export type XlsxQuery = z.infer<typeof xlsxQuerySchema>

const count = z.number().int().nonnegative()
const sampleCell = z.object({ address: z.string().max(10), state: z.enum(['value', 'blank', 'error', 'uncached_formula']),
  value: scalar.optional(), clipped: z.literal(true).optional(), cachedFormula: z.literal(true).optional(),
}).strict()
export type XlsxSample = z.infer<typeof sampleCell>
const samples = z.array(sampleCell).max(120)
export const xlsxResultSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('xlsx_inspect'), visibleSheets: count, omittedSheets: count,
    sheets: z.array(z.object({ name: sheet, usedRange: range.nullable(), nonEmptyRows: count, samples,
      sampleClipped: z.boolean() }).strict()).max(16),
  }).strict(),
  z.object({ operation: z.literal('xlsx_read_range'), sheet, range, cells: samples }).strict(),
  z.object({ operation: z.literal('xlsx_analyze'), sheet, range, kind: z.enum(xlsxKinds),
    scannedRows: count, emptyRows: count, filteredRows: count, unavailableFilterRows: count, matchedRows: count, includedRows: count,
    excludedKeyRows: count, excludedValueRows: count, missingRows: count.optional(),
    missingByColumn: z.array(z.object({ column, blank: count, error: count, uncachedFormula: count }).strict()).max(5).optional(),
    duplicateRows: count.optional(), duplicateExtraRows: count.optional(),
    totalGroups: count.optional(), omittedGroups: count.optional(), total: z.number().optional(),
    groups: z.array(z.object({ key: z.array(scalar).min(1).max(5), count, sum: z.number().optional(), clipped: z.literal(true).optional() }).strict()).max(50).optional(),
  }).strict(),
])
export type XlsxResult = z.infer<typeof xlsxResultSchema>
export const xlsxFailureSchema = z.enum(['XLSX_INVALID_REQUEST', 'XLSX_SHEET_NOT_AVAILABLE', 'XLSX_BUDGET_EXCEEDED', 'XLSX_PARSE_FAILED', 'XLSX_NUMERIC_OVERFLOW', 'XLSX_BUSY', 'XLSX_TIMEOUT', 'XLSX_WORKER_FAILED'])
export type XlsxFailure = z.infer<typeof xlsxFailureSchema>
export type RunXlsxQuery = (bytes: Uint8Array, query: XlsxQuery, signal?: AbortSignal) => Promise<XlsxResult>
