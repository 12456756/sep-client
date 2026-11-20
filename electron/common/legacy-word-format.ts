export const LEGACY_WORD_MIME = 'application/msword'
const compoundMagic = Buffer.from('d0cf11e0a1b11ae1', 'hex')
const documentEntry = Buffer.from('WordDocument\0', 'utf16le')

export function hasLegacyWordSignature(bytes: Uint8Array): boolean {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.length >= 512 && view.subarray(0, 8).equals(compoundMagic) && view.includes(documentEntry)
}
