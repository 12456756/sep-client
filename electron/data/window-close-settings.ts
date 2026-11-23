import { join } from 'node:path'
import { z } from 'zod'
import { windowCloseBehavior, type WindowCloseBehavior } from '../../src/shared/window-close'
import { readJsonFile, writeJsonAtomic } from './atomic-file'

const schema = z.strictObject({ version: z.literal(1), behavior: windowCloseBehavior })

export class WindowCloseSettings {
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'window-close.json')
  }

  async read(): Promise<WindowCloseBehavior> {
    const parsed = schema.safeParse(await readJsonFile(this.file))
    return parsed.success ? parsed.data.behavior : 'ask'
  }

  async write(behavior: WindowCloseBehavior): Promise<void> {
    // A damaged preference must ask again, not revive an outdated automatic quit.
    await writeJsonAtomic(this.file, schema.parse({ version: 1, behavior }), { backup: false, durable: true })
  }
}
