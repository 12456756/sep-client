import { createRequire } from 'node:module'
import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import type { AttachmentExtraction } from '../domain/attachment-extraction'

const require = createRequire(import.meta.url)
const maxText = 100000
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, processEntities: false })
const officeTypes = new Map([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', /^word\/(document|header\d+|footer\d+)\.xml$/],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', /^ppt\/slides\/slide\d+\.xml$/],
])

function archive(bytes: Uint8Array, match: RegExp): Record<string, Uint8Array> {
  let count = 0, expanded = 0
  return unzipSync(bytes, { filter: entry => {
    if (++count > 2048 || (expanded += entry.originalSize) > 64 * 1024 * 1024) throw new Error('ARCHIVE_BUDGET_EXCEEDED')
    return match.test(entry.name)
  } })
}

function paragraphText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(paragraphText).join('')
  if (!value || typeof value !== 'object') return ''
  return Object.entries(value).map(([key, child]) => key === 'p' ? (Array.isArray(child) ? child : [child]).map(paragraphText).join('\n') + '\n' : key === 'br' ? '\n' : paragraphText(child)).join('')
}

export async function extractAttachment(mediaType: string, bytes: Uint8Array): Promise<AttachmentExtraction> {
  const warnings: string[] = []
  if (mediaType.startsWith('image/')) return { status: 'not-required', text: '', warnings: [] }
  try {
    let text = ''
    if (mediaType.startsWith('text/') || ['application/json', 'application/xml'].includes(mediaType)) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { text = new TextDecoder('gb18030').decode(bytes); warnings.push('ENCODING_GB18030') }
      if (text.includes('\u0000')) throw new Error('BINARY_TEXT_INPUT')
    } else if (officeTypes.has(mediaType)) {
      const entries = archive(bytes, officeTypes.get(mediaType)!)
      for (const name of Object.keys(entries).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
        const xml = new TextDecoder().decode(entries[name])
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML_DECLARATION_UNSUPPORTED')
        text += `${name}\n${paragraphText(parser.parse(xml) as unknown)}\n`
        if (text.length > maxText) break
      }
      warnings.push('LAYOUT_AND_EMBEDDED_IMAGES_NOT_EXTRACTED')
    } else if (mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      archive(bytes, /$^/)
      const ExcelJS = require('exceljs') as typeof import('exceljs')
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
      let cells = 0
      for (const sheet of workbook.worksheets) {
        text += `\n[${sheet.name}]\n`
        sheet.eachRow(row => {
          if (text.length > maxText) return
          const values: string[] = []
          row.eachCell(cell => {
            if (++cells > 100000) throw new Error('SPREADSHEET_BUDGET_EXCEEDED')
            values.push(`${cell.address}: ${cell.formula && cell.result === undefined ? '[FORMULA_RESULT_NOT_CACHED]' : cell.text}`)
          })
          text += `${values.join('\t')}\n`
        })
        if (text.length > maxText) break
      }
      warnings.push('FORMULAS_NOT_EXECUTED')
    } else if (mediaType === 'application/pdf') {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true })
      const document = await loading.promise
      try {
        const pages = Math.min(document.numPages, 200)
        for (let index = 1; index <= pages && text.length <= maxText; index++) {
          const page = await document.getPage(index)
          const content = await page.getTextContent()
          text += `\n[Page ${index}]\n${content.items.map(item => 'str' in item ? item.str : '').join(' ')}\n`
          page.cleanup()
        }
        if (document.numPages > pages) warnings.push('PAGE_LIMIT_REACHED')
        if (!text.replace(/\[Page \d+\]/g, '').trim()) warnings.push('NO_TEXT_OCR_UNAVAILABLE')
      } finally { await document.destroy() }
    } else return { status: 'unsupported', text: '', warnings: ['UNSUPPORTED_ATTACHMENT_TYPE'] }
    if (text.length > maxText) warnings.push('TEXT_TRUNCATED')
    return { status: warnings.includes('TEXT_TRUNCATED') || warnings.includes('PAGE_LIMIT_REACHED') || warnings.includes('NO_TEXT_OCR_UNAVAILABLE') ? 'partial' : 'ready', text: text.slice(0, maxText), warnings }
  } catch { return { status: 'failed', text: '', warnings: ['EXTRACTION_FAILED'] } }
}
