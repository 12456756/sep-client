import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { unzipSync, zipSync } from 'fflate'
import { hasLegacyWordSignature } from '../../common/legacy-word-format'

const MAX_BYTES = 32 * 1024 * 1024
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false, parseAttributeValue: false })

function checkedDocx(bytes: Buffer): Uint8Array {
  const seen = new Set<string>()
  let expanded = 0
  const entries = unzipSync(bytes, { filter: ({ name, originalSize }) => {
    const key = name.toLowerCase()
    if (seen.has(key) || seen.size >= 2048 || (expanded += originalSize) > MAX_BYTES
      || !/^([a-z0-9_.-]+\/)*[a-z0-9_.[\]-]+$/i.test(name) || name.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('Invalid DOCX package.')
    }
    seen.add(key)
    if (!/\.(xml|rels)$/i.test(name) && !/^word\/media\/[^/]+\.(png|jpe?g|gif|bmp)$/i.test(name)) {
      throw new Error('Unsupported DOCX package part.')
    }
    return true
  } })
  if (!entries['[Content_Types].xml'] || !entries['_rels/.rels'] || !entries['word/document.xml']) throw new Error('Not a DOCX package.')
  for (const [name, data] of Object.entries(entries)) {
    if (!/\.(xml|rels)$/i.test(name)) continue
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    if (XMLValidator.validate(text) !== true || /<!DOCTYPE|<!ENTITY|<\?(?!xml\s)|<(?:[\w.-]+:)?(?:instrText|fldSimple|altChunk|object|control|mailMerge|subDoc|movie|OLEObject|delInstrText)\b/i.test(text)
      || (name === '[Content_Types].xml' && /macroEnabled|vbaProject|activeX|oleObject/i.test(text))) throw new Error('Unsupported DOCX content.')
    if (!/\.rels$/i.test(name)) continue
    const container = (parser.parse(text) as { Relationships?: unknown }).Relationships
    if (container === undefined) throw new Error('Invalid DOCX relationships.')
    const relationships = (container as { Relationship?: unknown }).Relationship
    for (const item of Array.isArray(relationships) ? relationships as unknown[] : relationships === undefined ? [] : [relationships]) {
      const rel = item as Record<string, unknown> | null
      if (!rel || typeof rel['@_Target'] !== 'string' || !/^\/?[a-z0-9_./-]+$/i.test(rel['@_Target']) || rel['@_Target'].includes('//')
        || (rel['@_TargetMode'] !== undefined && rel['@_TargetMode'] !== 'Internal') || typeof rel['@_Type'] !== 'string'
        || /\/(attachedTemplate|oleObject|package|control|aFChunk|vbaProject|externalLink)$/i.test(rel['@_Type'])) {
        throw new Error('Unsupported DOCX relationship.')
      }
      const parent = posix.dirname(posix.dirname(name))
      const target = rel['@_Target'].startsWith('/') ? rel['@_Target'].slice(1) : posix.join(parent, rel['@_Target'])
      if (!Object.hasOwn(entries, target)) throw new Error('Missing internal DOCX relationship target.')
    }
  }
  // Pass Word a rebuilt archive so it sees the same verified filenames and entry bytes.
  return zipSync(entries, { level: 0 })
}

async function readBounded(path: string): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES) throw new Error('Invalid document size.')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== before.size || (await file.stat()).mtimeMs !== before.mtimeMs) throw new Error('Document changed while reading.')
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

const wordScript = String.raw`
$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
$status = 11
$updateLinks = $null
try {
  $word = New-Object -ComObject Word.Application
  $status = 12
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $updateLinks = $word.Options.UpdateLinksAtOpen
  $word.Options.UpdateLinksAtOpen = $false
  $importing = $env:CSEP_WORD_IMPORT -eq '1'
  if ($importing) { $sourceName = 'input.doc'; $targetName = 'output.docx'; $format = 12 }
  else { $sourceName = 'input.docx'; $targetName = 'output.doc'; $format = 0 }
  $source = [IO.Path]::Combine($PWD.Path, $sourceName)
  $target = [IO.Path]::Combine($PWD.Path, $targetName)
  $document = $word.Documents.Open($source, $false, $true, $false)
  $status = 13
  $document.SaveAs2($target, $format, $false, '', $false)
  $status = 0
} catch {
  # Report only an operation status; errors can include document paths and content.
} finally {
  if ($null -ne $document) { try { $document.Close(0) } catch {} }
  if ($null -ne $word) {
    if ($null -ne $updateLinks) { try { $word.Options.UpdateLinksAtOpen = $updateLinks } catch {} }
    try { $word.Quit(0) } catch {}
  }
}
exit $status
`

function runWord(directory: string, signal?: AbortSignal, importing = false): Promise<void> {
  const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(wordScript, 'utf16le').toString('base64')]
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd: directory, env: { ...process.env, CSEP_WORD_IMPORT: importing ? '1' : '0' }, signal, timeout: 60_000, windowsHide: true, maxBuffer: 16_384 }, error => {
      if (!error) resolve()
      else if (signal?.aborted) reject(new Error('Word conversion cancelled.'))
      else if (error.code === 11 || error.code === 'ENOENT') reject(new Error('DOC conversion requires an installed and usable Microsoft Word on Windows.'))
      else if (error.killed) reject(new Error('Microsoft Word timed out; no converted file was published.'))
      else if (error.code === 12) reject(new Error('Microsoft Word could not open the source document for conversion.'))
      else reject(new Error('Microsoft Word could not convert this document.'))
    })
  })
}

export async function exportLegacyWord(source: string, destination: string, checkDestination: () => void,
  signal?: AbortSignal, convert = runWord): Promise<void> {
  return convertLegacyWord(false, source, destination, checkDestination, signal, convert)
}

export async function importLegacyWord(source: string, destination: string, checkDestination: () => void,
  signal?: AbortSignal, convert = runWord): Promise<void> {
  return convertLegacyWord(true, source, destination, checkDestination, signal, convert)
}

async function convertLegacyWord(importing: boolean, source: string, destination: string, checkDestination: () => void,
  signal: AbortSignal | undefined, convert: typeof runWord): Promise<void> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32' && convert === runWord) throw new Error('DOC conversion is available only on Windows with Microsoft Word.')
  let input: Uint8Array
  try {
    const bytes = await readBounded(source)
    if (importing && (!hasLegacyWordSignature(bytes) || ['Macros', 'VBA', 'ObjectPool'].some(name =>
      bytes.includes(Buffer.from(name + '\0', 'utf16le'))))) throw new Error('Unsupported legacy Word file.')
    input = importing ? bytes : checkedDocx(bytes)
  } catch {
    throw new Error(importing ? 'Use a trusted Word 97–2003 DOC up to 32 MiB without macros or embedded objects.'
      : 'Use a valid DOCX up to 32 MiB without external links, fields, macros or embedded objects.')
  }
  signal?.throwIfAborted()
  const temporary = await mkdtemp(join(tmpdir(), 'csep-word-export-'))
  try {
    const stagedOutput = join(temporary, importing ? 'output.docx' : 'output.doc')
    await writeFile(join(temporary, importing ? 'input.doc' : 'input.docx'), input, { flag: 'wx', mode: 0o600 })
    await convert(temporary, signal, importing)
    const output = await readBounded(stagedOutput)
    if (importing) {
      try { checkedDocx(output) } catch { throw new Error('The Word working copy contains unsupported links, fields or embedded content.') }
    } else if (!hasLegacyWordSignature(output)) {
      throw new Error('Microsoft Word did not produce a Word 97–2003 binary document.')
    }
    signal?.throwIfAborted()
    checkDestination()
    await copyFile(stagedOutput, destination, constants.COPYFILE_EXCL)
  } finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined) }
}
