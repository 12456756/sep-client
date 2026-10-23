import { createRequire } from 'node:module'
import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { posix } from 'node:path'
import type { DocumentPreviewContent } from '../../src/shared/document-preview'

const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const officeNotice = '内容预览；复杂排版、图表和分页可能与原件不同。'
const maxSpreadsheetPreviewCells = 100_000
const require = createRequire(import.meta.url)

function officeEntries(bytes: Uint8Array, extract: boolean): Record<string, Uint8Array> {
  let total = 0, count = 0
  // Match delivery validation's archive budget before third-party readers expand the ZIP.
  return unzipSync(bytes, { filter: entry => {
    if (++count > 2048 || (total += entry.originalSize) > 64 * 1024 * 1024) throw new Error('文档解压后过大，请复制路径查看原件。')
    return extract && /\.(?:xml|rels|png|jpe?g|webp)$/i.test(entry.name)
  } })
}

async function word(bytes: Uint8Array): Promise<DocumentPreviewContent> {
  officeEntries(bytes, false)
  const mammoth = require('mammoth') as typeof import('mammoth')
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) as unknown as Buffer }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false,
    convertImage: mammoth.images.imgElement(async image => ({ src: imageTypes.has(image.contentType) ? `data:${image.contentType};base64,${await image.readAsBase64String()}` : '' })),
  })
  return { kind: 'html', sections: [{ title: '正文', html: result.value || '<p>没有可预览的正文。</p>' }],
    notices: [officeNotice, ...(result.messages.length ? ['部分内容未能完整呈现，请以原件为准。'] : [])] }
}

async function spreadsheet(bytes: Uint8Array): Promise<DocumentPreviewContent> {
  officeEntries(bytes, false)
  const ExcelJS = require('exceljs') as typeof import('exceljs')
  const book = new ExcelJS.Workbook()
  const workbookBuffer = Buffer.alloc(bytes.byteLength)
  workbookBuffer.set(bytes)
  await book.xlsx.load(workbookBuffer as unknown as Parameters<typeof book.xlsx.load>[0])
  const sections: { title: string; html: string }[] = []
  const notices = [officeNotice]
  let missingFormula = false
  let previewCells = 0
  const sheets = book.worksheets.filter(sheet => sheet.state === 'visible').map(sheet => {
    const columnCount = sheet.columnCount
    // Sparse sheets still produce a rectangular table, so budget before creating empty cells.
    previewCells += sheet.actualRowCount * columnCount
    if (previewCells > maxSpreadsheetPreviewCells) throw new Error('表格预览单元格过多，请复制路径查看原件。')
    return { sheet, columnCount }
  })
  for (const { sheet, columnCount } of sheets) {
    let rows: string[] = []
    let start = 1
    const flush = (end: number) => {
      sections.push({ title: sheet.rowCount > 200 ? `${sheet.name} · ${start}–${end} 行` : sheet.name,
        html: `<table><tbody>${rows.join('')}</tbody></table>` })
      rows = []; start = end + 1
    }
    sheet.eachRow((row, rowNumber) => {
      const cells: string[] = []
      for (let column = 1; column <= columnCount; column++) {
        const cell = row.getCell(column)
        if (cell.isMerged && cell.master.address !== cell.address) { cells.push('<td></td>'); continue }
        let text = cell.text
        if ((cell.type === ExcelJS.ValueType.Formula || cell.formula) && cell.result === undefined) {
          text = '公式结果未缓存'; missingFormula = true
        }
        cells.push(`<td>${escape(text)}</td>`)
      }
      rows.push(`<tr><th>${rowNumber}</th>${cells.join('')}</tr>`)
      if (rows.length === 200) flush(rowNumber)
    })
    if (rows.length) flush(sheet.rowCount)
    if (!sheet.rowCount) sections.push({ title: sheet.name, html: '<p>空工作表</p>' })
  }
  if (missingFormula) notices.push('部分公式没有缓存结果，预览未执行公式重算，也未将其当作零。')
  return { kind: 'html', sections: sections.length ? sections : [{ title: '工作簿', html: '<p>没有可见工作表。</p>' }], notices }
}

type Xml = Record<string, unknown>
const record = (value: unknown): Xml => value && typeof value === 'object' && !Array.isArray(value) ? value as Xml : {}
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: false })
function xml(entries: Record<string, Uint8Array>, name: string): Xml {
  const bytes = entries[name]
  if (!bytes) return {}
  const text = new TextDecoder().decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('此文档包含不支持的 XML 声明。')
  return record(xmlParser.parse(text))
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  return Object.entries(record(value)).filter(([key]) => !key.startsWith('@_')).map(([key, child]) => key === 't' ? textOf(child) : key === 'br' ? '\n' : textOf(child)).join('')
}
function paragraphs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(paragraphs)
  return Object.entries(record(value)).flatMap(([key, child]) => key === 'p' ? list(child).map(textOf).filter(Boolean) : paragraphs(child))
}
function relationships(entries: Record<string, Uint8Array>, name: string): Xml[] {
  return list(record(xml(entries, name).Relationships).Relationship).map(record).filter(item => item['@_TargetMode'] !== 'External')
}
function archiveTarget(base: string, target: unknown): string {
  if (typeof target !== 'string' || target.includes('\\') || /^[a-z]+:/i.test(target)) return ''
  const path = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(base, target))
  return path.startsWith('../') ? '' : path
}
function presentation(bytes: Uint8Array): DocumentPreviewContent {
  const entries = officeEntries(bytes, true)
  const presentation = record(xml(entries, 'ppt/presentation.xml').presentation)
  const rels = relationships(entries, 'ppt/_rels/presentation.xml.rels')
  const sections = list(record(presentation.sldIdLst).sldId).map((id, index) => {
    const relationship = rels.find(rel => rel['@_Id'] === record(id)['@_id'])
    const path = archiveTarget('ppt', relationship?.['@_Target'])
    const content = xml(entries, path)
    const lines = paragraphs(content)
    const imageRels = relationships(entries, posix.join(posix.dirname(path), '_rels', `${posix.basename(path)}.rels`))
    const images = imageRels.filter(rel => typeof rel['@_Type'] === 'string' && rel['@_Type'].endsWith('/image')).flatMap(rel => {
      const target = archiveTarget(posix.dirname(path), rel['@_Target'])
      const data = entries[target]
      const extension = posix.extname(target).slice(1).toLowerCase()
      const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`
      return data && imageTypes.has(mime) ? [`<img alt="" src="data:${mime};base64,${Buffer.from(data).toString('base64')}">`] : []
    })
    const html = [...lines.map(line => `<p>${escape(line)}</p>`), ...images].join('')
    return { title: `第 ${index + 1} 页`, html: html || '<p>本页没有可提取的文本或图片，请查看原件。</p>' }
  })
  if (!sections.length) throw new Error('演示文稿中没有可读取的页面。')
  return { kind: 'html', sections, notices: [officeNotice, '演示文稿按页面展示文字和嵌入图片，不播放动画。'] }
}

export async function convertDocumentPreview(format: string, bytes: Uint8Array): Promise<DocumentPreviewContent> {
  switch (format.toLowerCase()) {
    case 'pdf': return { kind: 'pdf', bytes: new Uint8Array(bytes) }
    case 'docx': return word(bytes)
    case 'xlsx': return spreadsheet(bytes)
    case 'pptx': return presentation(bytes)
    default: {
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { text = new TextDecoder('gb18030').decode(bytes) }
      return { kind: ['md', 'markdown'].includes(format.toLowerCase()) ? 'markdown' : 'text', text }
    }
  }
}
