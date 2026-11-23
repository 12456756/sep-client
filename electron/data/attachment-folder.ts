import type { Stats } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { attachmentImportLimits, type AttachmentFolderPreview } from '../../src/shared/attachment-contracts'
import { attachmentAudioVideoType } from '../../src/shared/attachment-media-formats'

type Candidate = AttachmentFolderPreview['candidates'][number]
type FileIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>
export interface AttachmentFolderEntry {
  path: string
  root: string
  rootIdentity: Pick<Stats, 'dev' | 'ino'>
  identity: FileIdentity
  candidate: Candidate
}

const maxEntries = 1000
const maxCandidates = 100
const images = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const sameObject = (a: Pick<Stats, 'dev' | 'ino'>, b: Pick<Stats, 'dev' | 'ino'>) => a.dev === b.dev && a.ino === b.ino
const comparePath = (path: string) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
const samePath = (a: string, b: string) => comparePath(a) === comparePath(b)

export function sameAttachmentFile(a: FileIdentity, b: FileIdentity): boolean {
  return sameObject(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

async function readFolder(root: string): Promise<Stats> {
  const info = await lstat(root)
  if (!info.isDirectory() || !samePath(root, await realpath(root))) throw new Error('ATTACHMENT_FOLDER_UNAVAILABLE')
  return info
}

export async function scanAttachmentFolder(path: string): Promise<{ folderName: string; entries: AttachmentFolderEntry[]; truncated: boolean }> {
  const root = resolve(path)
  if (root === dirname(root)) throw new Error('ATTACHMENT_FOLDER_UNAVAILABLE')
  const rootIdentity = await readFolder(root).catch(() => { throw new Error('ATTACHMENT_FOLDER_UNAVAILABLE') })
  const entries: AttachmentFolderEntry[] = []
  let scanned = 0
  let truncated = false
  const dir = await opendir(root).catch(() => { throw new Error('ATTACHMENT_FOLDER_UNAVAILABLE') })
  for await (const item of dir) {
    if (++scanned > maxEntries || entries.length >= maxCandidates) { truncated = true; break }
    if (!item.isFile()) continue
    const extension = extname(item.name).toLowerCase()
    const type = attachmentAudioVideoType(extension)
    const kind = images.has(extension) ? 'image' : type?.startsWith('video/') ? 'video' : type ? 'audio' : undefined
    if (!kind) continue
    const file = join(root, item.name)
    const info = await lstat(file).catch(() => undefined)
    if (!info?.isFile() || info.nlink !== 1 || !samePath(file, await realpath(file).catch(() => ''))) continue
    entries.push({ path: file, root, rootIdentity, identity: info, candidate: { id: randomUUID(), name: item.name, byteLength: info.size, kind,
      unavailable: info.size === 0 ? 'empty' : info.size > attachmentImportLimits.maxFileBytes ? 'too-large' : undefined } })
  }
  if (!sameObject(rootIdentity, await readFolder(root))) throw new Error('ATTACHMENT_FOLDER_CHANGED')
  entries.sort((a, b) => a.candidate.name.localeCompare(b.candidate.name, undefined, { numeric: true }))
  return { folderName: basename(root), entries, truncated }
}

export async function assertAttachmentFolderEntry(entry: AttachmentFolderEntry): Promise<void> {
  const matches = await (async () => {
    if (!sameObject(entry.rootIdentity, await readFolder(entry.root))) return false
    const info = await lstat(entry.path)
    return info.isFile() && info.nlink === 1 && sameAttachmentFile(info, entry.identity) && samePath(entry.path, await realpath(entry.path))
  })().catch(() => false)
  if (!matches) throw new Error('ATTACHMENT_FOLDER_CHANGED')
}
