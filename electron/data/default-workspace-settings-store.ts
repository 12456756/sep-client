import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'

const schema = z.object({ version: z.literal(1), path: z.string().nullable() }).strict()

export class DefaultWorkspaceSettingsStore {
  private readonly file: string
  private readonly writes = new WriteChain()

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'workspace', 'settings.json')
  }

  async read(): Promise<string | null> {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(this.file, 'utf8')) as unknown)
      if (!parsed.success || parsed.data.path === null || !isAbsolute(parsed.data.path)) return null
      return parsed.data.path
    } catch { return null }
  }

  async write(path: string | null): Promise<void> {
    if (path !== null && (!path.trim() || !isAbsolute(path))) throw new Error('Default workspace path must be absolute.')
    const value = path === null ? null : path.trim()
    await this.writes.run(this.file, () => writeJsonAtomic(this.file, { version: 1, path: value }))
  }
}
