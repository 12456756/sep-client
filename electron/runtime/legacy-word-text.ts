import { createRequire } from 'node:module'
import { hasLegacyWordSignature } from '../common/legacy-word-format'

const require = createRequire(import.meta.url)
const MAX_BYTES = 32 * 1024 * 1024

export async function readLegacyWordText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_BYTES || !hasLegacyWordSignature(bytes)) throw new Error('Invalid legacy Word document.')
  const WordExtractor = require('word-extractor') as new () => {
    extract(bytes: Buffer): Promise<{ getBody(): string; getHeaders(): string; getFootnotes(): string; getEndnotes(): string }>
  }
  const doc = await new WordExtractor().extract(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  return [doc.getBody(), doc.getHeaders(), doc.getFootnotes(), doc.getEndnotes()].filter(value => value.trim()).join('\n\n')
}
