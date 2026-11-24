import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BoundOriginalFile } from '../domain/attachment-input'

export async function selectedAttachmentOriginal(input: string): Promise<BoundOriginalFile | undefined> {
  try {
    const path = await realpath(input)
    if (path !== resolve(input)) return undefined
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.ino === 0n || info.nlink !== 1n) return undefined
    return { path, identity: `${info.dev}:${info.ino}:${info.birthtimeNs}` }
  } catch { return undefined }
}
