import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertSafeId } from './scope-path'
import { resolveUnlinkedChild } from './workspace-result-path'

export const browserAssetFolder = /^(?!con$|prn$|aux$|nul$|com[1-9\u00b9\u00b2\u00b3]$|lpt[1-9\u00b9\u00b2\u00b3]$)[\p{L}\p{N}_-]{1,40}$/iu

export class BrowserAssetStore {
  constructor(private readonly workspace: string, private readonly taskId: string) {
    assertSafeId(taskId, 'taskId')
  }

  private async taskDirectory() {
    const root = await realpath(this.workspace)
    const results = await resolveUnlinkedChild(root, '成果', 'directory')
    return resolveUnlinkedChild(results.path, this.taskId, 'directory')
  }

  async save(folder: string, bytes: Uint8Array, extension: string, signal: AbortSignal): Promise<{ path: string; status: 'saved' | 'already_saved' }> {
    if (!browserAssetFolder.test(folder) || !/^(jpg|png|gif|webp|mp4)$/.test(extension)) throw new Error('Invalid browser asset destination.')
    signal.throwIfAborted()
    const task = await this.taskDirectory()
    await mkdir(join(task.path, folder)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const { path: directory } = await resolveUnlinkedChild(task.path, folder, 'directory')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const name = `${hash}.${extension}`
    const path = ['成果', this.taskId, folder, name].join('/')
    const temp = join(directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      // Publish without overwriting any pre-existing file or following a destination link.
      try { await link(temp, join(directory, name)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await resolveUnlinkedChild(directory, name, 'file')
        if (existing.stat.size !== bytes.byteLength || createHash('sha256').update(await readFile(existing.path, { signal })).digest('hex') !== hash) throw error
        return { path, status: 'already_saved' }
      }
    } finally { await rm(temp, { force: true }) }
    return { path, status: 'saved' }
  }
}
