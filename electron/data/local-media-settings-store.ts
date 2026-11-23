import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'

const settingsSchema = z.object({ version: z.literal(1), path: z.string().refine(isAbsolute).nullable() }).strict()

export class LocalMediaSettingsStore {
  private readonly file: string
  private readonly writes = new WriteChain()

  constructor(userDataDir: string) { this.file = join(userDataDir, 'local-media', 'settings.json') }

  async read(): Promise<string | null> {
    try { return settingsSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).path }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  async write(path: string | null, assertActive: () => void): Promise<void> {
    const settings = settingsSchema.parse({ version: 1, path })
    await this.writes.run(this.file, async () => {
      assertActive()
      await writeJsonAtomic(this.file, settings)
    })
  }
}
