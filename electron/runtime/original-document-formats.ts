import { DOMParser, onErrorStopParsing } from '@xmldom/xmldom'
import { unzipSync, zipSync } from 'fflate'

const officeFormats = new Map([
  ['.docx', ['word/document.xml', 'document', 'wordprocessingml.document'] as const],
  ['.xlsx', ['xl/workbook.xml', 'workbook', 'spreadsheetml.sheet'] as const],
  ['.pptx', ['ppt/presentation.xml', 'presentation', 'presentationml.presentation'] as const],
])
const contentTypesNs = 'http://schemas.openxmlformats.org/package/2006/content-types'
const packageMime = 'application/vnd.openxmlformats-officedocument.'
const officeExpandedLimit = 64 * 1024 * 1024

export function supportsOriginalDocument(extension: string): boolean {
  return extension === '.pdf' || officeFormats.has(extension)
}

function validatedOfficeParts(bytes: Buffer, format: NonNullable<ReturnType<typeof officeFormats.get>>, expandedLimit: number) {
  if (bytes.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('The document is not an Office ZIP package.')
  const names = new Set<string>()
  let expanded = 0
  const files = unzipSync(bytes, { filter: entry => {
    const name = entry.name.toLowerCase()
    if (names.size >= 2048 || (expanded += entry.originalSize) > expandedLimit ||
        (entry.compression === 0 && entry.size !== entry.originalSize) ||
        entry.originalSize < 0 || names.has(name) || name.startsWith('/') || /[\\:]/.test(name) || [...name].some(char => char.charCodeAt(0) < 32) ||
        name.split('/').some(part => part === '.' || part === '..') || name === '__proto__' || name === 'constructor' || name === 'prototype') {
      throw new Error('Unsupported Office ZIP entries or expanded size exceeds the limit.')
    }
    names.add(name)
    return true
  } })
  const parser = new DOMParser({ onError: onErrorStopParsing })
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const [part, rootName, type] = format
  let main = false, contentType = false, relationships = false
  for (const [name, file] of Object.entries(files)) {
    if (!/\.(?:xml|rels)$/i.test(name)) continue
    const xml = utf8.decode(file)
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations are unsupported.')
    const doc = parser.parseFromString(xml, 'application/xml')
    const root = doc.documentElement
    if (name === part) main = root?.localName === rootName && root.namespaceURI === `http://schemas.openxmlformats.org/${type.split('.')[0]}/2006/main`
    if (name === '_rels/.rels') {
      const ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
      relationships = root?.namespaceURI === ns && root.localName === 'Relationships' &&
        Array.from(doc.getElementsByTagNameNS(ns, 'Relationship')).some(element =>
          element.getAttribute('Type') === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' &&
          element.getAttribute('Target')?.replace(/^\//, '') === part && element.getAttribute('TargetMode') !== 'External')
    }
    if (name === '[Content_Types].xml') contentType = root?.namespaceURI === contentTypesNs && root.localName === 'Types' &&
      Array.from(doc.getElementsByTagNameNS(contentTypesNs, 'Override')).some(element => element.getAttribute('PartName') === `/${part}` &&
        element.getAttribute('ContentType') === `${packageMime}${type}.main+xml`)
  }
  if (!main || !contentType || !relationships) throw new Error('The Office package does not match the original document format.')
  return files
}

export function prepareOfficeInputBytes(bytes: Buffer, extension: string, limit: number): Buffer {
  const office = officeFormats.get(extension)
  if (!office) return bytes
  const files = validatedOfficeParts(bytes, office, Math.min(limit, officeExpandedLimit))
  // The bundled WASI Python has zipfile but no zlib. Preserve each part's bytes in a stored ZIP.
  const sorted = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  const prepared = zipSync(sorted, { level: 0, mtime: new Date(2000, 0, 1) })
  if (prepared.length > limit) throw new Error('The expanded Office package exceeds the sandbox input limit.')
  return Buffer.from(prepared)
}

export async function prepareDocumentBytes(bytes: Buffer, extension: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  if (officeFormats.has(extension)) return prepareOfficeInputBytes(bytes, extension, Number.POSITIVE_INFINITY)
  if (extension !== '.pdf' || !bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-') ||
      !/%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'))) throw new Error('The document does not match the original PDF format.')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  signal?.throwIfAborted()
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, stopAtErrors: true, useSystemFonts: false, disableFontFace: true })
  const abort = () => { void loading.destroy().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const document = await loading.promise
    if (document.numPages < 1 || document.numPages > 200) throw new Error('PDF write-back supports 1 to 200 pages.')
    for (let page = 1; page <= document.numPages; page++) {
      signal?.throwIfAborted()
      const loaded = await document.getPage(page)
      loaded.cleanup()
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await loading.destroy()
  }
  return Buffer.from(bytes)
}
