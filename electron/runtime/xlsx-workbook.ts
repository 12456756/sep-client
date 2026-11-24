import { createRequire } from 'node:module'
import { DOMParser, XMLSerializer, onErrorStopParsing } from '@xmldom/xmldom'
import { unzipSync, zipSync } from 'fflate'

const require = createRequire(import.meta.url)
const spreadsheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const extendedPropertiesNs = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
const relationshipsNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
const workbookPart = /^xl\/(?:workbook|styles|sharedStrings|worksheets\/sheet\d+|tables\/table\d+|comments\d+)\.xml$/
const relationshipsPart = /^xl\/(?:_rels\/workbook\.xml|worksheets\/_rels\/sheet\d+\.xml)\.rels$/

function normalizeExcelJsParts(bytes: Uint8Array): Uint8Array | undefined {
  let count = 0, expanded = 0
  const files = unzipSync(bytes, { filter: file => {
    if (++count > 2048 || (expanded += file.originalSize) > 64 * 1024 * 1024) throw new Error('XLSX_ARCHIVE_LIMIT')
    return true
  } })
  const parser = new DOMParser({ onError: onErrorStopParsing })
  const serializer = new XMLSerializer()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  let changed = false
  for (const [name, content] of Object.entries(files)) {
    const namespace = workbookPart.test(name) ? spreadsheetNs : name === 'docProps/app.xml' ? extendedPropertiesNs
      : relationshipsPart.test(name) ? relationshipsNs : undefined
    if (!namespace) continue
    const xml = decoder.decode(content)
    if (!/<[\w.-]+:/.test(xml)) continue
    if (/<!DOCTYPE/i.test(xml)) throw new Error('XLSX_XML_DOCTYPE_UNSUPPORTED')
    const doc = parser.parseFromString(xml, 'application/xml')
    const prefixed = Array.from(doc.getElementsByTagNameNS(namespace, '*')).filter(element => element.prefix)
    if (!prefixed.length) continue
    // ExcelJS matches literal tag names. Keep attributes and other namespaces as-is.
    for (const element of prefixed.reverse()) {
      if (!element.localName) continue
      const replacement = doc.createElementNS(namespace, element.localName)
      for (const attribute of Array.from(element.attributes)) replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
      while (element.firstChild) replacement.appendChild(element.firstChild)
      element.parentNode?.replaceChild(replacement, element)
    }
    const normalized = encoder.encode(serializer.serializeToString(doc))
    expanded += normalized.length - content.length
    if (expanded > 64 * 1024 * 1024) throw new Error('XLSX_ARCHIVE_LIMIT')
    files[name] = normalized
    changed = true
  }
  return changed ? zipSync(files, { level: 0 }) : undefined
}

export async function loadXlsxWorkbook(bytes: Uint8Array, options?: Partial<import('exceljs').XlsxReadOptions>) {
  // Use the standalone bundle: the Node entry also loads streaming dependencies we do not need.
  const ExcelJS = require('exceljs/dist/exceljs.min.js') as typeof import('exceljs')
  const load = async (source: Uint8Array) => {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(source) as unknown as Parameters<typeof workbook.xlsx.load>[0], options)
    return workbook
  }
  let workbook: import('exceljs').Workbook
  try { workbook = await load(bytes) }
  catch (error) {
    const normalized = normalizeExcelJsParts(bytes)
    if (!normalized) throw error
    workbook = await load(normalized)
  }
  return { workbook, formulaType: ExcelJS.ValueType.Formula }
}
